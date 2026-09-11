import { formatMoney, formatTTD } from "@/lib/month";
import type { CloseOutData } from "@/lib/reconciliation/types";
import type { ReceiptItem } from "@/lib/reports/append-receipts";

/**
 * The close-out appendix, in ONE place, because two callers must agree on it
 * exactly: the PDF route (which slices it into parts) and the close-out screen
 * (which offers one download button per part). If they disagreed, a part
 * button could point past the end, or a part could be left unoffered.
 *
 * Matched receipts first, in table order, then receipts with no statement
 * line. Each label carries its global number, so "#41" means the same
 * document in every part. Charges closed by hand have no receipt and are
 * never listed.
 */
export function closeOutAppendix(d: CloseOutData): ReceiptItem[] {
  const matched = d.readyToSend
    .concat(d.alreadySent)
    .filter((c) => c.receipt_id)
    .map((c) => ({
      receiptId: c.receipt_id as string,
      text: `${c.txn_date ?? ""} · ${c.receipt_vendor ?? "Receipt"} · ${formatMoney(
        Number(c.amount ?? 0),
        c.currency
      )}`,
    }));
  const noLine = d.orphansOpen.concat(d.orphansSent).map((o) => ({
    receiptId: o.receipt_id,
    text: `${o.receipt_date ?? ""} · ${o.vendor_name ?? "Receipt"} · ${
      o.ttd_amount != null ? formatTTD(Number(o.ttd_amount)) : ""
    } · NO STATEMENT LINE`,
  }));
  return [...matched, ...noLine].map((x, i) => ({
    receiptId: x.receiptId,
    label: `#${i + 1} · ${x.text}`,
  }));
}
