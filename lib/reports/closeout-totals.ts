import type { ChargeRow, CloseOutData, OrphanRow } from "@/lib/reconciliation/types";

/**
 * Every figure on the close-out PDF's cover, computed ONLY from the rows the
 * PDF prints — so each one can be ticked back to the tables.
 *
 * Two rules are enforced here rather than trusted to the caller:
 *   - Charges closed BY HAND (d.clearedByHand) are internal housekeeping.
 *     They are not printed, so they are in no total either. The old cover's
 *     "total spend" included them, which revealed exactly what Andrew asked
 *     never to be shown to the office.
 *   - Only TTD is summed. A charge in another currency is shown in its own
 *     currency and reported in `foreignCurrencies`, never added into a TTD sum.
 */
export type CloseOutTotals = {
  /** Charges printed in sections 1, 3, 4 and 5. */
  listedCount: number;
  listedTotal: number;
  /** Statement lines behind the listed charges (each copy counted). */
  listedLines: number;
  /** Value repeated across overlapping statements, among listed charges. */
  repeatedValue: number;
  needsReceiptTotal: number;
  orphanTotal: number;
  matchedTotal: number;
  sentTotal: number;
  bankTotal: number;
  foreignCurrencies: string[];
};

const isTtd = (c: ChargeRow) => (c.currency ?? "TTD").toUpperCase() === "TTD";
const sumC = (rows: ChargeRow[]) =>
  rows.filter(isTtd).reduce((a, c) => a + Number(c.amount ?? 0), 0);
const sumO = (rows: OrphanRow[]) => rows.reduce((a, o) => a + Number(o.ttd_amount ?? 0), 0);

export function closeOutTotals(d: CloseOutData): CloseOutTotals {
  const needs = d.needsReceipt.concat(d.needsConfirmation);
  // d.clearedByHand is deliberately absent from this list.
  const listed = [...needs, ...d.readyToSend, ...d.alreadySent, ...d.bankCharges];
  return {
    listedCount: listed.length,
    listedTotal: sumC(listed),
    listedLines: listed.reduce((a, c) => a + c.copies, 0),
    repeatedValue: listed
      .filter(isTtd)
      .reduce((a, c) => a + (c.copies - 1) * Number(c.amount ?? 0), 0),
    needsReceiptTotal: sumC(needs),
    orphanTotal: sumO(d.orphansOpen),
    matchedTotal: sumC(d.readyToSend),
    sentTotal: sumC(d.alreadySent),
    bankTotal: sumC(d.bankCharges),
    foreignCurrencies: [
      ...new Set(listed.filter((c) => !isTtd(c)).map((c) => c.currency.toUpperCase())),
    ],
  };
}
