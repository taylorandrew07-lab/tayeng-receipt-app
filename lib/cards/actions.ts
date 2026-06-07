"use server";

import { revalidatePath } from "next/cache";
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

export async function deleteCard(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  // RLS ensures the user can only delete their own card.
  await supabase.from("cards").delete().eq("id", id);
  revalidatePath("/cards");
}
