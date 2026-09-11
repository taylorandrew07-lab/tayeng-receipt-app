/**
 * Money and completeness in the database: the 0026 balance check, and paging
 * past PostgREST's 1000-row cap against a REAL Postgres.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "./harness";
import { fetchAll } from "@/lib/reconciliation/paginate";

let t: TestDb;
let u: string;

beforeAll(async () => {
  t = await freshDb();
  u = await t.createUser();
}, 60_000);

async function statement(fields: Record<string, unknown>) {
  const cols = ["user_id", "storage_path", "file_name", ...Object.keys(fields)];
  const vals = [u, "p", "s.pdf", ...Object.values(fields)];
  const [{ id }] = await t.sql<{ id: string }>(
    `insert into statements (${cols.join(", ")})
     values (${vals.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
    vals
  );
  return id;
}

const coverage = async (id: string) =>
  (
    await t.sql<{
      totals_reconciled: boolean | null;
      balance_consistent: boolean | null;
      balance_difference: string | null;
      period_read: boolean;
      currencies: string[];
    }>("select * from statement_coverage where id = $1", [id])
  )[0];

describe("statement_coverage — two independent completeness checks (0026)", () => {
  it("a statement whose summary balances and whose lines add up passes both", async () => {
    const id = await statement({
      period_start: "2026-07-14",
      period_end: "2026-08-17",
      previous_balance: 1000,
      total_purchases: 150,
      total_payments: 400,
      closing_balance: 750,
    });
    await t.sql(
      "insert into statement_transactions (user_id, statement_id, txn_date, description, amount) values ($1,$2,'2026-08-01','A',100), ($1,$2,'2026-08-02','B',50)",
      [u, id]
    );
    const c = await coverage(id);
    expect(c.totals_reconciled).toBe(true);
    expect(c.balance_consistent).toBe(true);
    expect(c.period_read).toBe(true);
  });

  // Conflicting control totals: the lines "match" a purchases figure that the
  // statement's own arithmetic proves was misread.
  it("flags a summary that does not balance, even when the lines match it", async () => {
    const id = await statement({
      previous_balance: 1000,
      total_purchases: 150,
      total_payments: 400,
      closing_balance: 800, // should be 750
    });
    await t.sql(
      "insert into statement_transactions (user_id, statement_id, amount) values ($1,$2,150)",
      [u, id]
    );
    const c = await coverage(id);
    expect(c.totals_reconciled).toBe(true);
    expect(c.balance_consistent).toBe(false);
    expect(Number(c.balance_difference)).toBe(-50);
  });

  it("reports UNKNOWN, not passed, when the figures were never read", async () => {
    const id = await statement({});
    const c = await coverage(id);
    expect(c.totals_reconciled).toBeNull();
    expect(c.balance_consistent).toBeNull();
    expect(c.period_read).toBe(false);
  });

  it("lists every currency a statement's lines are in", async () => {
    const id = await statement({});
    await t.sql(
      "insert into statement_transactions (user_id, statement_id, amount, currency) values ($1,$2,1,'TTD'), ($1,$2,2,'USD')",
      [u, id]
    );
    expect((await coverage(id)).currencies.sort()).toEqual(["TTD", "USD"]);
  });
});

describe("paging past 1,000 rows, against real Postgres", () => {
  const PAGE_CAP = 1000; // PostgREST's default max-rows

  /** A PostgREST-like page: ORDER BY + LIMIT/OFFSET, capped at PAGE_CAP. */
  const page = (orderBy: string) => (from: number, to: number) =>
    t.db
      .query<{ id: string }>(
        `select id from statement_transactions where user_id = $1 order by ${orderBy} limit $2 offset $3`,
        [u, Math.min(to - from + 1, PAGE_CAP), from]
      )
      .then((r) => ({ data: r.rows, error: null }));

  beforeAll(async () => {
    const id = await statement({});
    // 2,500 lines: well past the cap, and deliberately many sharing one date,
    // so an ORDER BY on the date alone is NOT a total order.
    await t.sql(
      `insert into statement_transactions (user_id, statement_id, txn_date, amount)
       select $1, $2, date '2026-08-01' + (g % 3), g from generate_series(1, 2500) g`,
      [u, id]
    );
  });

  it("reads every row exactly once with a total order (id tiebreak)", async () => {
    const [{ n }] = await t.sql<{ n: string }>(
      "select count(*) n from statement_transactions where user_id = $1",
      [u]
    );
    const rows = await fetchAll(page("txn_date, id"));
    expect(rows).toHaveLength(Number(n));
    expect(new Set(rows.map((r) => r.id)).size).toBe(Number(n));
  });

  it("an unpaged read silently stops at the cap — the failure fetchAll exists to prevent", async () => {
    const r = await page("id")(0, 1_000_000);
    expect(r.data).toHaveLength(PAGE_CAP);
  });
});
