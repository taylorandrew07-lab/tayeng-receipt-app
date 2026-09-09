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

export type MatchOptions = {
  /**
   * A pair the user has already rejected. Blocked pairs never become
   * candidates at all, so the greedy assignment can still give the receipt to
   * its next-best charge instead of being consumed and then discarded.
   */
  isBlocked?: (transactionId: string, receiptId: string) => boolean;
  /**
   * Whether this run may confirm anything by itself. Mirrors
   * user_settings.auto_confirm_enabled, which 0014 sets to false by default:
   * "the consolidated run produces suggestions, not confirmations".
   *
   * This module owns the SCORING; the caller owns the POLICY. Defaults to true
   * only so a caller that has not thought about it behaves as it always did.
   */
  autoConfirm?: boolean;
};

/**
 * Is a receipt close enough in time to a statement period to be worth scoring?
 *
 * Andrew's decided rule (2026-07-28): consider receipts from `daysBefore` days
 * before the period start to `daysAfter` days after the period end. The
 * after-window exists because the wrong far-gap matches in live data were
 * receipts dated AFTER the period being dragged backwards onto it.
 *
 * An UNDATED receipt always passes: we cannot judge it, and excluding it would
 * hide it from matching entirely. Its missing date is already scored as a weak
 * neutral and can never auto-confirm (see PairScore.datesAgree).
 *
 * NOTE: this is a CANDIDATE filter for hunting NEW matches only. Receipts that
 * are already confirmed or already sent must carry over regardless of age --
 * enforced by the caller, which never puts them in the pool to begin with.
 */
export function withinReceiptWindow(
  receiptDate: string | null,
  periodStart: string,
  periodEnd: string,
  daysBefore: number,
  daysAfter: number
): boolean {
  if (!receiptDate) return true;
  const d = Date.parse(receiptDate);
  const from = Date.parse(periodStart);
  const to = Date.parse(periodEnd);
  if (Number.isNaN(d) || Number.isNaN(from) || Number.isNaN(to)) return true;
  return d >= from - daysBefore * 86_400_000 && d <= to + daysAfter * 86_400_000;
}

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
  // Keep 2+ char tokens so short T&T vendors (BP, NP, A&W) still contribute.
  const a = new Set(normalizeVendor(vendor).split(" ").filter((t) => t.length >= 2));
  const b = new Set(normalizeVendor(description).split(" ").filter((t) => t.length >= 2));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  return overlap / Math.min(a.size, b.size);
}

export type PairScore = {
  confidence: number; // 0-100
  /**
   * Both dates are known and within 3x the tolerance. Amount and vendor alone
   * can carry a pair past STRONG_CONFIDENCE, so this gates AUTO-CONFIRMATION
   * separately: a recurring merchant (Amazon, a fuel station) bills similar
   * amounts all year, and a same-amount receipt from 77 days away silently
   * closed a real open charge in the Aug 2026 run.
   */
  datesAgree: boolean;
};

export function scorePairDetail(
  txn: MatchTxn,
  receipt: MatchReceipt,
  settings: MatchSettings
): PairScore {
  const none = { confidence: 0, datesAgree: false };
  if (txn.amount == null || receipt.ttd_amount == null) return none;

  const aScore = amountScore(txn.amount, receipt.ttd_amount, settings.amountTolerancePct);
  if (aScore === 0) return none; // amount must be plausibly close

  const bothDated = Boolean(txn.txn_date && receipt.receipt_date);
  const dScore = bothDated
    ? dateScore(daysBetween(txn.txn_date!, receipt.receipt_date!), settings.dateToleranceDays)
    : 0.3; // unknown date -> weak neutral
  const vScore = vendorScore(receipt.vendor_name, txn.description);

  // A matching last 4 is a bonus. A mismatch is only a SMALL penalty (not a
  // disqualifier) so a receipt mis-labelled as personal — or with a different/
  // missing card on file — can still surface against the statement for review.
  let card = 0;
  if (txn.card_last4 && receipt.card_last4) {
    card = txn.card_last4 === receipt.card_last4 ? 0.1 : -0.15;
  }

  const conf = aScore * 0.5 + dScore * 0.2 + vScore * 0.2 + card;
  return {
    confidence: Math.round(Math.max(0, Math.min(1, conf)) * 100),
    datesAgree: bothDated && dScore > 0,
  };
}

export function scorePair(
  txn: MatchTxn,
  receipt: MatchReceipt,
  settings: MatchSettings
): number {
  return scorePairDetail(txn, receipt, settings).confidence;
}

/**
 * Greedy one-to-one matching: score every plausible pair, then assign the
 * highest-confidence pairs first, each receipt/transaction used at most once.
 */
export function matchReceipts(
  transactions: MatchTxn[],
  receipts: MatchReceipt[],
  settings: MatchSettings,
  options: MatchOptions = {}
): MatchOutcome {
  const { isBlocked, autoConfirm = true } = options;
  const candidates: Pairing[] = [];
  for (const txn of transactions) {
    for (const receipt of receipts) {
      if (isBlocked?.(txn.id, receipt.id)) continue;
      const { confidence, datesAgree } = scorePairDetail(txn, receipt, settings);
      if (confidence >= MIN_CONFIDENCE) {
        candidates.push({
          transaction_id: txn.id,
          receipt_id: receipt.id,
          confidence,
          // Ranking still uses confidence alone; only the auto-confirm needs
          // the dates to agree. A strong-but-distant pair is still offered,
          // it just waits for a person.
          status:
            autoConfirm && confidence >= STRONG_CONFIDENCE && datesAgree
              ? "matched"
              : "possible_match",
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
