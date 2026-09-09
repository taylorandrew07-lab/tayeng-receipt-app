"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
import {
  matchReceipts,
  withinReceiptWindow,
  type MatchReceipt,
  type MatchTxn,
} from "@/lib/matching/match";

/** What a matching run did, in the words the user needs to read. */
export type MatchRunSummary = {
  ok: boolean;
  message: string;
  statementsScanned?: number;
  chargesConsidered?: number;
  receiptsConsidered?: number;
  suggested?: number;
  autoConfirmed?: number;
};

type TxnRow = MatchTxn & { charge_id: string | null; statement_id: string };
type MatchRow = {
  receipt_id: string | null;
  statement_transaction_id: string | null;
  charge_id: string | null;
  confirmed: boolean;
  rejected_at: string | null;
};

/**
 * Every knob 0014 added, in one place. The app used to read only the two
 * tolerance columns and silently ignore the other five, so the reconciliation
 * scope Andrew decided on was never actually applied.
 */
type ReconcileSettings = {
  dateToleranceDays: number;
  amountTolerancePct: number;
  statementCount: number;
  windowBefore: number;
  windowAfter: number;
  autoConfirm: boolean;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;

/**
 * The client has no generated database types, so PostgREST cannot infer a row
 * shape from a select string and falls back to an error type — the same reason
 * lib/reconciliation/paginate.ts exists. The shape is asserted here and must be
 * kept in step with 0001 and 0014.
 */
type SettingsRow = {
  date_tolerance_days: number | null;
  amount_tolerance_pct: number | null;
  reconcile_statement_count: number | null;
  receipt_window_days_before: number | null;
  receipt_window_days_after: number | null;
  auto_confirm_enabled: boolean | null;
};

async function loadSettings(supabase: Db): Promise<ReconcileSettings> {
  const res = await supabase
    .from("user_settings")
    .select(
      "date_tolerance_days, amount_tolerance_pct, reconcile_statement_count, " +
        "receipt_window_days_before, receipt_window_days_after, auto_confirm_enabled"
    )
    .single();
  const data = res.data as SettingsRow | null;
  return {
    dateToleranceDays: Number(data?.date_tolerance_days ?? 3),
    amountTolerancePct: Number(data?.amount_tolerance_pct ?? 5),
    statementCount: Number(data?.reconcile_statement_count ?? 4),
    windowBefore: Number(data?.receipt_window_days_before ?? 60),
    windowAfter: Number(data?.receipt_window_days_after ?? 15),
    // Default OFF. 0014: "the consolidated run produces suggestions, not
    // confirmations". Only an explicit true turns auto-confirmation on.
    autoConfirm: data?.auto_confirm_enabled === true,
  };
}

/**
 * The matching pass. One code path for both the per-statement button and the
 * consolidated run, because two implementations of "which receipts may match
 * which charges" is how the rules drift apart.
 *
 * `statementIds = null` means the consolidated run: the latest N statements by
 * real coverage, N from user_settings.reconcile_statement_count (0 = all).
 */
async function runMatchPass(
  supabase: Db,
  userId: string,
  statementIds: string[] | null
): Promise<MatchRunSummary> {
  const settings = await loadSettings(supabase);

  // --- Which statements are in scope --------------------------------------
  const coverage = await fetchAll<{
    id: string;
    effective_start: string;
    effective_end: string;
  }>((from, to) =>
    asPage(
      supabase
        .from("statement_coverage")
        .select("id, effective_start, effective_end")
        .order("effective_end", { ascending: false })
        .range(from, to)
    )
  );

  const scoped = statementIds
    ? coverage.filter((s) => statementIds.includes(s.id))
    : settings.statementCount > 0
      ? coverage.slice(0, settings.statementCount)
      : coverage;

  if (scoped.length === 0) {
    return { ok: false, message: "No statements to reconcile yet. Upload one first." };
  }

  // The candidate window spans the UNION of the statements in scope: earliest
  // start minus the before-window, latest end plus the after-window.
  const periodStart = scoped.reduce(
    (min, s) => (s.effective_start < min ? s.effective_start : min),
    scoped[0].effective_start
  );
  const periodEnd = scoped.reduce(
    (max, s) => (s.effective_end > max ? s.effective_end : max),
    scoped[0].effective_end
  );
  const scopedIds = scoped.map((s) => s.id);

  // --- Statement lines ----------------------------------------------------
  const transactions = await fetchAll<TxnRow>((from, to) =>
    asPage<TxnRow>(
      supabase
        .from("statement_transactions")
        .select("id, txn_date, description, amount, card_last4, charge_id, statement_id")
        .in("statement_id", scopedIds)
        .range(from, to)
    )
  );
  if (transactions.length === 0) {
    return {
      ok: false,
      message: "Those statements have no transactions yet. Parse them first.",
    };
  }

  // --- Existing matches ---------------------------------------------------
  // Read EVERY match row once, paginated. The previous version read these
  // unbounded, so past PostgREST's 1000-row cap it silently believed receipts
  // were free when they were already spoken for -- which the unique indexes
  // then rejected, killing the whole insert batch.
  const allMatches = await fetchAll<MatchRow>((from, to) =>
    asPage<MatchRow>(
      supabase
        .from("receipt_statement_matches")
        .select("receipt_id, statement_transaction_id, charge_id, confirmed, rejected_at")
        .range(from, to)
    )
  );

  const confirmedReceiptIds = new Set<string>();
  const confirmedTxnIds = new Set<string>();
  const confirmedChargeIds = new Set<string>();
  // A pair the user has REJECTED. 0016 records the rejection with rejected_at
  // precisely "so a rejected pairing is never resurrected by a later run" --
  // this is the half of that contract the app never implemented.
  const rejectedPairs = new Set<string>();

  for (const m of allMatches) {
    if (m.confirmed) {
      if (m.receipt_id) confirmedReceiptIds.add(m.receipt_id);
      if (m.statement_transaction_id) confirmedTxnIds.add(m.statement_transaction_id);
      if (m.charge_id) confirmedChargeIds.add(m.charge_id);
    }
    if (m.receipt_id && m.charge_id && m.rejected_at) {
      rejectedPairs.add(`${m.receipt_id}|${m.charge_id}`);
    }
  }

  // --- Candidate receipts -------------------------------------------------
  // Mirrors orphan_receipts (0019/0021): a receipt that is still in review, is
  // a flagged duplicate, or was paid in cash / on a personal card can never be
  // the receipt for a company card charge. Confirming one locks it behind two
  // unique indexes and removes it from the reimbursable pool -- money Andrew
  // is owed, quietly gone.
  const receiptRows = await fetchAll<MatchReceipt>((from, to) =>
    asPage<MatchReceipt>(
      supabase
        .from("receipts")
        .select("id, receipt_date, vendor_name, ttd_amount, card_last4")
        .not("ttd_amount", "is", null)
        .eq("status", "confirmed")
        .is("duplicate_of", null)
        .not("payment_method", "in", "(cash,personal_card)")
        .range(from, to)
    )
  );

  const receipts = receiptRows.filter(
    (r) =>
      !confirmedReceiptIds.has(r.id) &&
      withinReceiptWindow(
        r.receipt_date,
        periodStart,
        periodEnd,
        settings.windowBefore,
        settings.windowAfter
      )
  );

  const openTxns = transactions.filter(
    (t) => !confirmedTxnIds.has(t.id) && !(t.charge_id && confirmedChargeIds.has(t.charge_id))
  );

  const chargeOf = new Map(transactions.map((t) => [t.id, t.charge_id]));
  const pairKey = (txnId: string, receiptId: string) =>
    `${receiptId}|${chargeOf.get(txnId) ?? "none"}`;

  const outcome = matchReceipts(openTxns, receipts, settings, {
    isBlocked: (txnId, receiptId) => rejectedPairs.has(pairKey(txnId, receiptId)),
    autoConfirm: settings.autoConfirm,
  });

  // --- Replace stale suggestions -----------------------------------------
  // Only rows that are unconfirmed AND not rejected. Deleting rejected rows is
  // what let a pairing Andrew had already turned down come straight back.
  const txnIds = transactions.map((t) => t.id);
  for (let i = 0; i < txnIds.length; i += 200) {
    const { error } = await supabase
      .from("receipt_statement_matches")
      .delete()
      .in("statement_transaction_id", txnIds.slice(i, i + 200))
      .eq("confirmed", false)
      .is("rejected_at", null);
    if (error) {
      return { ok: false, message: `Could not clear old suggestions: ${error.message}` };
    }
  }

  // Re-read AFTER the delete: a pair held against ANOTHER statement's copy of
  // the same charge survives the delete above and would still collide with
  // rsm_unique_pair, which rejects the entire insert batch on the first hit.
  const surviving = await fetchAll<{ receipt_id: string | null; charge_id: string | null }>(
    (from, to) =>
      asPage(
        supabase.from("receipt_statement_matches").select("receipt_id, charge_id").range(from, to)
      )
  );
  const stillThere = new Set(
    surviving
      .filter((m) => m.receipt_id && m.charge_id)
      .map((m) => `${m.receipt_id}|${m.charge_id}`)
  );

  const fresh = outcome.pairings.filter(
    (p) => !stillThere.has(pairKey(p.transaction_id, p.receipt_id))
  );

  let autoConfirmed = 0;
  if (fresh.length > 0) {
    const { error } = await supabase.from("receipt_statement_matches").insert(
      fresh.map((p) => ({
        user_id: userId,
        receipt_id: p.receipt_id,
        statement_transaction_id: p.transaction_id,
        status: p.status,
        confidence: p.confidence,
        confirmed: p.status === "matched",
      }))
    );
    // Never swallowed. One conflicting row takes the whole batch down, and the
    // old code reported that to the user as "nothing found".
    if (error) {
      return { ok: false, message: `Could not save the suggestions: ${error.message}` };
    }

    const autoTxnIds = fresh.filter((p) => p.status === "matched").map((p) => p.transaction_id);
    autoConfirmed = autoTxnIds.length;
    if (autoTxnIds.length > 0) {
      await supabase
        .from("statement_transactions")
        .update({ is_matched: true })
        .in("id", autoTxnIds);
    }
  }

  const suggested = fresh.length - autoConfirmed;
  const parts = [
    `Checked ${openTxns.length} open charge${openTxns.length === 1 ? "" : "s"} across ` +
      `${scoped.length} statement${scoped.length === 1 ? "" : "s"} against ` +
      `${receipts.length} receipt${receipts.length === 1 ? "" : "s"}.`,
    fresh.length === 0
      ? "No new matches to suggest."
      : `${suggested} suggestion${suggested === 1 ? "" : "s"} for you to confirm` +
        (autoConfirmed > 0 ? `, ${autoConfirmed} confirmed automatically.` : "."),
  ];
  if (!settings.autoConfirm && fresh.length > 0) {
    parts.push("Nothing was ticked off by itself — you decide each one.");
  }

  return {
    ok: true,
    message: parts.join(" "),
    statementsScanned: scoped.length,
    chargesConsidered: openTxns.length,
    receiptsConsidered: receipts.length,
    suggested,
    autoConfirmed,
  };
}

/**
 * The consolidated close-out run: every statement in scope at once, so a charge
 * carried on two overlapping statements is considered once and a receipt can
 * match whichever statement actually carries its charge.
 */
export async function runConsolidatedMatching(
  // Both required by the useActionState signature; neither is needed -- the
  // run takes its whole scope from user_settings.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: MatchRunSummary | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData
): Promise<MatchRunSummary> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "You are signed out. Please sign in again." };

  const summary = await runMatchPass(supabase, user.id, null);
  revalidatePath("/reconcile");
  revalidatePath("/reconcile/board");
  revalidatePath("/matching");
  return summary;
}

