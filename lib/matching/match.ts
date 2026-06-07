import { normalizeVendor } from "@/lib/classification/classify";

export type MatchTxn = {
  id: string;
  txn_date: string | null;
  description: string | null;
  amount: number | null;
  card_last4: string | null;
};

export type MatchReceipt = {
  id: string;
  receipt_date: string | null;
  vendor_name: string | null;
  ttd_amount: number | null;
  card_last4: string | null;
};

export type MatchSettings = {
  dateToleranceDays: number;
  amountTolerancePct: number;
};

export type Pairing = {
  transaction_id: string;
  receipt_id: string;
  confidence: number; // 0-100
  status: "matched" | "possible_match";
};

export type MatchOutcome = {
  pairings: Pairing[];
  unmatchedReceiptIds: string[];
  missingReceiptTxnIds: string[];
};

const MIN_CONFIDENCE = 40;
const STRONG_CONFIDENCE = 75;

function daysBetween(a: string, b: string): number {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.abs(da - db) / 86_400_000;
}

function amountScore(txn: number, receipt: number, tolPct: number): number {
  const base = Math.max(Math.abs(txn), Math.abs(receipt), 0.01);
  const diffPct = (Math.abs(txn - receipt) / base) * 100;
  if (diffPct <= 0.5) return 1;
  if (diffPct <= tolPct) return 1 - (diffPct / tolPct) * 0.4; // 1 -> 0.6
  if (diffPct <= tolPct * 3) return 0.6 - ((diffPct - tolPct) / (tolPct * 2)) * 0.6; // 0.6 -> 0
  return 0;
}

function dateScore(diff: number, tolDays: number): number {
  if (diff === 0) return 1;
  if (diff <= tolDays) return 1 - (diff / tolDays) * 0.4; // 1 -> 0.6
  if (diff <= tolDays * 3) return 0.6 - ((diff - tolDays) / (tolDays * 2)) * 0.6;
  return 0;
}

function vendorScore(vendor: string | null, description: string | null): number {
  const a = new Set(normalizeVendor(vendor).split(" ").filter((t) => t.length >= 3));
  const b = new Set(normalizeVendor(description).split(" ").filter((t) => t.length >= 3));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / Math.min(a.size, b.size);
}

export function scorePair(
  txn: MatchTxn,
  receipt: MatchReceipt,
  settings: MatchSettings
): number {
  if (txn.amount == null || receipt.ttd_amount == null) return 0;

  const aScore = amountScore(txn.amount, receipt.ttd_amount, settings.amountTolerancePct);
  if (aScore === 0) return 0; // amount must be plausibly close

  const dScore =
    txn.txn_date && receipt.receipt_date
      ? dateScore(daysBetween(txn.txn_date, receipt.receipt_date), settings.dateToleranceDays)
      : 0.3; // unknown date -> weak neutral
  const vScore = vendorScore(receipt.vendor_name, txn.description);

  let card = 0;
  if (txn.card_last4 && receipt.card_last4) {
    card = txn.card_last4 === receipt.card_last4 ? 0.1 : -0.4;
  }

  const conf = aScore * 0.5 + dScore * 0.2 + vScore * 0.2 + card;
  return Math.round(Math.max(0, Math.min(1, conf)) * 100);
}

/**
 * Greedy one-to-one matching: score every plausible pair, then assign the
 * highest-confidence pairs first, each receipt/transaction used at most once.
 */
export function matchReceipts(
  transactions: MatchTxn[],
  receipts: MatchReceipt[],
  settings: MatchSettings
): MatchOutcome {
  const candidates: Pairing[] = [];
  for (const txn of transactions) {
    for (const receipt of receipts) {
      const confidence = scorePair(txn, receipt, settings);
      if (confidence >= MIN_CONFIDENCE) {
        candidates.push({
          transaction_id: txn.id,
          receipt_id: receipt.id,
          confidence,
          status: confidence >= STRONG_CONFIDENCE ? "matched" : "possible_match",
        });
      }
    }
  }
  candidates.sort((a, b) => b.confidence - a.confidence);

  const usedTxn = new Set<string>();
  const usedReceipt = new Set<string>();
  const pairings: Pairing[] = [];
  for (const c of candidates) {
    if (usedTxn.has(c.transaction_id) || usedReceipt.has(c.receipt_id)) continue;
    usedTxn.add(c.transaction_id);
    usedReceipt.add(c.receipt_id);
    pairings.push(c);
  }

  return {
    pairings,
    unmatchedReceiptIds: receipts.filter((r) => !usedReceipt.has(r.id)).map((r) => r.id),
    missingReceiptTxnIds: transactions
      .filter((t) => !usedTxn.has(t.id))
      .map((t) => t.id),
  };
}
