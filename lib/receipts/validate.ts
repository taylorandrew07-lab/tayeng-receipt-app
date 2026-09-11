/**
 * The money on a receipt must be sound before it can be CONFIRMED.
 *
 * saveReceipt marks a receipt confirmed on every save, and a confirmed receipt
 * feeds matching, the close-out list and every report. Previously it accepted
 * whatever the form sent, so a receipt could be confirmed with:
 *   - no TTD amount — invisible to matching, and counted as 0 in every total;
 *   - a negative or zero amount;
 *   - currency TTD but a "TTD amount" different from its own amount, so the
 *     report's two columns disagreed about the same purchase;
 *   - tax larger than the whole receipt, or a date in 2099.
 *
 * Pure: no I/O, so each rule is unit-tested.
 */

export type ReceiptMoneyInput = {
  currency: string;
  amount: number | null;
  ttd_amount: number | null;
  tax_amount: number | null;
  receipt_date: string | null;
};

const MAX = 10_000_000;

function realDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** null when sound; otherwise what to fix, in words Andrew can act on. */
export function receiptMoneyProblem(r: ReceiptMoneyInput, today: Date = new Date()): string | null {
  if (!/^[A-Z]{3}$/.test(r.currency)) {
    return "Currency must be a three-letter code, like TTD or USD.";
  }
  if (r.amount == null || !Number.isFinite(r.amount) || r.amount <= 0 || r.amount >= MAX) {
    return "Enter the receipt's amount — a number above zero.";
  }
  if (r.ttd_amount == null || !Number.isFinite(r.ttd_amount) || r.ttd_amount <= 0 || r.ttd_amount >= MAX) {
    return "Enter the TTD amount — a number above zero. Without it the receipt can't be matched or counted in any report.";
  }
  // A TTD receipt has one amount. Two different figures for the same purchase
  // make the report's "Amount" and "TTD" columns contradict each other.
  if (r.currency === "TTD" && Math.abs(r.amount - r.ttd_amount) > 0.005) {
    return `This receipt is in TTD, so its TTD amount must be the same as its amount (${r.amount.toFixed(
      2
    )}). Change one of them.`;
  }
  if (r.tax_amount != null) {
    if (!Number.isFinite(r.tax_amount) || r.tax_amount < 0) {
      return "Tax can't be negative.";
    }
    if (r.tax_amount > r.amount + 0.005) {
      return "Tax can't be more than the whole receipt.";
    }
  }
  if (r.receipt_date != null) {
    const latest = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    if (!realDate(r.receipt_date) || r.receipt_date < "2000-01-01" || r.receipt_date > latest) {
      return "That receipt date isn't possible. Check the day, month and year.";
    }
  }
  return null;
}
