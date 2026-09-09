"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { CardType } from "@/lib/types";

const CARD_TYPES: CardType[] = ["personal", "company", "cash", "other"];

export type CardFormState = { error?: string } | undefined;

export async function createCard(
  _prev: CardFormState,
  formData: FormData
): Promise<CardFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const nickname = String(formData.get("nickname") ?? "").trim();
  const last4Raw = String(formData.get("last4") ?? "").trim();
  const cardType = String(formData.get("card_type") ?? "personal") as CardType;
  const notes = String(formData.get("notes") ?? "").trim();

  if (!nickname) return { error: "Please enter a card nickname." };
  if (last4Raw && !/^\d{4}$/.test(last4Raw)) {
    return { error: "Last 4 digits must be exactly 4 numbers (or left blank)." };
  }
  if (!CARD_TYPES.includes(cardType)) {
    return { error: "Invalid card type." };
  }

  const { error } = await supabase.from("cards").insert({
    user_id: user.id,
    nickname,
    last4: last4Raw || null,
    card_type: cardType,
    notes: notes || null,
  });

  if (error) return { error: error.message };

  revalidatePath("/cards");
  return undefined;
}

/**
 * Edit a card in place.
 *
 * Cards previously had create and delete only, so correcting a nickname or the
 * last 4 digits meant deleting the card and adding it again — which sets
 * receipts.card_id and statements.card_id to NULL (both are ON DELETE SET NULL,
 * 0001:145,185) and quietly unlinks every document already filed against it.
 *
 * WHAT THIS DOES NOT DO: it does not re-classify receipts already processed.
 * classify.ts resolves last4 -> card -> payment_method ONCE, at extraction
 * time, and writes the answer onto the receipt. Nothing recomputes it later, so
 * changing a card's type changes how FUTURE receipts classify only. The form
 * says so in plain words rather than leaving it to be discovered.
 */
export async function updateCard(
  _prev: CardFormState,
  formData: FormData
): Promise<CardFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const id = String(formData.get("id") ?? "").trim();
  if (!id) return { error: "Missing card id." };

  const nickname = String(formData.get("nickname") ?? "").trim();
  const last4Raw = String(formData.get("last4") ?? "").trim();
  const cardType = String(formData.get("card_type") ?? "personal") as CardType;
  const notes = String(formData.get("notes") ?? "").trim();

  if (!nickname) return { error: "Please enter a card nickname." };
  if (last4Raw && !/^\d{4}$/.test(last4Raw)) {
    return { error: "Last 4 digits must be exactly 4 numbers (or left blank)." };
  }
  if (!CARD_TYPES.includes(cardType)) {
    return { error: "Invalid card type." };
  }

  // RLS scopes this to the owner, so a card id belonging to someone else
  // simply matches no row.
  const { data: before, error: readErr } = await supabase
    .from("cards")
    .select("last4")
    .eq("id", id)
    .single();
  if (readErr || !before) return { error: "That card could not be found." };

  const last4 = last4Raw || null;

  const { error } = await supabase
    .from("cards")
    .update({ nickname, last4, card_type: cardType, notes: notes || null })
    .eq("id", id);
  if (error) return { error: error.message };

  // Move the learned "these 4 digits mean this card" rule with the card.
  //
  // Left alone, the OLD number keeps resolving to this card forever: the rule
  // is consulted before the cards list (classify.ts:74-81), so a stale rule
  // silently wins over the card's real details on every future upload.
  if (before.last4 !== last4) {
    if (before.last4) {
      await supabase
        .from("learning_rules")
        .delete()
        .eq("user_id", user.id)
        .eq("rule_type", "last4_card")
        .eq("pattern", before.last4);
    }
    if (last4) {
      await supabase.from("learning_rules").upsert(
        {
          user_id: user.id,
          rule_type: "last4_card",
          pattern: last4,
          action: { card_id: id },
        },
        { onConflict: "user_id,rule_type,pattern" }
      );
    }
  }

  revalidatePath("/cards");
  redirect("/cards");
}

export async function deleteCard(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  // RLS ensures the user can only delete their own card.
  await supabase.from("cards").delete().eq("id", id);
  revalidatePath("/cards");
}
