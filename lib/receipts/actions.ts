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
  const reimbursableRaw = String(formData.get("reimbursable") ?? "");
  const reimbursable =
    reimbursableRaw === "yes" ? true : reimbursableRaw === "no" ? false : null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  // Note: month_key (upload month) is intentionally NOT changed here — the
  // workspace is organised by upload date, and editing the receipt date must
  // not move the receipt to a different month.

  if (!PAYMENT_METHODS.includes(payment_method)) {
    return { error: "Invalid payment method." };
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

  const { data: files } = await supabase
    .from("receipt_files")
    .select("storage_path")
    .in("receipt_id", ids);
  if (files && files.length > 0) {
    await supabase.storage
      .from("documents")
      .remove(files.map((f) => f.storage_path));
  }
  await supabase.from("receipts").delete().in("id", ids);

  revalidatePath("/receipts");
  revalidatePath("/review");
}

export async function deleteReceipt(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();

  // Remove stored files first (RLS scopes to the user's folder).
  const { data: files } = await supabase
    .from("receipt_files")
    .select("storage_path")
    .eq("receipt_id", id);
  if (files && files.length > 0) {
    await supabase.storage
      .from("documents")
      .remove(files.map((f) => f.storage_path));
  }
  await supabase.from("receipts").delete().eq("id", id);

  revalidatePath("/receipts");
  revalidatePath("/review");
  redirect("/receipts");
}
