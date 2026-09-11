"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CARD_TYPE_TO_PAYMENT, normalizeVendor } from "@/lib/classification/classify";
import { PAYMENT_LABEL } from "@/components/receipts/labels";
import { duplicateKeys } from "@/lib/receipts/duplicates";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
import { removeReceiptsSafely, type RemoveClient } from "@/lib/receipts/remove";
import type { PaymentMethod } from "@/lib/types";

export type ReceiptFormState = { error?: string } | undefined;

/** Outcome of a bulk action, so the screen can say what actually happened. */
export type { BulkResult } from "@/lib/receipts/remove";
import type { BulkResult } from "@/lib/receipts/remove";

const PAYMENT_METHODS: PaymentMethod[] = [
  "personal_card",
  "company_card",
  "cash",
  "online",
  "unknown",
  "other",
];

function num(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Saves a user's manual corrections to a receipt, marks it confirmed, and
 * records reusable learning rules (vendor->category, card last4->card) so
 * similar future receipts classify automatically.
 */
export async function saveReceipt(
  _prev: ReceiptFormState,
  formData: FormData
): Promise<ReceiptFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing receipt id." };

  const vendor_name = String(formData.get("vendor_name") ?? "").trim() || null;
  const receipt_date = String(formData.get("receipt_date") ?? "").trim() || null;
  const currency = (String(formData.get("currency") ?? "TTD").trim() || "TTD").toUpperCase();
  const amount = num(formData.get("amount"));
  const ttd_amount = num(formData.get("ttd_amount"));
  const tax_amount = num(formData.get("tax_amount"));
  const payment_method = String(
    formData.get("payment_method") ?? "unknown"
  ) as PaymentMethod;
  const card_id = String(formData.get("card_id") ?? "").trim() || null;
  const category_id = String(formData.get("category_id") ?? "").trim() || null;
  const card_last4Raw = String(formData.get("card_last4") ?? "").trim();
  const card_last4 = /^\d{4}$/.test(card_last4Raw) ? card_last4Raw : null;
  // Reimbursable is derived, not chosen: only company-card spend is not reimbursable.
  const reimbursable = payment_method !== "company_card";
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // Note: month_key (upload month) is intentionally NOT changed here — the
  // workspace is organised by upload date, and editing the receipt date must
  // not move the receipt to a different month.

  if (!PAYMENT_METHODS.includes(payment_method)) {
    return { error: "Invalid payment method." };
  }

  // The card and the payment type must agree.
  //
  // The editor offers both as independent fields, so it was possible to pick
  // the company card and mark the payment "Personal card". `reimbursable` is
  // derived from payment_method, so that receipt was then CLAIMED BACK on the
  // reimbursable report while ALSO sitting on the company card statement — the
  // same money counted twice. Refuse rather than guess which one was meant.
  if (card_id) {
    const { data: card } = await supabase
      .from("cards")
      .select("nickname, card_type")
      .eq("id", card_id)
      .maybeSingle();
    if (!card) return { error: "That card could not be found. Pick it again." };
    const implied = CARD_TYPE_TO_PAYMENT[card.card_type as keyof typeof CARD_TYPE_TO_PAYMENT];
    if (implied && implied !== payment_method) {
      return {
        error:
          `"${card.nickname}" is set up as ${PAYMENT_LABEL[implied].toLowerCase()}, but the payment ` +
          `type says ${PAYMENT_LABEL[payment_method].toLowerCase()}. Change one so they agree — this ` +
          `decides whether the receipt is claimed back or goes on the company card.`,
      };
    }
  }

  // --- Bill-back (charge back to a client or vessel) -------------------
  const billBack = String(formData.get("bill_back") ?? "") === "yes";
  let bill_back_type: "client" | "vessel" | null = null;
  let bill_back_name: string | null = null;
  let bill_back_normalized: string | null = null;
  if (billBack) {
    const typeRaw = String(formData.get("bill_back_type") ?? "").trim();
    const nameRaw = String(formData.get("bill_back_name") ?? "").trim();
    if (typeRaw !== "client" && typeRaw !== "vessel") {
      return { error: "Choose whether the bill-back is for a Client or a Vessel." };
    }
    if (!nameRaw) {
      return { error: "Enter the client or vessel name to bill back to." };
    }
    bill_back_type = typeRaw;
    bill_back_name = nameRaw;
    bill_back_normalized = normalizeVendor(nameRaw);
  }

  const { data: saved, error } = await supabase
    .from("receipts")
    .update({
      vendor_name,
      receipt_date,
      currency,
      amount,
      ttd_amount,
      tax_amount,
      payment_method,
      card_id,
      card_last4,
      category_id,
      reimbursable,
      notes,
      bill_back: billBack,
      bill_back_type,
      bill_back_name,
      bill_back_normalized,
      status: "confirmed",
    })
    .eq("id", id)
    .select("id");

  if (error) return { error: error.message };
  // RLS filters a row you may not touch down to ZERO rows and reports no
  // error, so "no error" is not "saved". Say so rather than redirect away as
  // if it worked.
  if (!saved || saved.length === 0) {
    return { error: "That receipt could not be saved — it may have been deleted. Reload and try again." };
  }

  // --- Learn from the correction --------------------------------------
  if (vendor_name && category_id) {
    await supabase.from("learning_rules").upsert(
      {
        user_id: user.id,
        rule_type: "vendor_category",
        pattern: normalizeVendor(vendor_name),
        action: { category_id },
      },
      { onConflict: "user_id,rule_type,pattern" }
    );
  }
  if (card_last4 && card_id) {
    await supabase.from("learning_rules").upsert(
      {
        user_id: user.id,
        rule_type: "last4_card",
        pattern: card_last4,
        action: { card_id },
      },
      { onConflict: "user_id,rule_type,pattern" }
    );
  }

  revalidatePath("/receipts");
  revalidatePath("/review");
  // When the receipt was opened from the review queue, go back there so the
  // user can clear the next item; otherwise return to the full receipts list.
  const redirectTo = String(formData.get("redirect_to") ?? "");
  redirect(redirectTo === "/review" ? "/review" : "/receipts");
}

