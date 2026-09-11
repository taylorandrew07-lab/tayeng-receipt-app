import type { SupabaseClient } from "@supabase/supabase-js";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
import type {
  ChargeRow,
  CloseOutData,
  OrphanRow,
  StatementCoverageRow,
} from "@/lib/reconciliation/types";
import { completenessOf } from "@/lib/reports/completeness";

const CHARGE_COLS =
  "charge_id, txn_date, description, amount, currency, card_last4, canonical_txn_id, " +
  "statement_ids, statement_names, copies, is_duplicate, no_receipt_expected, fee_auto_flagged, " +
  "match_id, receipt_id, receipt_vendor, receipt_date, receipt_amount, receipt_currency, " +
  "receipt_sent, receipt_sent_at, pending_count, best_confidence, state";

const ORPHAN_COLS =
  "receipt_id, receipt_date, vendor_name, ttd_amount, amount, currency, sent, sent_at, paid, " +
  "reimbursable, payment_method, expected_on_statement, pending_count, possible_duplicate_upload";

const STATEMENT_COLS =
  "id, file_name, effective_start, effective_end, period_read, txn_count, line_total, " +
  "currencies, previous_balance, total_purchases, total_payments, closing_balance, " +
  "credits_excluded, totals_reconciled, totals_difference, balance_consistent, balance_difference";

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
    fetchAll<StatementCoverageRow>((from, to) =>
      asPage<StatementCoverageRow>(
        supabase
          .from("statement_coverage")
          .select(STATEMENT_COLS)
          .order("effective_end", { ascending: false })
          // A unique tiebreak: paging needs a TOTAL order, or rows can be
          // skipped or repeated across the 1000-row boundary.
          .order("id", { ascending: true })
          .range(from, to)
      )
    ),
    fetchAll<{ amount: number | null; currency: string | null }>((from, to) =>
      asPage(
        supabase
          .from("statement_transactions")
          .select("amount, currency")
          .order("id", { ascending: true })
          .range(from, to)
      )
    ),
  ]);

  const by = (s: ChargeRow["state"]) => charges.filter((c) => c.state === s);

  const needsReceipt = by("genuinely_new");
  const needsConfirmation = by("needs_confirmation");
  const readyToSend = by("already_matched");
  const alreadySent = by("already_sent");

  // Both of these are `no_receipt_expected`, but they mean completely
  // different things and must never be presented as one pile:
  //
  //   fee_auto_flagged = true   the machine recognised bank noise — an
  //                             overlimit fee, interest, a payment to the card.
  //   fee_auto_flagged = false  a PERSON decided this real purchase is closed
  //                             without a receipt.
  //
  // Merging them put TTD 1,877.26 of genuine Amazon and petrol spend into a
  // section of the accountant's PDF headed "Bank charges".
  const noReceiptExpected = by("no_receipt_expected");
  const bankCharges = noReceiptExpected.filter((c) => c.fee_auto_flagged);
  const clearedByHand = noReceiptExpected.filter((c) => !c.fee_auto_flagged);

  // A cash or personal-card receipt can never appear on a CREDIT CARD
  // statement — it is settled through the reimbursable report. Counting those
  // here put items on a close-out list that could never be cleared.
  const onStatement = orphans.filter((o) => o.expected_on_statement);
  const reimbursables = orphans.filter((o) => !o.expected_on_statement);
  const orphansOpen = onStatement.filter((o) => !o.sent);
  const orphansSent = onStatement.filter((o) => o.sent);

  // A receipt already confirmed against a charge cannot be attached elsewhere
  // (0013 + 0016 both enforce it), so only orphans are offered.
  const attachable = onStatement.map((o) => ({
    id: o.receipt_id,
    vendor_name: o.vendor_name,
    ttd_amount: o.ttd_amount,
    receipt_date: o.receipt_date,
  }));

  // TTD ONLY. Every total on the close-out screen is printed with formatTTD,
  // so a statement line in any other currency must never be added into one.
  // Such lines are counted separately below and shown in their own currency.
  const isTtd = (r: { currency?: string | null }) =>
    (r.currency ?? "TTD").toUpperCase() === "TTD";
  const sum = (rows: { amount: number | null; currency?: string | null }[]) =>
    rows.filter(isTtd).reduce((a, r) => a + Number(r.amount ?? 0), 0);

  const foreign = new Map<string, { count: number; total: number }>();
  for (const c of charges) {
    if (isTtd(c)) continue;
    const cur = c.currency.toUpperCase();
    const f = foreign.get(cur) ?? { count: 0, total: 0 };
    f.count += 1;
    f.total += Number(c.amount ?? 0);
    foreign.set(cur, f);
  }
  const sumT = (rows: OrphanRow[]) => rows.reduce((a, r) => a + Number(r.ttd_amount ?? 0), 0);

  const openCharges = [...needsReceipt, ...needsConfirmation];

  // OPEN + CLOSED must equal TOTAL, over one single universe of items.
  //
  // The old version counted `charges + ALL orphans` as the denominator while
  // the numerator counted neither the reimbursables nor the already-sent
  // orphans, so the bar could never reach 100%. Live effect: the screen said
  // "0 open · Nothing outstanding" above a progress bar reading 61%.
  //
  // The universe is close-out work: every charge, plus every receipt that is
  // expected on a statement. Reimbursables are settled through a different
  // report and belong to neither side.
  const openCount = openCharges.length + orphansOpen.length;
  const closedCount =
    readyToSend.length +
    alreadySent.length +
    bankCharges.length +
    clearedByHand.length +
    orphansSent.length;

  // Can we prove every line on every statement was captured? One verdict per
  // statement, from the same function the PDF uses (lib/reports/completeness).
  const verdicts = statements.map((s) => ({ s, c: completenessOf(s) }));
  const proven = verdicts.filter((v) => v.c.proven);
  const failing = verdicts.filter(
    (v) => v.c.verdict === "does_not_add_up" || v.c.verdict === "summary_inconsistent"
  );

  return {
    needsReceipt,
    needsConfirmation,
    readyToSend,
    alreadySent,
    bankCharges,
    clearedByHand,
    orphansOpen,
    orphansSent,
    reimbursables,
    attachable,
    statements,
    totals: {
      openCount,
      openValue: sum(openCharges) + sumT(orphansOpen),
      closedCount,
      totalCount: openCount + closedCount,
      spendTotal: sum(charges),
      rawLineTotal: sum(rawLines),
      bankChargesValue: sum(bankCharges),
      clearedByHandValue: sum(clearedByHand),
      orphanOpenValue: sumT(orphansOpen),
      reimbursableCount: reimbursables.length,
      reimbursableValue: sumT(reimbursables),
      statementsProven: proven.length,
      statementsFailing: failing.length,
      failingNames: failing.map((v) => v.s.file_name),
      foreignCharges: [...foreign.entries()].map(([currency, f]) => ({ currency, ...f })),
    },
  };
}
