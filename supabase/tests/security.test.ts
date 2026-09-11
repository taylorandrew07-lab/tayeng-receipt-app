/**
 * Row-level security, against a real Postgres with every migration applied.
 *
 * Covers the six actors the audit named: anonymous, unapproved, approved,
 * admin, super-admin, and a second approved user attempting cross-user access.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { affected, blocked, canRead, freshDb, rejects, visible, type TestDb } from "./harness";

let t: TestDb;
let alice: string; // approved user
let bob: string; // a different approved user
let pending: string; // signed up, not yet approved
let admin: string; // plain admin
let admin2: string; // a second plain admin (a peer)
let boss: string; // super_admin

// Bob's rows — the targets of the cross-user attempts.
let bobReceipt: string;
let bobStatement: string;
let bobTxn: string;
let bobCharge: string;
let bobCard: string;

const A = () => ({ kind: "user" as const, id: alice });
const ANON = { kind: "anon" as const };

beforeAll(async () => {
  t = await freshDb();
  alice = await t.createUser();
  bob = await t.createUser();
  pending = await t.createUser({ approved: false });
  admin = await t.createUser({ role: "admin" });
  admin2 = await t.createUser({ role: "admin" });
  boss = await t.createUser({ role: "super_admin" });

  [{ id: bobCard }] = await t.sql<{ id: string }>(
    "insert into cards (user_id, nickname, last4, card_type) values ($1, 'Bob Visa', '1111', 'company') returning id",
    [bob]
  );
  [{ id: bobReceipt }] = await t.sql<{ id: string }>(
    "insert into receipts (user_id, vendor_name, ttd_amount, status, payment_method) values ($1, 'Bob Shop', 100, 'confirmed', 'company_card') returning id",
    [bob]
  );
  [{ id: bobStatement }] = await t.sql<{ id: string }>(
    "insert into statements (user_id, storage_path, file_name) values ($1, 'x', 'bob.pdf') returning id",
    [bob]
  );
  [{ id: bobTxn }] = await t.sql<{ id: string }>(
    "insert into statement_transactions (user_id, statement_id, txn_date, description, amount) values ($1, $2, '2026-08-01', 'BOB SHOP', 100) returning id",
    [bob, bobStatement]
  );
  [{ id: bobCharge }] = await t.sql<{ id: string }>(
    "select charge_id as id from statement_transactions where id = $1",
    [bobTxn]
  );
}, 60_000);

// ---------------------------------------------------------------------------
describe("the 0016 backup table", () => {
  // 0016 created rsm_backup_pre_0016 with CREATE TABLE AS and never enabled
  // RLS. Supabase's default privileges grant anon SELECT on every new public
  // table, so on any install built from the migrations the public anon key —
  // shipped in every browser — could read every user's match history.
  //
  // PRODUCTION WAS INSPECTED 2026-09-11: RLS is already enabled there
  // out-of-band (service role sees 62 rows, anon sees 0). So this is a
  // MIGRATION DEFECT, not a live exposure.
  beforeAll(async () => {
    await t.sql(
      "insert into rsm_backup_pre_0016 (id, user_id, receipt_id, confirmed, status) values (gen_random_uuid(), $1, $2, true, 'matched')",
      [bob, bobReceipt]
    );
  });

  it("is not readable with the anon key", async () => {
    expect(await canRead(t, ANON, "select * from rsm_backup_pre_0016")).toBe(false);
  });

  it("is not readable by a signed-in user, even for their own rows", async () => {
    expect(await canRead(t, { kind: "user", id: bob }, "select * from rsm_backup_pre_0016")).toBe(false);
  });

  it("is kept — the backup rows still exist for the service role", async () => {
    expect(await visible(t, { kind: "service" }, "select * from rsm_backup_pre_0016")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("anonymous", () => {
  const tables = [
    "profiles", "user_settings", "categories", "cards", "vendors", "receipts",
    "receipt_files", "statements", "statement_transactions", "charges",
    "receipt_statement_matches", "monthly_reports", "learning_rules",
    "charge_reconciliation", "orphan_receipts", "statement_coverage",
  ];
  it.each(tables)("sees nothing in %s", async (table) => {
    expect(await visible(t, ANON, `select * from ${table}`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("an unapproved user", () => {
  const P = () => ({ kind: "user" as const, id: pending });

  it("cannot read their own settings", async () => {
    expect(await visible(t, P(), "select * from user_settings")).toBe(0);
  });

  it("cannot create a receipt", async () => {
    expect(
      await rejects(t, P(), "insert into receipts (user_id, vendor_name) values ($1, 'x')", [pending])
    ).toBe(true);
  });

  // 0015's charges policy was `auth.uid() = user_id` with no is_approved(),
  // unlike every table 0008 locked down.
  it("cannot create a charge", async () => {
    expect(
      await rejects(
        t, P(),
        "insert into charges (user_id, charge_key) values ($1, 'k')",
        [pending]
      )
    ).toBe(true);
  });

  it("cannot approve themselves", async () => {
    expect(
      await blocked(t, P(), "update profiles set approved = true where id = $1", [pending])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("an approved user", () => {
  it("can create and read their own receipt", async () => {
    const n = await t.as(A(), async (tx) => {
      await tx.query("insert into receipts (user_id, vendor_name) values ($1, 'Alice Shop')", [alice]);
      return (await tx.query("select * from receipts")).rows.length;
    });
    expect(n).toBe(1);
  });

  it("cannot make themselves an admin", async () => {
    expect(
      await blocked(t, A(), "update profiles set role = 'admin' where id = $1", [alice])
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("cross-user access", () => {
  it("cannot see another user's receipts", async () => {
    expect(await visible(t, A(), "select * from receipts where user_id = $1", [bob])).toBe(0);
  });

  it("cannot see another user's charges", async () => {
    expect(await visible(t, A(), "select * from charges where user_id = $1", [bob])).toBe(0);
  });

  it("cannot write a row claiming to be another user", async () => {
    expect(
      await rejects(t, A(), "insert into receipts (user_id, vendor_name) values ($1, 'x')", [bob])
    ).toBe(true);
  });

  // The per-row policy only checks the NEW row's user_id. It never checked
  // that the rows it POINTS AT belong to the same user. UUIDs are hard to
  // guess, but ownership must not rest on secrecy — and the confirmed-match
  // unique indexes are GLOBAL, so a foreign confirmed match permanently blocks
  // the real owner from ever confirming their own receipt.
  it("cannot match their receipt-match row to another user's receipt", async () => {
    expect(
      await rejects(
        t, A(),
        "insert into receipt_statement_matches (user_id, receipt_id, confirmed, status) values ($1, $2, true, 'matched')",
        [alice, bobReceipt]
      )
    ).toBe(true);
  });

  it("cannot attach a match to another user's statement line", async () => {
    expect(
      await rejects(
        t, A(),
        "insert into receipt_statement_matches (user_id, statement_transaction_id, status) values ($1, $2, 'needs_review')",
        [alice, bobTxn]
      )
    ).toBe(true);
  });

  it("cannot point a match at another user's charge", async () => {
    expect(
      await rejects(
        t, A(),
        "insert into receipt_statement_matches (user_id, charge_id, status) values ($1, $2, 'needs_review')",
        [alice, bobCharge]
      )
    ).toBe(true);
  });

  it("cannot add a line to another user's statement", async () => {
    expect(
      await rejects(
        t, A(),
        "insert into statement_transactions (user_id, statement_id, amount) values ($1, $2, 5)",
        [alice, bobStatement]
      )
    ).toBe(true);
  });

  it("cannot attach a file to another user's receipt", async () => {
    expect(
      await rejects(
        t, A(),
        "insert into receipt_files (user_id, receipt_id, storage_path, file_name) values ($1, $2, 'p', 'f')",
        [alice, bobReceipt]
      )
    ).toBe(true);
  });

  it("cannot file their receipt against another user's card", async () => {
    expect(
      await rejects(
        t, A(),
        "insert into receipts (user_id, vendor_name, card_id) values ($1, 'x', $2)",
        [alice, bobCard]
      )
    ).toBe(true);
  });

  it("can still do all of that with their OWN rows", async () => {
    await t.as(A(), async (tx) => {
      const [{ id: r }] = (
        await tx.query<{ id: string }>(
          "insert into receipts (user_id, vendor_name, ttd_amount, status) values ($1, 'Mine', 5, 'confirmed') returning id",
          [alice]
        )
      ).rows;
      const [{ id: s }] = (
        await tx.query<{ id: string }>(
          "insert into statements (user_id, storage_path, file_name) values ($1, 'p', 'a.pdf') returning id",
          [alice]
        )
      ).rows;
      const [{ id: tx1 }] = (
        await tx.query<{ id: string }>(
          "insert into statement_transactions (user_id, statement_id, amount) values ($1, $2, 5) returning id",
          [alice, s]
        )
      ).rows;
      await tx.query(
        "insert into receipt_statement_matches (user_id, receipt_id, statement_transaction_id, confirmed, status) values ($1, $2, $3, true, 'matched')",
        [alice, r, tx1]
      );
      await tx.query(
        "insert into receipt_files (user_id, receipt_id, storage_path, file_name) values ($1, $2, 'p', 'f')",
        [alice, r]
      );
    });
  });
});

// ---------------------------------------------------------------------------
describe("the admin hierarchy", () => {
  // lib/admin/actions.ts:47 states the rule: "Only super_admins may change
  // roles, and never their own / a super_admin's." 0012's header says the same
  // — "Only a super_admin can manage other admins." But 0012's RLS let a plain
  // admin set ANY non-super user to 'user' or 'admin', so a plain admin calling
  // the API directly with their own session could promote anyone, or demote
  // and un-approve their peers. The database was looser than the app.
  const ADMIN = () => ({ kind: "user" as const, id: admin });
  const BOSS = () => ({ kind: "user" as const, id: boss });

  it("a plain admin CAN approve a pending user", async () => {
    expect(
      await affected(t, ADMIN(), "update profiles set approved = true where id = $1", [pending])
    ).toBe(1);
  });

  it("a plain admin cannot promote a user to admin", async () => {
    expect(
      await blocked(t, ADMIN(), "update profiles set role = 'admin' where id = $1", [alice])
    ).toBe(true);
  });

  it("a plain admin cannot demote a peer admin", async () => {
    expect(
      await blocked(t, ADMIN(), "update profiles set role = 'user' where id = $1", [admin2])
    ).toBe(true);
  });

  it("a plain admin cannot un-approve a peer admin", async () => {
    expect(
      await blocked(t, ADMIN(), "update profiles set approved = false where id = $1", [admin2])
    ).toBe(true);
  });

  it("a plain admin cannot touch the super admin", async () => {
    expect(
      await blocked(t, ADMIN(), "update profiles set approved = false where id = $1", [boss])
    ).toBe(true);
  });

  it("the super admin CAN promote a user to admin", async () => {
    expect(
      await affected(t, BOSS(), "update profiles set role = 'admin' where id = $1", [alice])
    ).toBe(1);
  });

  it("the super admin CAN demote an admin", async () => {
    expect(
      await affected(t, BOSS(), "update profiles set role = 'user' where id = $1", [admin2])
    ).toBe(1);
  });

  it("nobody can grant super_admin through the API", async () => {
    expect(
      await blocked(t, BOSS(), "update profiles set role = 'super_admin' where id = $1", [alice])
    ).toBe(true);
  });

  it("an admin cannot change their own role through the admin policy", async () => {
    expect(
      await blocked(t, ADMIN(), "update profiles set role = 'super_admin' where id = $1", [admin])
    ).toBe(true);
  });
});
