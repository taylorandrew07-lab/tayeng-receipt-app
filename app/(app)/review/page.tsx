import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { PAYMENT_LABEL } from "@/components/receipts/labels";
import { formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";

export default async function ReviewPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("receipts")
    .select("*, receipt_files(file_name)")
    .eq("status", "needs_review")
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as (Receipt & {
    receipt_files: { file_name: string }[];
  })[];

  return (
    <div>
      <PageHeader
        title="Needs Review"
        subtitle="Items the app wasn't fully sure about. Open each one, confirm or correct the details, and it learns for next time."
      />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          🎉 Nothing to review. All your receipts are confirmed.
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/receipts/${r.id}?from=review`}
                className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-amber-300 hover:shadow"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">
                      {r.vendor_name ?? "Unknown vendor"}
                      <span className="ml-2 text-sm font-normal text-slate-500">
                        {r.receipt_date ?? "no date"}
                      </span>
                    </p>
                    {r.receipt_files?.[0]?.file_name && (
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        📎 {r.receipt_files[0].file_name}
                      </p>
                    )}
                    <p className="mt-1 text-sm text-amber-700">
                      {r.notes ?? "Needs review"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold text-slate-900">
                      {r.ttd_amount != null ? formatTTD(r.ttd_amount) : "—"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {PAYMENT_LABEL[r.payment_method]}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
