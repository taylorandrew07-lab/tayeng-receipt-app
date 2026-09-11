/**
 * The reconciliation read model, against a real Postgres: charge identity
 * across overlapping statements, the five charge states, rejection, closing
 * and reopening, and the one-receipt-per-charge / one-charge-per-receipt
 * invariants.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "./harness";

let t: TestDb;
let u: string;

const one = async <T,>(q: string, p: unknown[] = []) => (await t.sql<T>(q, p))[0];

async function statement(name: string) {
  return (
    await one<{ id: string }>(
      "insert into statements (user_id, storage_path, file_name) values ($1, 'p', $2) returning id",
      [u, name]
    )
  ).id;
}

async function line(stmt: string, date: string, desc: string, amount: number) {
  return one<{ id: string; charge_id: string }>(
    "insert into statement_transactions (user_id, statement_id, txn_date, description, amount) values ($1, $2, $3, $4, $5) returning id, charge_id",
    [u, stmt, date, desc, amount]
  );
}

async function receipt(over: Record<string, unknown> = {}) {
  const r = {
    vendor_name: "Amazon",
    ttd_amount: 648.14,
    receipt_date: "2026-07-15",
    status: "confirmed",
    payment_method: "company_card",
    ...over,
  };
  return (
    await one<{ id: string }>(
      "insert into receipts (user_id, vendor_name, ttd_amount, receipt_date, status, payment_method) values ($1, $2, $3, $4, $5, $6) returning id",
      [u, r.vendor_name, r.ttd_amount, r.receipt_date, r.status, r.payment_method]
    )
  ).id;
}

async function match(receiptId: string, txnId: string, confirmed: boolean) {
  return (
    await one<{ id: string }>(
      "insert into receipt_statement_matches (user_id, receipt_id, statement_transaction_id, confirmed, status) values ($1, $2, $3, $4, $5) returning id",
      [u, receiptId, txnId, confirmed, confirmed ? "matched" : "possible_match"]
    )
  ).id;
}

const stateOf = async (chargeId: string) =>
  (await one<{ state: string }>(
    "select state from charge_reconciliation where charge_id = $1",
    [chargeId]
  )).state;

beforeEach(async () => {
  t = await freshDb();
  u = await t.createUser();
}, 60_000);

describe("overlapping statements", () => {
  it("the same charge on two statements is ONE charge, counted once", async () => {
    const s1 = await statement("June.pdf");
    const s2 = await statement("July.pdf");
    const a = await line(s1, "2026-07-15", "AMAZON MKTPL*3A0EU8Q23", 648.14);
    const b = await line(s2, "2026-07-16", "AMAZON MKTPL*3A0EU8Q23", 648.14); // posts a day later

    expect(a.charge_id).toBe(b.charge_id);
    const rows = await t.sql<{ copies: number; amount: string }>(
      "select copies, amount from charge_reconciliation"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].copies).toBe(2);
    expect(Number(rows[0].amount)).toBe(648.14);
  });

  it("a genuine repeat purchase on the SAME statement stays two charges", async () => {
    const s1 = await statement("June.pdf");
    const a = await line(s1, "2026-07-15", "STAR PETROL", 250);
    const b = await line(s1, "2026-07-16", "STAR PETROL", 250);
    expect(a.charge_id).not.toBe(b.charge_id);
  });

  it("a receipt matched on one copy covers the charge on every statement", async () => {
    const s1 = await statement("June.pdf");
    const s2 = await statement("July.pdf");
    const a = await line(s1, "2026-07-15", "AMAZON", 648.14);
    await line(s2, "2026-07-15", "AMAZON", 648.14);
    await match(await receipt(), a.id, true);

    expect(await stateOf(a.charge_id)).toBe("already_matched");
    expect(Number((await one<{ n: string }>("select count(*) n from charge_reconciliation")).n)).toBe(1);
  });
});

describe("invariants", () => {
  it("one confirmed receipt per charge — even arriving via the other copy", async () => {
    const s1 = await statement("June.pdf");
    const s2 = await statement("July.pdf");
    const a = await line(s1, "2026-07-15", "AMAZON", 648.14);
    const b = await line(s2, "2026-07-15", "AMAZON", 648.14);
    await match(await receipt(), a.id, true);
    await expect(match(await receipt({ vendor_name: "Other" }), b.id, true)).rejects.toThrow(
      /rsm_unique_confirmed_charge/
    );
  });

  it("one confirmed charge per receipt", async () => {
    const s1 = await statement("June.pdf");
    const a = await line(s1, "2026-07-15", "AMAZON", 648.14);
    const c = await line(s1, "2026-07-20", "STAR PETROL", 250);
    const r = await receipt();
    await match(r, a.id, true);
    await expect(match(r, c.id, true)).rejects.toThrow(/rsm_unique_confirmed_receipt/);
  });
});

describe("rejection", () => {
  it("a rejected suggestion puts the charge back on the work list and frees the receipt", async () => {
    const s1 = await statement("June.pdf");
    const a = await line(s1, "2026-07-15", "AMAZON", 648.14);
    const r = await receipt();
    const m = await match(r, a.id, false);
    expect(await stateOf(a.charge_id)).toBe("needs_confirmation");

    // What rejectMatch does.
    await t.sql(
      "update receipt_statement_matches set confirmed = false, status = 'needs_review', rejected_at = now() where id = $1",
      [m]
    );

    expect(await stateOf(a.charge_id)).toBe("genuinely_new");
    const orphan = await one<{ pending_count: number }>(
      "select pending_count from orphan_receipts where receipt_id = $1",
      [r]
    );
    expect(orphan.pending_count).toBe(0);
  });

  it("unmatching a CONFIRMED receipt also returns both sides", async () => {
    const s1 = await statement("June.pdf");
    const a = await line(s1, "2026-07-15", "AMAZON", 648.14);
    const r = await receipt();
    const m = await match(r, a.id, true);
    await t.sql(
      "update receipt_statement_matches set confirmed = false, rejected_at = now() where id = $1",
      [m]
    );
    expect(await stateOf(a.charge_id)).toBe("genuinely_new");
    expect(await t.sql("select 1 from orphan_receipts where receipt_id = $1", [r])).toHaveLength(1);
    // And the per-line flag the old screens read is kept honest by 0016's trigger.
    expect(
      (await one<{ is_matched: boolean }>(
        "select is_matched from statement_transactions where id = $1",
        [a.id]
      )).is_matched
    ).toBe(false);
  });
});

describe("closing and reopening", () => {
  it("bank noise is closed automatically; a real purchase is not", async () => {
    const s1 = await statement("June.pdf");
    const fee = await line(s1, "2026-08-04", "LATE PAYMENT FEE", 50);
    const pin = await line(s1, "2026-08-04", "PINTEREST ADS", 50);
    expect(await stateOf(fee.charge_id)).toBe("no_receipt_expected");
    expect(await stateOf(pin.charge_id)).toBe("genuinely_new");
  });

  it("a reopened charge returns to the work list, and the reopen is recorded", async () => {
    const s1 = await statement("June.pdf");
    const fee = await line(s1, "2026-08-04", "OVERLIMIT FEE", 45);
    // What setChargeClosed(close = false) does.
    await t.sql(
      "update charges set no_receipt_expected = false, fee_auto_flagged = false, reopened_at = now() where id = $1",
      [fee.charge_id]
    );
    expect(await stateOf(fee.charge_id)).toBe("genuinely_new");
    expect(
      (await one<{ reopened_at: string | null }>("select reopened_at from charges where id = $1", [
        fee.charge_id,
      ])).reopened_at
    ).not.toBeNull();
  });
});

describe("receipts expected on a statement (0021)", () => {
  it.each([
    ["company_card", true],
    ["unknown", true],
    ["online", true],
    ["other", true],
    ["cash", false],
    ["personal_card", false],
  ])("a %s receipt → expected_on_statement = %s", async (pm, expected) => {
    const r = await receipt({ payment_method: pm });
    // classify.ts derives reimbursable = (payment_method <> company_card); set
    // it that way, because that derived value is what 0019 wrongly keyed on.
    await t.sql("update receipts set reimbursable = ($2 <> 'company_card') where id = $1", [r, pm]);
    const row = await one<{ expected_on_statement: boolean }>(
      "select expected_on_statement from orphan_receipts where receipt_id = $1",
      [r]
    );
    expect(row.expected_on_statement).toBe(expected);
  });
});