/** Per-statement run, from the legacy /matching screen. */
export async function runMatching(formData: FormData): Promise<void> {
  const statementId = String(formData.get("statement_id") ?? "");
  if (!statementId) return;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  await runMatchPass(supabase, user.id, [statementId]);
  revalidatePath("/matching");
  revalidatePath("/reconcile");
}

export type AttachResult = { ok: boolean; message: string } | null;

/**
 * Manually attach a receipt the matcher did not find. Attaches to the CHARGE,
 * not to one statement's copy of it, so the receipt counts for every statement
 * that carried the same charge.
 */
export async function attachReceiptToCharge(
  _prev: AttachResult,
  formData: FormData
): Promise<AttachResult> {
  const txnId = String(formData.get("txn_id") ?? "");
  const receiptId = String(formData.get("receipt_id") ?? "");
  if (!txnId || !receiptId) return { ok: false, message: "Pick a receipt first." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "You are signed out. Please sign in again." };

  const { data: txn, error: txnError } = await supabase
    .from("statement_transactions")
    .select("id, charge_id, description, amount")
    .eq("id", txnId)
    .single();
  if (txnError || !txn) return { ok: false, message: "That statement line could not be found." };
  if (!txn.charge_id)
    return {
      ok: false,
      message: "That line has no charge record yet. Re-run matching and try again.",
    };

  // Is this charge already covered? unique(charge_id) where confirmed would
  // reject the insert anyway; catching it here gives a usable message.
  const { data: existing } = await supabase
    .from("receipt_statement_matches")
    .select("id, receipt_id, receipts(vendor_name)")
    .eq("charge_id", txn.charge_id)
    .eq("confirmed", true)
    .maybeSingle();
  if (existing && existing.receipt_id !== receiptId) {
    type VendorRel = { vendor_name: string | null };
    const rel = existing.receipts as unknown as VendorRel | VendorRel[] | null;
    const who =
      (Array.isArray(rel) ? rel[0]?.vendor_name : rel?.vendor_name) ?? "another receipt";
    return {
      ok: false,
      message: `This charge is already covered by ${who}. Unmatch that first if it is wrong.`,
    };
  }

  // And is the receipt already spoken for elsewhere? (0013's unique index.)
  const { data: taken } = await supabase
    .from("receipt_statement_matches")
    .select("id, charge_id")
    .eq("receipt_id", receiptId)
    .eq("confirmed", true)
    .maybeSingle();
  if (taken && taken.charge_id !== txn.charge_id)
    return {
      ok: false,
      message: "That receipt is already attached to a different charge.",
    };

  const { error } = await supabase.from("receipt_statement_matches").upsert(
    {
      user_id: user.id,
      receipt_id: receiptId,
      statement_transaction_id: txnId,
      charge_id: txn.charge_id,
      status: "matched",
      confidence: 100, // a person chose this
      confirmed: true,
      // A person has now chosen this pair, which overrides an earlier rejection.
      rejected_at: null,
    },
    { onConflict: "receipt_id,charge_id" }
  );
  if (error) return { ok: false, message: `Could not attach: ${error.message}` };

  revalidatePath("/matching");
  revalidatePath("/reconcile");
  revalidatePath("/reconcile/board");
  return { ok: true, message: "Receipt attached." };
}

