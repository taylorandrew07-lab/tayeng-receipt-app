"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type DeleteStatementResult =
  | { ok: true }
  | { ok: false; needsConfirm: true; matchCount: number; message: string }
  | { ok: false; needsConfirm?: false; message: string }
  | null;

/**
 * Deleting a statement is no longer a quiet cascade.
 *
 * Since 0016_match_durability.sql changed statement_transaction_id to
 * ON DELETE SET NULL, confirmed matches SURVIVE the delete — but the charges
 * they point at disappear from charge_reconciliation, which inner-joins
 * statement lines. So the open-item count moves with no visible reason, which
 * is the one thing a close-out ledger must never do.
 *
 * First submit reports the cost; a second submit with confirm=1 goes ahead.
 */
export async function deleteStatement(
  _prev: DeleteStatementResult,
  formData: FormData
): Promise<DeleteStatementResult> {
  const id = String(formData.get("id") ?? "");
  const confirmed = String(formData.get("confirm") ?? "") === "1";
  if (!id) return { ok: false, message: "No statement selected." };

  const supabase = await createClient();

  const { data: statement, error: readError } = await supabase
    .from("statements")
    .select("storage_path, file_name")
    .eq("id", id)
    .single();
  if (readError || !statement)
    return { ok: false, message: "That statement could not be found." };

  if (!confirmed) {
    const { data: txns } = await supabase
      .from("statement_transactions")
      .select("id")
      .eq("statement_id", id);
    const txnIds = (txns ?? []).map((t) => t.id);

    const { count } = txnIds.length
      ? await supabase
          .from("receipt_statement_matches")
          .select("id", { count: "exact", head: true })
          .in("statement_transaction_id", txnIds)
          .eq("confirmed", true)
      : { count: 0 };

    const matchCount = count ?? 0;
    return {
      ok: false,
      needsConfirm: true,
      matchCount,
      message:
        matchCount > 0
          ? `"${statement.file_name}" has ${matchCount} confirmed receipt ${
              matchCount === 1 ? "match" : "matches"
            }. Those receipts are kept, but these ${txnIds.length} charges leave your close-out list — so your outstanding total will change.`
          : `Delete "${statement.file_name}" and its ${txnIds.length} transactions?`,
    };
  }

  if (statement.storage_path) {
    const { error: storageError } = await supabase.storage
      .from("documents")
      .remove([statement.storage_path]);
    // A missing file must not block the row delete; a real failure should show.
    if (storageError && !/not found/i.test(storageError.message))
      return { ok: false, message: `Could not remove the file: ${storageError.message}` };
  }

  const { error: deleteError } = await supabase.from("statements").delete().eq("id", id);
  if (deleteError)
    return { ok: false, message: `Could not delete the statement: ${deleteError.message}` };

  revalidatePath("/statements");
  revalidatePath("/matching");
  revalidatePath("/reconcile");
  redirect("/statements");
}
