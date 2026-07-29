import type { SupabaseClient } from "@supabase/supabase-js";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
import type { ChargeRow, CloseOutData, OrphanRow } from "@/lib/reconciliation/types";

const CHARGE_COLS =
  "charge_id, txn_date, description, amount, currency, card_last4, canonical_txn_id, " +
  "statement_ids, statement_names, copies, is_duplicate, no_receipt_expected, fee_auto_flagged, " +
  "match_id, receipt_id, receipt_vendor, receipt_date, receipt_amount, receipt_currency, " +
  "receipt_sent, receipt_sent_at, pending_count, best_confidence, state";

const ORPHAN_COLS =
  "receipt_id, receipt_date, vendor_name, ttd_amount, amount, currency, sent, sent_at, paid, " +
  "reimbursable, pending_count, possible_duplicate_upload";

/**
 * Everything the close-out screen needs, in one place.
 *
 * Reads charge_reconciliation, which is ONE ROW PER REAL-WORLD CHARGE — a
 * charge carried on three overlapping statements appears once and counts once.
 * That is what makes the totals here differ from the raw statement lines.
 *
 * RLS scopes every query to the signed-in user, so no id lists are built into
 * the URL. Everything pages via fetchAll to clear PostgREST's silent row cap.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadCloseOut(supabase: SupabaseClient<any, any, any>): Promise<CloseOutData> {
  const [charges, orphans, statements, rawLines] = await Promise.all([
    fetchAll<ChargeRow>((from, to) =>
      asPage<ChargeRow>(
        supabase
          .from("charge_reconciliation")
          .select(CHARGE_COLS)
          .order("txn_date", { ascending: true, nullsFirst: false })
          .order("charge_id", { ascending: true })
          .range(from, to)
      )
    ),
    fetchAll<OrphanRow>((from, to) =>
      asPage<OrphanRow>(
        supabase
          .from("orphan_receipts")
          .select(ORPHAN_COLS)
          .order("receipt_date", { ascending: true, nullsFirst: false })
          .order("receipt_id", { ascending: true })
          .range(from, to)
      )
    ),
    fetchAll<{
      id: string;
      file_name: string;
      effective_start: string;
      effective_end: string;
      txn_count: number;
    }>((from, to) =>
      asPage(
        supabase
          .from("statement_coverage")
          .select("id, file_name, effective_start, effective_end, txn_count")
          .order("effective_end", { ascending: false })
          .range(from, to)
      )
    ),
    fetchAll<{ amount: number | null }>((from, to) =>
      asPage(supabase.from("statement_transactions").select("amount").range(from, to))
    ),
  ]);

  const by = (s: ChargeRow["state"]) => charges.filter((c) => c.state === s);

  const bankCharges = by("no_receipt_expected");
  const needsReceipt = by("genuinely_new");
  const needsConfirmation = by("needs_confirmation");
  const readyToSend = by("already_matched");
  const alreadySent = by("already_sent");

  const orphansOpen = orphans.filter((o) => !o.sent);
  const orphansSent = orphans.filter((o) => o.sent);

  // A receipt already confirmed against a charge cannot be attached elsewhere
  // (0013 + 0016 both enforce it), so only orphans are offered.
  const attachable = orphans.map((o) => ({
    id: o.receipt_id,
    vendor_name: o.vendor_name,
    ttd_amount: o.ttd_amount,
    receipt_date: o.receipt_date,
  }));

  const sum = (rows: { amount: number | null }[]) =>
    rows.reduce((a, r) => a + Number(r.amount ?? 0), 0);
  const sumT = (rows: OrphanRow[]) => rows.reduce((a, r) => a + Number(r.ttd_amount ?? 0), 0);

  const openCharges = [...needsReceipt, ...needsConfirmation];
  const openCount = openCharges.length + orphansOpen.length;

  return {
    needsReceipt,
    needsConfirmation,
    readyToSend,
    alreadySent,
    bankCharges,
    orphansOpen,
    orphansSent,
    attachable,
    statements,
    totals: {
      openCount,
      openValue: sum(openCharges) + sumT(orphansOpen),
      closedCount: readyToSend.length + alreadySent.length + bankCharges.length,
      totalCount: charges.length + orphans.length,
      spendTotal: sum(charges),
      rawLineTotal: rawLines.reduce((a, r) => a + Number(r.amount ?? 0), 0),
      bankChargesValue: sum(bankCharges),
      orphanOpenValue: sumT(orphansOpen),
    },
  };
}
