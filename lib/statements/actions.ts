"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function deleteStatement(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = await createClient();

  const { data: statement } = await supabase
    .from("statements")
    .select("storage_path")
    .eq("id", id)
    .single();
  if (statement?.storage_path) {
    await supabase.storage.from("documents").remove([statement.storage_path]);
  }
  // statement_transactions + matches cascade-delete via FK.
  await supabase.from("statements").delete().eq("id", id);

  revalidatePath("/statements");
  revalidatePath("/matching");
  redirect("/statements");
}
