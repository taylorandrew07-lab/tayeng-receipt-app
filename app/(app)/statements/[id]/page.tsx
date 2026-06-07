import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { deleteStatement } from "@/lib/statements/actions";
import { formatTTD } from "@/lib/month";
import type { Statement, StatementTransaction } from "@/lib/types";

export default async function StatementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: statement } = await supabase
    .from("statements")
    .select("*")
    .eq("id", id)
    .single();
  if (!statement) notFound();
  const st = statement as Statement;

  const { data: txns } = await supabase
    .from("statement_transactions")
    .select("*")
    .eq("statement_id", id)
    .order("txn_date", { ascending: true });
  const rows = (txns ?? []) as StatementTransaction[];
  const total = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  return (
    <div>
      <PageHeader
        title={st.file_name}
        subtitle={
          st.period_start && st.period_end
            ? `${st.period_start} → ${st.period_end} · ${rows.length} transactions · ${formatTTD(total)}`
            : `${rows.length} transactions · ${formatTTD(total)}`
        }
        action={
          <div className="flex items-center gap-3">
            <Link
              href={`/matching?statement=${st.id}`}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Match receipts
            </Link>
            <Link href="/statements" className="text-sm text-slate-600 underline">
              ← Back
            </Link>
          </div>
        }
      />

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No transactions were read from this statement.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Description</th>
                <th className="px-4 py-3 font-semibold">Card</th>
                <th className="px-4 py-3 text-right font-semibold">Amount</th>
                <th className="px-4 py-3 font-semibold">Matched</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {t.txn_date ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-900">{t.description ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {t.card_last4 ? `••${t.card_last4}` : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-slate-900">
                    {t.amount != null ? `${t.currency} ${Number(t.amount).toFixed(2)}` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {t.is_matched ? (
                      <span className="text-xs font-medium text-green-700">Yes</span>
                    ) : (
                      <span className="text-xs text-slate-400">No</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form action={deleteStatement} className="mt-6">
        <input type="hidden" name="id" value={st.id} />
        <button
          type="submit"
          className="text-sm text-slate-400 hover:text-red-700"
        >
          Delete statement
        </button>
      </form>
    </div>
  );
}
