import { createClient } from "@/lib/supabase/server";
import { loadCloseOut } from "@/lib/reconciliation/board-data";
import { CloseOutView } from "@/components/reconcile/closeout-view";

export const dynamic = "force-dynamic";

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show = "open" } = await searchParams;
  const supabase = await createClient();
  const d = await loadCloseOut(supabase);
  return <CloseOutView d={d} show={show} />;
}
