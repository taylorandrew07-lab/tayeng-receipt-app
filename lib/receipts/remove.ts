import "server-only";

/**
 * Lives OUTSIDE lib/receipts/actions.ts on purpose: that file is "use server",
 * where every export becomes a publicly callable server action. This helper
 * takes a database client and must never be callable from a browser.
 */

export type BulkResult = { ok: boolean; message: string; count: number };

/** The slice of the Supabase client this needs — narrow, so tests can fake it. */
export type RemoveClient = {
  from(table: string): {
    select(cols: string): {
      in(col: string, vals: string[]): PromiseLike<{
        data: Record<string, unknown>[] | null;
        error: { message: string } | null;
      }>;
    };
    delete(): {
      in(col: string, vals: string[]): {
        select(cols: string): PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  storage: {
    from(bucket: string): {
      remove(paths: string[]): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Delete receipts, and ONLY THEN their files — and only the files of receipts
 * that were actually deleted.
 *
 * The old order removed the files regardless of whether the database delete
 * worked. A delete that RLS filters out reports no error and affects zero
 * rows, so a receipt could survive with its document gone: a record that
 * points at nothing, which no report can ever embed again. Keeping a stray
 * file costs a few kilobytes; losing the only copy of a receipt costs the claim.
 */
export async function removeReceiptsSafely(
  supabase: RemoveClient,
  ids: string[]
): Promise<BulkResult> {
  // Paths first: receipt_files rows cascade away with their receipt.
  const { data: files, error: readErr } = await supabase
    .from("receipt_files")
    .select("receipt_id, storage_path")
    .in("receipt_id", ids);
  if (readErr) return { ok: false, message: `Could not delete: ${readErr.message}`, count: 0 };

  const { data: gone, error: delErr } = await supabase
    .from("receipts")
    .delete()
    .in("id", ids)
    .select("id");
  if (delErr) return { ok: false, message: `Could not delete: ${delErr.message}`, count: 0 };

  const deleted = new Set((gone ?? []).map((r) => r.id as string));
  const paths = (files ?? [])
    .filter((f) => deleted.has(f.receipt_id as string))
    .map((f) => f.storage_path as string);
  if (paths.length > 0) {
    const { error: rmErr } = await supabase.storage.from("documents").remove(paths);
    // The records are already gone; a leftover file is harmless. Log it.
    if (rmErr) console.error("storage cleanup failed after delete:", rmErr.message);
  }

  const n = deleted.size;
  if (n === 0) {
    return { ok: false, message: "Nothing was deleted — those receipts may already be gone.", count: 0 };
  }
  if (n < ids.length) {
    return {
      ok: false,
      message: `Deleted ${n} of ${ids.length}. The other ${ids.length - n} could not be deleted.`,
      count: n,
    };
  }
  return { ok: true, message: `Deleted ${n} receipt${n === 1 ? "" : "s"}.`, count: n };
}
