/**
 * Can a statement be PROVEN complete? — one answer, worded one way, for the
 * close-out screen and every PDF alike.
 *
 * Two independent checks (0022 and 0026):
 *   totals_reconciled   our extracted lines == the printed purchases total
 *   balance_consistent  previous + purchases - payments == closing, from the
 *                       statement's own summary box
 * Each is NULL when a figure it needs was never read. NULL means UNKNOWN, and
 * must never be shown as though it had passed.
 */
export type CompletenessInput = {
  totals_reconciled: boolean | null;
  balance_consistent: boolean | null;
};

export type Completeness = {
  verdict: "adds_up" | "does_not_add_up" | "summary_inconsistent" | "not_proven";
  /** Short enough for a table cell or a PDF line. */
  label: string;
  /** True only when the list can be relied on as complete. */
  proven: boolean;
};

export function completenessOf(s: CompletenessInput): Completeness {
  if (s.totals_reconciled === false) {
    return {
      verdict: "does_not_add_up",
      label: "DOES NOT ADD UP — a line was missed or misread",
      proven: false,
    };
  }
  // The line check trusts the printed purchases total. If the statement's own
  // summary does not balance, that total was probably misread, so a "lines add
  // up" result is not evidence of anything.
  if (s.balance_consistent === false) {
    return {
      verdict: "summary_inconsistent",
      label: "Summary figures misread — completeness not proven",
      proven: false,
    };
  }
  if (s.totals_reconciled === true) {
    return {
      verdict: "adds_up",
      label:
        s.balance_consistent === true
          ? "Adds up — lines and balance both check out"
          : "Adds up to the printed purchases total",
      proven: true,
    };
  }
  return {
    verdict: "not_proven",
    label: "Total not read — completeness not proven",
    proven: false,
  };
}
