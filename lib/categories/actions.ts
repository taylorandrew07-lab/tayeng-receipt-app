"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type CategoryFormState = { error?: string } | undefined;

export async function createCategory(
  _prev: CategoryFormState,
  formData: FormData
): Promise<CategoryFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Please enter a category name." };

  const { error } = await supabase
    .from("categories")
    .insert({ user_id: user.id, name, is_default: false });

  if (error) {
    if (error.code === "23505") return { error: "That category already exists." };
    return { error: error.message };
  }

  revalidatePath("/categories");
  return undefined;
}

export async function deleteCategory(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();
  await supabase.from("categories").delete().eq("id", id);
  revalidatePath("/categories");
}
