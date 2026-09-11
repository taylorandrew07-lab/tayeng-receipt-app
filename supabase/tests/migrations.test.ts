import { describe, expect, it } from "vitest";
import { applyMigrations, freshDb } from "./harness";

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

  // The deployment plan relies on this. CI records applied versions and skips
  // them, but 0020 was applied to production BY HAND and may not be recorded,
  // so CI may run it again. Every migration from 0020 on must therefore be
  // safe to apply twice.
  it("every migration from 0020 onward is safe to apply a second time", async () => {
    const t = await freshDb();
    const again = await applyMigrations(t.db, { after: "0019" });
    expect(again[0]).toMatch(/^0020_/);
    expect(again.length).toBeGreaterThanOrEqual(8);
  }, 60_000);
});
