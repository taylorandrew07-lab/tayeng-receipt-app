import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChargeState } from "@/lib/reconciliation/types";

/**
 * Is a statement line covered? — answered by its CHARGE, never by the line.
 *
 * A charge carried on three overlapping statements has ONE receipt, attached
 * to whichever copy was matched first. Asking "does THIS line have a match?"
 * (statement_transactions.is_matched, or matches filtered by
 * statement_transaction_id) reports the other two copies as missing a receipt
 * that was found — and, worse, already sent. That was the original bug this
 * whole charge model exists to fix, and three screens still asked the old
 * question: the statement page, the per-statement PDF, and /matching.
 *
 * Every one of them now reads the answer from charge_reconciliation, the same
 * view the close-out list uses, so no two screens can disagree.
 */
export type ChargeCoverage = {
  state: ChargeState;
  receipt_id: string | null;
  receipt_vendor: string | null;
  receipt_sent: boolean;
  fee_auto_flagged: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

export async function loadChargeCoverage(
  supabase: Db,
  chargeIds: (string | null)[]
): Promise<Map<string, ChargeCoverage>> {
  const ids = [...new Set(chargeIds.filter(Boolean))] as string[];
  const out = new Map<string, ChargeCoverage>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("charge_reconciliation")
      .select("charge_id, state, receipt_id, receipt_vendor, receipt_sent, fee_auto_flagged")
      .in("charge_id", ids.slice(i, i + 200));
    // A coverage answer built from a failed read would print "needs a receipt"
    // for everything. Fail loudly instead.
    if (error) throw new Error(`Could not read charge coverage: ${error.message}`);
    for (const row of (data ?? []) as (ChargeCoverage & { charge_id: string })[]) {
      out.set(row.charge_id, row);
    }
  }
  return out;
}

/** Covered = nothing left to chase for this charge. */
export function isCovered(c: ChargeCoverage | undefined): boolean {
  return (
    c?.state === "already_sent" ||
    c?.state === "already_matched" ||
    c?.state === "no_receipt_expected"
  );
}

/** The one plain-English label every screen uses for a line's status. */
export function coverageLabel(c: ChargeCoverage | undefined): string {
  switch (c?.state) {
    case "already_sent":
      return "Receipt sent";
    case "already_matched":
      return "Matched · not sent yet";
    case "needs_confirmation":
      return "Suggested · check it";
    case "no_receipt_expected":
      return c.fee_auto_flagged ? "Bank charge" : "Closed · no receipt";
    default:
      return "Needs a receipt";
  }
}
