/**
 * Which receipts may be matched to which charges — ONE definition.
 *
 * The automatic run, the manual attach and the confirm button previously each
 * decided this for themselves, so they disagreed: a cash receipt or a flagged
 * duplicate could be attached by hand even though the run would never propose
 * it, and a suggestion made last week could be confirmed after the receipt had
 * since been re-marked as cash.
 *
 * Every mutation now re-checks these rules at the moment it writes, against the
 * CURRENT rows — not against whatever was on screen when the page was drawn.
 *
 * Pure functions, no I/O, so the rules themselves are unit-tested.
 */

import { withinReceiptWindow } from "@/lib/matching/match";

/** Payment methods that can never appear on a company credit card statement. */
export const NEVER_ON_A_CARD_STATEMENT = ["cash", "personal_card"] as const;

export type EligibilityReceipt = {
  status: string | null;
  duplicate_of: string | null;
  ttd_amount: number | null;
  payment_method: string | null;
};

/**
 * null when the receipt may be matched; otherwise the reason it may not, in
 * words Andrew can act on.
 *
 * Mirrors orphan_receipts.expected_on_statement (0021): decided by
 * payment_method alone, never by the derived `reimbursable` column.
 */
export function receiptIneligibility(r: EligibilityReceipt): string | null {
  if (r.duplicate_of) {
    return "That receipt is flagged as a duplicate of another one. Clear the duplicate flag first if it is a real, separate receipt.";
  }
  if (r.status !== "confirmed") {
    return "That receipt still needs reviewing. Open it and save it first.";
  }
  if (r.ttd_amount == null) {
    return "That receipt has no TTD amount yet. Open it and fill in the amount first.";
  }
  if ((NEVER_ON_A_CARD_STATEMENT as readonly string[]).includes(r.payment_method ?? "")) {
    return "That receipt was paid in cash or on a personal card, so it can't be on a company card statement. Claim it through the reimbursable report instead.";
  }
  return null;
}

export type EligibilityCharge = {
  no_receipt_expected: boolean;
};

/**
 * null when the charge may receive a receipt; otherwise why not.
 *
 * A CLOSED charge — a bank fee the machine recognised, or a purchase a person
 * decided to close without a receipt — is excluded until it is explicitly
 * reopened. Matching a receipt to one would quietly pull that receipt off the
 * list of receipts still waiting for a charge.
 */
export function chargeIneligibility(c: EligibilityCharge): string | null {
  if (c.no_receipt_expected) {
    return "That charge is closed — marked as not needing a receipt. Reopen it first if it does need one.";
  }
  return null;
}

/**
 * The date window applies ONLY when hunting for new matches. Andrew's decided
 * rule (2026-07-28): receipts already SENT to the accountant always carry over
 * regardless of age — otherwise an old charge reappearing on a new overlapping
 * statement is reported "missing" although its receipt was already sent.
 * (Receipts already CONFIRMED never enter the candidate pool at all; their
 * coverage carries over through the charge they are attached to.)
 */
export function exemptFromDateWindow(r: { sent: boolean | null }): boolean {
  return r.sent === true;
}

type Line = {
  id: string;
  charge_id: string | null;
  txn_date: string | null;
  created_at?: string | null;
};

/**
 * One line per REAL charge.
 *
 * Overlapping statements repeat the same charge as separate rows, so a
 * consolidated run across several statements would otherwise score each copy
 * independently: one receipt could be spent on the wrong copy, two receipts
 * could be offered for one charge, and with auto-confirm on the second
 * confirmation hits rsm_unique_confirmed_charge and takes the whole batch down.
 *
 * Keeps the EARLIEST copy — ordered exactly as
 * charge_reconciliation.canonical_txn_id orders them (0017: txn_date nulls
 * last, then created_at, then id). A suggestion therefore lands on the row
 * every screen treats as the charge's own. Lines with no charge yet are kept
 * individually.
 */
export function oneLinePerCharge<T extends Line>(lines: T[]): T[] {
  const best = new Map<string, T>();
  const loose: T[] = [];
  for (const l of lines) {
    if (!l.charge_id) {
      loose.push(l);
      continue;
    }
    const cur = best.get(l.charge_id);
    if (!cur || earlier(l, cur)) best.set(l.charge_id, l);
  }
  return [...best.values(), ...loose];
}

function earlier(a: Line, b: Line): boolean {
  // Must stay identical to 0017's `order by t.txn_date nulls last,
  // t.created_at, t.id` — deterministic whichever order the rows arrived in.
  if (a.txn_date !== b.txn_date) {
    if (a.txn_date == null) return false;
    if (b.txn_date == null) return true;
    return a.txn_date < b.txn_date;
  }
  const ac = a.created_at ?? "";
  const bc = b.created_at ?? "";
  if (ac !== bc) return ac < bc;
  return a.id < b.id;
}

/**
 * The statement lines a run should try to find receipts for: not already
 * covered (by this line OR by any copy of its charge), not closed, and ONE per
 * real charge. runMatchPass calls exactly this.
 */
export function selectOpenLines<T extends Line>(
  lines: T[],
  known: {
    confirmedTxnIds: Set<string>;
    confirmedChargeIds: Set<string>;
    closedChargeIds: Set<string>;
  }
): T[] {
  return oneLinePerCharge(
    lines.filter(
      (l) =>
        !known.confirmedTxnIds.has(l.id) &&
        !(l.charge_id && known.confirmedChargeIds.has(l.charge_id)) &&
        !(l.charge_id && known.closedChargeIds.has(l.charge_id))
    )
  );
}

export type CandidateReceipt = EligibilityReceipt & {
  id: string;
  receipt_date: string | null;
  sent: boolean | null;
};

/**
 * The receipts a run may propose: eligible under the one shared rule, not
 * already confirmed anywhere, and inside the date window — unless already
 * SENT, which always carries over. runMatchPass calls exactly this.
 */
export function selectCandidates<T extends CandidateReceipt>(
  receipts: T[],
  scope: {
    confirmedReceiptIds: Set<string>;
    periodStart: string;
    periodEnd: string;
    windowBefore: number;
    windowAfter: number;
  }
): T[] {
  return receipts.filter(
    (r) =>
      receiptIneligibility(r) === null &&
      !scope.confirmedReceiptIds.has(r.id) &&
      (exemptFromDateWindow(r) ||
        withinReceiptWindow(
          r.receipt_date,
          scope.periodStart,
          scope.periodEnd,
          scope.windowBefore,
          scope.windowAfter
        ))
  );
}