/**
 * Deletes many receipts at once (bulk "delete selected" / "start over").
 * Rows first, then ONLY the files of rows that were really deleted — see
 * lib/receipts/remove.ts. RLS scopes everything to the user.
 */
export async function deleteReceipts(ids: string[]): Promise<BulkResult> {
  "use server";
  if (!ids || ids.length === 0) return { ok: false, message: "Nothing selected.", count: 0 };
  const supabase = await createClient();
  const removed = await removeReceiptsSafely(supabase as unknown as RemoveClient, ids);
  revalidatePath("/receipts");
  revalidatePath("/review");
  revalidatePath("/reconcile");
  return removed;
}

/**
 * Re-checks ALL receipts for duplicates and flags later copies. Two receipts
 * are considered the same if they share a file name, OR a vendor + TTD amount,
 * OR an original amount + card last 4. The earliest upload is kept as the
 * original; later ones are flagged (duplicate_of) and sent to Needs Review.
 * Returns how many were newly flagged.
 */
export async function findDuplicates(): Promise<{ flagged: number }> {
  "use server";
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { flagged: 0 };

  // Paginated: PostgREST silently caps a response at 1000 rows, and a
  // duplicate scan that sees an arbitrary subset of the corpus flags the wrong
  // receipts as copies -- and misses real ones -- with no error raised.
  const rows = await fetchAll<{
    id: string;
    created_at: string;
    receipt_date: string | null;
    vendor_name: string | null;
    ttd_amount: number | null;
    amount: number | null;
    card_last4: string | null;
    duplicate_of: string | null;
    not_duplicate: boolean;
    receipt_files: { file_name: string }[];
  }>((from, to) =>
    asPage(
      supabase
        .from("receipts")
        .select(
          "id, created_at, receipt_date, vendor_name, ttd_amount, amount, card_last4, duplicate_of, not_duplicate, receipt_files(file_name)"
        )
        .order("created_at", { ascending: true })
        .range(from, to)
    )
  );

  // Group ids by each duplicate key (rows are in upload order).
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    for (const key of duplicateKeys({
      receipt_date: r.receipt_date,
      vendor_name: r.vendor_name,
      ttd_amount: r.ttd_amount,
      amount: r.amount,
      card_last4: r.card_last4,
      fileName: r.receipt_files?.[0]?.file_name ?? null,
    })) {
      const arr = groups.get(key) ?? [];
      arr.push(r.id);
      groups.set(key, arr);
    }
  }

  // dupId -> original (earliest) id
  const dupToOriginal = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const [first, ...rest] = ids;
    for (const dupId of rest) {
      if (!dupToOriginal.has(dupId)) dupToOriginal.set(dupId, first);
    }
  }

  // Never re-flag receipts already flagged, or ones the user dismissed.
  const skip = new Set(
    rows.filter((r) => r.duplicate_of || r.not_duplicate).map((r) => r.id)
  );

  let flagged = 0;
  for (const [dupId, originalId] of dupToOriginal) {
    if (skip.has(dupId)) continue;
    await supabase
      .from("receipts")
      .update({ duplicate_of: originalId, status: "needs_review" })
      .eq("id", dupId);
    flagged++;
  }

  revalidatePath("/receipts");
  revalidatePath("/review");
  return { flagged };
}

