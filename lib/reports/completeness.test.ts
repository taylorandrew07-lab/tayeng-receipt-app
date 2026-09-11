import { describe, expect, it } from "vitest";
import { completenessOf } from "./completeness";

describe("completenessOf — unknown is never shown as passed", () => {
  it.each([
    [{ totals_reconciled: true, balance_consistent: true }, "adds_up", true],
    [{ totals_reconciled: true, balance_consistent: null }, "adds_up", true],
    [{ totals_reconciled: false, balance_consistent: true }, "does_not_add_up", false],
    [{ totals_reconciled: false, balance_consistent: false }, "does_not_add_up", false],
    // Lines match a printed total that the statement's own arithmetic says was
    // misread: that match proves nothing.
    [{ totals_reconciled: true, balance_consistent: false }, "summary_inconsistent", false],
    [{ totals_reconciled: null, balance_consistent: null }, "not_proven", false],
    [{ totals_reconciled: null, balance_consistent: true }, "not_proven", false],
  ] as const)("%o → %s", (input, verdict, proven) => {
    const c = completenessOf(input);
    expect(c.verdict).toBe(verdict);
    expect(c.proven).toBe(proven);
  });
});
