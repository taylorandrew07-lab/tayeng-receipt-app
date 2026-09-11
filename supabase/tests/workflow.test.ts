/**
 * The main workflow, end to end, on an isolated database:
 *
 *   upload statement → upload receipt → review → match → confirm
 *   → (attach by mistake → undo) → close a charge by hand
 *   → report data → record sent → nothing outstanding
 *
 * Every step writes exactly what the app's own code writes (as the signed-in
 * user, through RLS and every trigger), then asserts the close-out state the
 * screen would show. The open/closed counts use the same universe as
 * lib/reconciliation/board-data.ts: every charge, plus every receipt expected
 * on a statement; reimbursables belong to neither side.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "./harness";

let t: TestDb;
let u: string;
let stmt: string;
let receipt: string;

/** Run as the signed-in user and KEEP the result. */
async function asUser<T = Record<string, unknown>>(query: string, params: unknown[] = []) {
  await t.db.exec("begin");
  await t.db.exec("set local role authenticated");
  await t.db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: u, role: "authenticated" }),
  ]);
  try {
    const r = await t.db.query<T>(query, params);
    await t.db.exec("commit");
    return r.rows;
  } catch (e) {
    await t.db.exec("rollback");
    throw e;
  }
}

/** What the close-out screen counts. */
async function board() {
  const charges = await t.sql<{ state: string; fee_auto_flagged: boolean }>(
    "select state, fee_auto_flagged from charge_reconciliation where user_id = $1",
    [u]
  );
  const orphans = await t.sql<{ sent: boolean; expected_on_statement: boolean }>(
    "select sent, expected_on_statement from orphan_receipts where user_id = $1",
    [u]
  );
  const on = orphans.filter((o) => o.expected_on_statement);
  const open =
    charges.filter((c) => c.state === "genuinely_new" || c.state === "needs_confirmation").length +
    on.filter((o) => !o.sent).length;
  const total = charges.length + on.length;
  return { open, closed: total - open, total, states: charges.map((c) => c.state).sort() };
}

const chargeOf = async (desc: string) =>
  (
    await t.sql<{ charge_id: string; id: string }>(
      "select charge_id, id from statement_transactions where description = $1",
      [desc]
    )
  )[0];

beforeAll(async () => {
  t = await freshDb();
  u = await t.createUser();
}, 60_000);

