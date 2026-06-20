"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { normalizeVendor } from "@/lib/classification/classify";
import type { PaymentMethod } from "@/lib/types";

export type ReceiptFormState = { error?: string } | undefined;

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

  const { error } = await supabase
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
    .eq("id", id);

  if (error) return { error: error.message };

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
  redirect("/receipts");
}

/**
 * Deletes many receipts at once (bulk "delete selected" / "start over").
 * Removes their stored files first. RLS scopes everything to the user.
 */
export async function deleteReceipts(ids: string[]): Promise<void> {
  "use server";
  if (!ids || ids.length === 0) return;
  const supabase = await createClient();

  // Capture paths, delete the rows (cascades receipt_files), then best-effort
  // remove the blobs — surfacing (not swallowing) any storage failure.
  const { data: files } = await supabase
    .from("receipt_files")
    .select("storage_path")
    .in("receipt_id", ids);
  await supabase.from("receipts").delete().in("id", ids);
  if (files && files.length > 0) {
    const { error: rmErr } = await supabase.storage
      .from("documents")
      .remove(files.map((f) => f.storage_path));
    if (rmErr) console.error("storage cleanup failed (bulk delete):", rmErr.message);
  }

  revalidatePath("/receipts");
  revalidatePath("/review");
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

  const { data } = await supabase
    .from("receipts")
    .select(
      "id, created_at, receipt_date, vendor_name, ttd_amount, amount, card_last4, duplicate_of, not_duplicate, receipt_files(file_name)"
    )
    .order("created_at", { ascending: true });

  const rows = (data ?? []) as {
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
  }[];

  // Group ids by each duplicate key (rows are in upload order). Amount-based
  // keys include the DATE so two legitimate same-amount purchases on different
  // days are NOT treated as duplicates; an identical file name always is.
  const groups = new Map<string, string[]>();
  const add = (key: string, id: string) => {
    if (!key) return;
    const arr = groups.get(key) ?? [];
    arr.push(id);
    groups.set(key, arr);
  };
  for (const r of rows) {
    const nv = normalizeVendor(r.vendor_name);
    const ttd = r.ttd_amount != null ? Math.round(Number(r.ttd_amount) * 100) : null;
    const amt = r.amount != null ? Math.round(Number(r.amount) * 100) : null;
    const d = r.receipt_date ?? "";
    const fn = (r.receipt_files?.[0]?.file_name ?? "").toLowerCase().trim();
    if (fn) add(`f:${fn}`, r.id);
    if (nv && ttd != null && d) add(`v:${nv}|${ttd}|${d}`, r.id);
    if (amt != null && r.card_last4 && d) add(`a:${amt}|${r.card_last4}|${d}`, r.id);
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
export async function setReceiptsSent(ids: string[], sent: boolean): Promise<void> {
  "use server";
  if (!ids || ids.length === 0) return;
  const supabase = await createClient();
  await supabase
    .from("receipts")
    .update({ sent, sent_at: sent ? new Date().toISOString() : null })
    .in("id", ids);
  revalidatePath("/receipts");
}

/**
 * Marks a receipt as NOT a duplicate: clears the flag and remembers the
 * decision so the auto-detector never re-flags it.
 */
/**
 * Marks receipts paid / unpaid. Paid reimbursables drop off the dashboard's
 * outstanding total (the money has been reimbursed).
 */
export async function setReceiptsPaid(ids: string[], paid: boolean): Promise<void> {
  "use server";
  if (!ids || ids.length === 0) return;
  const supabase = await createClient();
  await supabase
    .from("receipts")
    .update({ paid, paid_at: paid ? new Date().toISOString() : null })
    .in("id", ids);
  revalidatePath("/receipts");
  revalidatePath("/dashboard");
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

  const { data: files } = await supabase
    .from("receipt_files")
    .select("storage_path")
    .eq("receipt_id", id);
  await supabase.from("receipts").delete().eq("id", id);
  if (files && files.length > 0) {
    const { error: rmErr } = await supabase.storage
      .from("documents")
      .remove(files.map((f) => f.storage_path));
    if (rmErr) console.error("storage cleanup failed (delete receipt):", rmErr.message);
  }

  revalidatePath("/receipts");
  revalidatePath("/review");
  redirect("/receipts");
}
