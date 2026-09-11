import { normalizeVendor } from "@/lib/classification/classify";

export type DupSource = {
  receipt_date: string | null;
  vendor_name: string | null;
  ttd_amount: number | null;
  amount: number | null;
  card_last4: string | null;
  /** SHA-256 of the file's bytes (0027), or null when not yet computed. */
  contentHash: string | null;
};

/**
 * The set of "fingerprint" keys that make two receipts the same. Two receipts
 * are duplicates if they share ANY key:
 *  - identical file CONTENT (the same document uploaded twice), OR
 *  - same vendor + TTD amount + date, OR
 *  - same original amount + card last 4 + date.
 *
 * NOT the file name. It used to be a key on its own, so two unrelated
 * documents that both happened to be called "IMG_0001.jpg" or "invoice.pdf"
 * were flagged duplicates — and a flagged duplicate is dropped from every
 * report and from the close-out list. Names are reused constantly; bytes are
 * not.
 *
 * Amount-based keys include the DATE so two genuine same-amount purchases on
 * different days are NOT treated as duplicates.
 */
export function duplicateKeys(r: DupSource): string[] {
  const keys: string[] = [];
  const nv = normalizeVendor(r.vendor_name);
  const ttd = r.ttd_amount != null ? Math.round(Number(r.ttd_amount) * 100) : null;
  const amt = r.amount != null ? Math.round(Number(r.amount) * 100) : null;
  const d = r.receipt_date ?? "";
  const hash = (r.contentHash ?? "").toLowerCase().trim();
  if (/^[0-9a-f]{64}$/.test(hash)) keys.push(`h:${hash}`);
  if (nv && ttd != null && d) keys.push(`v:${nv}|${ttd}|${d}`);
  if (amt != null && r.card_last4 && d) keys.push(`a:${amt}|${r.card_last4}|${d}`);
  return keys;
}