describe("the main workflow, upload to completion", () => {
  it("1. uploading and reading a statement puts its charges on the list; the fee is closed automatically", async () => {
    [{ id: stmt }] = await asUser<{ id: string }>(
      "insert into statements (user_id, storage_path, file_name) values ($1, 'p', 'aug.pdf') returning id",
      [u]
    );
    // Exactly what app/api/statements/parse/route.ts calls.
    await asUser(
      "select public.replace_statement_lines($1, $2::jsonb, $3::jsonb, 1)",
      [
        stmt,
        JSON.stringify([
          { txn_date: "2026-08-03", description: "AMAZON MKTPL", amount: 648.14, currency: "TTD" },
          { txn_date: "2026-08-05", description: "STAR PETROL", amount: 250, currency: "TTD" },
          { txn_date: "2026-08-17", description: "OVERLIMIT FEE", amount: 45, currency: "TTD" },
        ]),
        JSON.stringify({
          period_start: "2026-07-18",
          period_end: "2026-08-17",
          previous_balance: 1000,
          total_purchases: 943.14,
          total_payments: 500,
          closing_balance: 1443.14,
        }),
      ]
    );

    const s = (
      await t.sql<{ totals_reconciled: boolean; balance_consistent: boolean }>(
        "select totals_reconciled, balance_consistent from statement_coverage where id = $1",
        [stmt]
      )
    )[0];
    expect(s).toEqual({ totals_reconciled: true, balance_consistent: true });
    expect(await board()).toMatchObject({
      open: 2,
      states: ["genuinely_new", "genuinely_new", "no_receipt_expected"],
    });
  });

  it("2. an uploaded receipt is NOT counted until it has been reviewed", async () => {
    [{ id: receipt }] = await asUser<{ id: string }>(
      "insert into receipts (user_id, vendor_name, ttd_amount, amount, currency, receipt_date, status, payment_method, reimbursable) values ($1, 'Amazon.com', 648.14, 648.14, 'TTD', '2026-08-02', 'processing', 'company_card', false) returning id",
      [u]
    );
    expect((await board()).open).toBe(2);

    // Review: what saveReceipt writes.
    await asUser("update receipts set status = 'confirmed' where id = $1", [receipt]);
    expect((await board()).open).toBe(3); // the receipt is now work: it has no charge yet
  });

  it("3. a suggested match shows as needing confirmation", async () => {
    const amazon = await chargeOf("AMAZON MKTPL");
    await asUser(
      "insert into receipt_statement_matches (user_id, receipt_id, statement_transaction_id, status, confidence, confirmed) values ($1, $2, $3, 'possible_match', 82, false)",
      [u, receipt, amazon.id]
    );
    expect((await board()).states).toContain("needs_confirmation");
  });

  it("4. confirming closes BOTH the charge and the receipt", async () => {
    const amazon = await chargeOf("AMAZON MKTPL");
    await asUser(
      "update receipt_statement_matches set confirmed = true, status = 'matched' where receipt_id = $1 and charge_id = $2",
      [receipt, amazon.charge_id]
    );
    const b = await board();
    expect(b.states).toContain("already_matched");
    expect(b.open).toBe(1); // only the petrol charge is left
  });

  it("5. a mistaken manual attach can be undone, restoring the list exactly", async () => {
    const [{ id: wrong }] = await asUser<{ id: string }>(
      "insert into receipts (user_id, vendor_name, ttd_amount, amount, currency, receipt_date, status, payment_method, reimbursable) values ($1, 'Wrong Shop', 250, 250, 'TTD', '2026-08-05', 'confirmed', 'company_card', false) returning id",
      [u]
    );
    const before = await board();
    const petrol = await chargeOf("STAR PETROL");
    // attachReceiptToCharge on a brand-new pair (prior = null)...
    const [{ id: matchId }] = await asUser<{ id: string }>(
      "insert into receipt_statement_matches (user_id, receipt_id, statement_transaction_id, charge_id, status, confidence, confirmed) values ($1, $2, $3, $4, 'matched', 100, true) returning id",
      [u, wrong, petrol.id, petrol.charge_id]
    );
    expect((await board()).open).toBe(before.open - 2);
    // ...and undoAttach(matchId, null) deletes it.
    await asUser("delete from receipt_statement_matches where id = $1", [matchId]);
    expect(await board()).toEqual(before);
    await asUser("delete from receipts where id = $1", [wrong]);
  });

  it("6. closing a charge by hand files it as a PERSONAL decision, not a bank fee", async () => {
    const petrol = await chargeOf("STAR PETROL");
    // What setChargeClosed(close = true) writes.
    await asUser(
      "update charges set no_receipt_expected = true, fee_auto_flagged = false, closed_by_user_at = now() where id = $1",
      [petrol.charge_id]
    );
    const c = await t.sql<{ fee_auto_flagged: boolean; state: string }>(
      "select fee_auto_flagged, state from charge_reconciliation where charge_id = $1",
      [petrol.charge_id]
    );
    // board-data files fee_auto_flagged = false under "Closed off by you" — kept
    // out of the accountant's PDF — never under "Bank charges".
    expect(c[0]).toEqual({ fee_auto_flagged: false, state: "no_receipt_expected" });
  });

  it("7. the report's receipt is the one matched to the charge", async () => {
    const rows = await t.sql<{ receipt_id: string; state: string }>(
      "select receipt_id, state from charge_reconciliation where receipt_id is not null"
    );
    expect(rows).toEqual([{ receipt_id: receipt, state: "already_matched" }]);
  });

  it("8. recording it as sent completes the close-out: nothing outstanding, bar at 100%", async () => {
    // What setReceiptsSent writes.
    await asUser("update receipts set sent = true, sent_at = now() where id = $1", [receipt]);
    const b = await board();
    expect(b.states).toEqual(["already_sent", "no_receipt_expected", "no_receipt_expected"]);
    expect(b.open).toBe(0);
    expect(b.closed).toBe(b.total);
  });
});

describe("0027 content hash", () => {
  it("accepts a real SHA-256 and refuses anything else", async () => {
    const [{ id: r }] = await t.sql<{ id: string }>(
      "insert into receipts (user_id, vendor_name) values ($1, 'x') returning id",
      [u]
    );
    await t.sql(
      "insert into receipt_files (user_id, receipt_id, storage_path, file_name, content_sha256) values ($1, $2, 'p', 'f', $3)",
      [u, r, "c".repeat(64)]
    );
    await expect(
      t.sql(
        "insert into receipt_files (user_id, receipt_id, storage_path, file_name, content_sha256) values ($1, $2, 'p', 'f', 'invoice.pdf')",
        [u, r]
      )
    ).rejects.toThrow(/content_sha256/);
  });
});
