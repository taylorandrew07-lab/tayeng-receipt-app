/**
 * replace_statement_lines (0025): re-parsing a statement is one transaction.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "./harness";

let t: TestDb;
let u: string;
let stmt: string;

const line = (d: string, desc: string, amount: number, extra: Record<string, unknown> = {}) => ({
  txn_date: d,
  description: desc,
  amount,
  currency: "TTD",
  card_last4: null,
  ...extra,
});

async function replace(
  lines: unknown[],
  header: Record<string, unknown> = {},
  who: string = u,
  statementId: string = stmt
) {
  return t.as({ kind: "user", id: who }, async (tx) => {
    const r = await tx.query<{ out: { replaced: boolean; count: number; line_total: string } }>(
      "select public.replace_statement_lines($1, $2::jsonb, $3::jsonb, 0) as out",
      [statementId, JSON.stringify(lines), JSON.stringify(header)]
    );
    // Rolled back by as(): used only where the call is expected to be refused.
    return r.rows[0].out;
  });
}

/** Run as the user and KEEP the result (as() always rolls back). */
async function replaceAndKeep(lines: unknown[], header: Record<string, unknown> = {}) {
  await t.db.exec("begin");
  await t.db.exec("set local role authenticated");
  await t.db.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: u, role: "authenticated" }),
  ]);
  try {
    const r = await t.db.query<{ out: { replaced: boolean; count: number } }>(
      "select public.replace_statement_lines($1, $2::jsonb, $3::jsonb, 0) as out",
      [stmt, JSON.stringify(lines), JSON.stringify(header)]
    );
    await t.db.exec("commit");
    return r.rows[0].out;
  } catch (e) {
    await t.db.exec("rollback");
    throw e;
  }
}

const lines = async () =>
  t.sql<{ description: string; amount: string; charge_id: string }>(
    "select description, amount, charge_id from statement_transactions where statement_id = $1 order by description",
    [stmt]
  );

beforeEach(async () => {
  t = await freshDb();
  u = await t.createUser();
  stmt = (
    await t.sql<{ id: string }>(
      "insert into statements (user_id, storage_path, file_name, period_start, period_end) values ($1, 'p', 's.pdf', '2026-07-14', '2026-08-17') returning id",
      [u]
    )
  )[0].id;
}, 60_000);

describe("replace_statement_lines", () => {
  it("replaces the lines and stamps the extracted total", async () => {
    const out = await replaceAndKeep([line("2026-08-01", "AMAZON", 100), line("2026-08-02", "BP", 50)]);
    expect(out).toMatchObject({ replaced: true, count: 2 });
    expect(await lines()).toHaveLength(2);
    const [s] = await t.sql<{ parsed_line_total: string }>(
      "select parsed_line_total from statements where id = $1",
      [stmt]
    );
    expect(Number(s.parsed_line_total)).toBe(150);
  });

  // THE failed-re-parse case. One bad row mid-insert used to leave the
  // statement with no lines at all, because the delete had already happened
  // in a separate request.
  it("rolls EVERYTHING back when one line fails — existing lines survive", async () => {
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100)]);
    await expect(
      replaceAndKeep(
        [line("2026-08-01", "NEW ONE", 1), line("2026-08-02", "BAD", 2, { card_last4: "12" })],
        { period_start: "2026-01-01" }
      )
    ).rejects.toThrow(/card_last4/);

    expect((await lines()).map((l) => l.description)).toEqual(["AMAZON"]);
    const [s] = await t.sql<{ period_start: string }>(
      "select period_start::text from statements where id = $1",
      [stmt]
    );
    expect(s.period_start).toBe("2026-07-14"); // the header change rolled back too
  });

  it("keeps a period it did not read (missing header keys change nothing)", async () => {
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100)], { total_purchases: 100 });
    const [s] = await t.sql<{ period_start: string; total_purchases: string }>(
      "select period_start::text, total_purchases from statements where id = $1",
      [stmt]
    );
    expect(s.period_start).toBe("2026-07-14");
    expect(Number(s.total_purchases)).toBe(100);
  });

  it("running twice never duplicates lines, and reuses the same charges", async () => {
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100), line("2026-08-02", "BP", 50)]);
    const first = (await lines()).map((l) => l.charge_id).sort();
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100), line("2026-08-02", "BP", 50)]);
    const second = await lines();
    expect(second).toHaveLength(2);
    // Decisions live on the CHARGE, so they survive a re-parse.
    expect(second.map((l) => l.charge_id).sort()).toEqual(first);
    expect(
      Number((await t.sql<{ n: string }>("select count(*) n from charges"))[0].n)
    ).toBe(2);
  });

  it("a closed charge stays closed across a re-parse", async () => {
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100)]);
    const [{ charge_id }] = await lines();
    await t.sql(
      "update charges set no_receipt_expected = true, closed_by_user_at = now() where id = $1",
      [charge_id]
    );
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100)]);
    const [{ charge_id: again }] = await lines();
    expect(again).toBe(charge_id);
    const [c] = await t.sql<{ no_receipt_expected: boolean }>(
      "select no_receipt_expected from charges where id = $1",
      [charge_id]
    );
    expect(c.no_receipt_expected).toBe(true);
  });

  it("keeps the lines when any has a confirmed receipt, but still takes the totals", async () => {
    await replaceAndKeep([line("2026-08-01", "AMAZON", 100)]);
    const [{ id: txn }] = await t.sql<{ id: string }>(
      "select id from statement_transactions where statement_id = $1",
      [stmt]
    );
    const [{ id: r }] = await t.sql<{ id: string }>(
      "insert into receipts (user_id, vendor_name, ttd_amount, status) values ($1, 'Amazon', 100, 'confirmed') returning id",
      [u]
    );
    await t.sql(
      "insert into receipt_statement_matches (user_id, receipt_id, statement_transaction_id, confirmed, status) values ($1, $2, $3, true, 'matched')",
      [u, r, txn]
    );

    const out = await replaceAndKeep([line("2026-08-09", "SOMETHING ELSE", 7)], {
      total_purchases: 100,
    });
    expect(out).toMatchObject({ replaced: false });
    expect((await lines()).map((l) => l.description)).toEqual(["AMAZON"]);
    const [s] = await t.sql<{ total_purchases: string }>(
      "select total_purchases from statements where id = $1",
      [stmt]
    );
    expect(Number(s.total_purchases)).toBe(100);
  });

  it("another user cannot replace my statement's lines", async () => {
    const mallory = await t.createUser();
    await expect(replace([line("2026-08-01", "X", 1)], {}, mallory)).rejects.toThrow(/not found/);
  });

  it("an anonymous caller cannot run it at all", async () => {
    await expect(
      t.as({ kind: "anon" }, (tx) =>
        tx.query("select public.replace_statement_lines($1, '[]'::jsonb, '{}'::jsonb, 0)", [stmt])
      )
    ).rejects.toThrow(/permission denied/);
  });
});
