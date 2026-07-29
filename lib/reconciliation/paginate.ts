/**
 * PostgREST caps every response at a maximum row count (1000 by default), and
 * it does so SILENTLY — a query that returns exactly the cap looks identical
 * to one that returned everything. Several reconciliation queries were reading
 * whole tables with no limit, so past the cap they were operating on an
 * arbitrary subset.
 *
 * This is load-bearing for vendor scoring: an IDF corpus built from a
 * truncated page would change every score without any error being raised.
 */
const PAGE = 1000;

export type Page<T> = PromiseLike<{
  data: T[] | null;
  error: { message: string } | null;
}>;

/**
 * The Supabase client here has no generated database types, so PostgREST
 * cannot infer row shapes from a select string and falls back to an error
 * type. The row shapes are asserted in lib/reconciliation/types.ts and must be
 * kept in step with the views in supabase/migrations/0017.
 */
export const asPage = <T,>(q: unknown): Page<T> => q as Page<T>;

export async function fetchAll<T>(build: (from: number, to: number) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    // A short page means we reached the end. A full page might be the cap.
    if (rows.length < PAGE) return out;
  }
}
