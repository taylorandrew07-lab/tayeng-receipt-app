"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { matchReceipts, type MatchReceipt, type MatchTxn } from "@/lib/matching/match";

/**
 * Scores the statement's transactions against the user's receipts and stores
 * suggestions. High-confidence pairs are auto-confirmed; weaker ones become
 * "possible matches" awaiting the user. Existing confirmed matches are kept.
 */
export async function runMatching(formData: FormData): Promise<void> {
  const statementId = String(formData.get("statement_id") ?? "");
  if (!statementId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: txnData } = await supabase
    .from("statement_transactions")
    .select("id, txn_date, description, amount, card_last4")
    .eq("statement_id", statementId);
  const transactions = (txnData ?? []) as MatchTxn[];
  if (transactions.length === 0) return;

  // Receipts already confirmed-matched anywhere are off the table.
  const { data: confirmed } = await supabase
    .from("receipt_statement_matches")
    .select("receipt_id, statement_transaction_id, confirmed")
    .eq("confirmed", true);
  const confirmedReceiptIds = new Set(
    (confirmed ?? []).map((m) => m.receipt_id).filter(Boolean) as string[]
  );
  const confirmedTxnIds = new Set(
    (confirmed ?? [])
      .map((m) => m.statement_transaction_id)
      .filter(Boolean) as string[]
  );

  const { data: receiptData } = await supabase
    .from("receipts")
    .select("id, receipt_date, vendor_name, ttd_amount, card_last4")
    .not("ttd_amount", "is", null);
  const receipts = ((receiptData ?? []) as MatchReceipt[]).filter(
    (r) => !confirmedReceiptIds.has(r.id)
  );

  const openTxns = transactions.filter((t) => !confirmedTxnIds.has(t.id));

  const { data: settings } = await supabase
    .from("user_settings")
    .select("date_tolerance_days, amount_tolerance_pct")
    .single();

  const outcome = matchReceipts(openTxns, receipts, {
    dateToleranceDays: Number(settings?.date_tolerance_days ?? 3),
    amountTolerancePct: Number(settings?.amount_tolerance_pct ?? 5),
  });

  // Clear previous *unconfirmed* suggestions for this statement's transactions.
  const txnIds = transactions.map((t) => t.id);
  await supabase
    .from("receipt_statement_matches")
    .delete()
    .in("statement_transaction_id", txnIds)
    .eq("confirmed", false);

  if (outcome.pairings.length > 0) {
    await supabase.from("receipt_statement_matches").insert(
      outcome.pairings.map((p) => ({
        user_id: user.id,
        receipt_id: p.receipt_id,
        statement_transaction_id: p.transaction_id,
        status: p.status,
        confidence: p.confidence,
        confirmed: p.status === "matched",
      }))
    );

    // Mark transactions of auto-confirmed matches.
    const autoTxnIds = outcome.pairings
      .filter((p) => p.status === "matched")
      .map((p) => p.transaction_id);
    if (autoTxnIds.length > 0) {
      await supabase
        .from("statement_transactions")
        .update({ is_matched: true })
        .in("id", autoTxnIds);
    }
  }

  revalidatePath("/matching");
}

export async function confirmMatch(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const txnId = String(formData.get("txn_id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  await supabase
    .from("receipt_statement_matches")
    .update({ confirmed: true, status: "matched" })
    .eq("id", id);
  if (txnId) {
    await supabase
      .from("statement_transactions")
      .update({ is_matched: true })
      .eq("id", txnId);
  }
  revalidatePath("/matching");
}

export async function rejectMatch(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const txnId = String(formData.get("txn_id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  await supabase.from("receipt_statement_matches").delete().eq("id", id);
  if (txnId) {
    await supabase
      .from("statement_transactions")
      .update({ is_matched: false })
      .eq("id", txnId);
  }
  revalidatePath("/matching");
}