/**
 * Marks receipts as sent (archived) or not. "Sent" means they've been
 * submitted/handled, so they show as archived and can be filtered out.
 */

export async function setReceiptsSent(ids: string[], sent: boolean): Promise<BulkResult> {
  "use server";
  if (!ids || ids.length === 0) return { ok: false, message: "Nothing selected.", count: 0 };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("receipts")
    .update({ sent, sent_at: sent ? new Date().toISOString() : null })
    .in("id", ids)
    .select("id");
  revalidatePath("/receipts");
  revalidatePath("/reconcile");
  return bulkOutcome(error, data, ids.length, sent ? "marked as sent" : "marked as not sent");
}

/**
 * "Sent" and "paid" are the two facts the close-out and the reimbursement
 * claim rest on. Previously both actions returned nothing, so a failure
 * looked exactly like success and the receipt stayed on the list unexplained.
 */
function bulkOutcome(
  error: { message: string } | null,
  data: unknown[] | null,
  wanted: number,
  verb: string
): BulkResult {
  if (error) return { ok: false, message: `Nothing was ${verb}: ${error.message}`, count: 0 };
  const n = data?.length ?? 0;
  if (n === wanted) {
    return { ok: true, message: `${n} receipt${n === 1 ? "" : "s"} ${verb}.`, count: n };
  }
  return {
    ok: false,
    message:
      n === 0
        ? `Nothing was ${verb} — those receipts may have been deleted.`
        : `Only ${n} of ${wanted} were ${verb}.`,
    count: n,
  };
}

/**
 * Marks receipts paid / unpaid. Paid reimbursables drop off the dashboard's
 * outstanding total (the money has been reimbursed).
 */
export async function setReceiptsPaid(ids: string[], paid: boolean): Promise<BulkResult> {
  "use server";
  if (!ids || ids.length === 0) return { ok: false, message: "Nothing selected.", count: 0 };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("receipts")
    .update({ paid, paid_at: paid ? new Date().toISOString() : null })
    .in("id", ids)
    .select("id");
  revalidatePath("/receipts");
  revalidatePath("/dashboard");
  return bulkOutcome(error, data, ids.length, paid ? "marked as paid" : "marked as unpaid");
}

export async function dismissDuplicate(formData: FormData): Promise<void> {
  "use server";
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  await supabase
    .from("receipts")
    .update({ duplicate_of: null, not_duplicate: true })
    .eq("id", id);
  revalidatePath("/receipts");
  revalidatePath("/review");
}

export async function deleteReceipt(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();

  const res = await removeReceiptsSafely(supabase as unknown as RemoveClient, [id]);
  revalidatePath("/receipts");
  revalidatePath("/review");
  revalidatePath("/reconcile");
  // On failure go BACK to the receipt and say why, instead of landing on the
  // list as though it had worked.
  if (!res.ok) redirect(`/receipts/${id}?msg=${encodeURIComponent(res.message)}`);
  redirect("/receipts");
}