function backToMatching(statementId: string, message: string): never {
  const suffix = statementId
    ? `?statement=${statementId}&msg=${encodeURIComponent(message)}`
    : "";
  redirect(`/matching${suffix}`);
}

/**
 * Confirm a suggested match.
 *
 * rsm_unique_confirmed_charge (0016) allows one confirmed receipt per charge.
 * The old version fired the update and discarded the error, so confirming a
 * second receipt against a covered charge did nothing at all and said nothing
 * at all -- the button simply appeared not to work.
 */
export async function confirmMatch(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const txnId = String(formData.get("txn_id") ?? "");
  const statementId = String(formData.get("statement_id") ?? "");
  if (!id) return;

  const supabase = await createClient();

  const { data: row } = await supabase
    .from("receipt_statement_matches")
    .select("id, charge_id, receipt_id")
    .eq("id", id)
    .single();
  if (!row) backToMatching(statementId, "That suggestion no longer exists.");

  if (row.charge_id) {
    const { data: holder } = await supabase
      .from("receipt_statement_matches")
      .select("id, receipts(vendor_name)")
      .eq("charge_id", row.charge_id)
      .eq("confirmed", true)
      .maybeSingle();
    if (holder && holder.id !== id) {
      type VendorRel = { vendor_name: string | null };
      const rel = holder.receipts as unknown as VendorRel | VendorRel[] | null;
      const who =
        (Array.isArray(rel) ? rel[0]?.vendor_name : rel?.vendor_name) ?? "another receipt";
      backToMatching(
        statementId,
        `This charge is already covered by ${who}. Unmatch that one first if it is wrong.`
      );
    }
  }

  if (row.receipt_id) {
    const { data: spoken } = await supabase
      .from("receipt_statement_matches")
      .select("id")
      .eq("receipt_id", row.receipt_id)
      .eq("confirmed", true)
      .maybeSingle();
    if (spoken && spoken.id !== id) {
      backToMatching(statementId, "That receipt is already attached to a different charge.");
    }
  }

  const { error } = await supabase
    .from("receipt_statement_matches")
    .update({ confirmed: true, status: "matched", rejected_at: null })
    .eq("id", id);
  if (error) backToMatching(statementId, `Could not confirm: ${error.message}`);

  if (txnId) {
    await supabase.from("statement_transactions").update({ is_matched: true }).eq("id", txnId);
  }
  revalidatePath("/matching");
  revalidatePath("/reconcile");
  backToMatching(statementId, "Match confirmed.");
}

/**
 * Turn down a suggested match, or unmatch a confirmed one.
 *
 * RECORDS the rejection instead of deleting the row. 0016 added rejected_at
 * for exactly this and documented it as "Set by rejectMatch instead of
 * deleting, so a rejected pairing is never resurrected by a later run" -- but
 * the action deleted, so every run re-suggested the pair Andrew had just
 * turned down.
 */
export async function rejectMatch(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const txnId = String(formData.get("txn_id") ?? "");
  const statementId = String(formData.get("statement_id") ?? "");
  if (!id) return;

  const supabase = await createClient();
  const { error } = await supabase
    .from("receipt_statement_matches")
    .update({
      confirmed: false,
      status: "needs_review",
      rejected_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) backToMatching(statementId, `Could not reject: ${error.message}`);

  if (txnId) {
    await supabase.from("statement_transactions").update({ is_matched: false }).eq("id", txnId);
  }
  revalidatePath("/matching");
  revalidatePath("/reconcile");
  backToMatching(statementId, "Rejected — it won't be suggested again.");
}
