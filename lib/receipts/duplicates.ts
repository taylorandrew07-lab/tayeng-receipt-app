import { normalizeVendor } from "@/lib/classification/classify";

export type DupSource = {
  receipt_date: string | null;
  vendor_name: string | null;
  ttd_amount: number | null;
  amount: number | null;
  card_last4: string | null;
  fileName: string | null;
};

/**
 * The set of "fingerprint" keys that make two receipts the same. Two receipts
 * are duplicates if they share ANY key:
 *  - identical file name (the same file re-uploaded), OR
 *  - same vendor + TTD amount + date, OR
 *  - same original amount + card last 4 + date.
 * Amount-based keys include the DATE so two genuine same-amount purchases on
 * different days are NOT treated as duplicates.
 */
export function duplicateKeys(r: DupSource): string[] {
  const keys: string[] = [];
  const nv = normalizeVendor(r.vendor_name);
  const ttd = r.ttd_amount != null ? Math.round(Number(r.ttd_amount) * 100) : null;
  const amt = r.amount != null ? Math.round(Number(r.amount) * 100) : null;
  const d = r.receipt_date ?? "";
  const fn = (r.fileName ?? "").toLowerCase().trim();
  if (fn) keys.push(`f:${fn}`);
  if (nv && ttd != null && d) keys.push(`v:${nv}|${ttd}|${d}`);
  if (amt != null && r.card_last4 && d) keys.push(`a:${amt}|${r.card_last4}|${d}`);
  return keys;
}
