import { describe, expect, it } from "vitest";
import { freshDb } from "./harness";

describe("migrations", () => {
  it("every migration applies, in order, to an empty database", async () => {
    const t = await freshDb();
    const views = await t.sql<{ table_name: string }>(
      "select table_name from information_schema.views where table_schema = 'public' order by 1"
    );
    expect(views.map((v) => v.table_name)).toEqual([
      "charge_reconciliation",
      "orphan_receipts",
      "reconciliation_months",
      "statement_coverage",
    ]);
  }, 60_000);
});
