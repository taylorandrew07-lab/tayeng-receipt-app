import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { MonthSelect } from "@/components/receipts/month-select";
import { PAYMENT_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/components/receipts/labels";
import { currentMonthKey, formatMonthKey, formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";

type Row = Receipt & { categories: { name: string } | null };

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const supabase = await createClient();
  const { month } = await searchParams;

  // Build the list of months the user has receipts in (plus the current one).
  const { data: monthRows } = await supabase
    .from("receipts")
    .select("month_key")
    .not("month_key", "is", null);
  const monthSet = new Set<string>([currentMonthKey()]);
  (monthRows ?? []).forEach((r) => r.month_key && monthSet.add(r.month_key));
  const months = Array.from(monthSet).sort().reverse();

  const selected = month && monthSet.has(month) ? month : months[0];

  const { data } = await supabase
    .from("receipts")
    .select("*, categories(name)")
    .eq("month_key", selected)
    .order("receipt_date", { ascending: false, nullsFirst: false });

  const rows = (data ?? []) as Row[];
  const reimbursableTotal = rows
    .filter((r) => r.reimbursable)
    .reduce((s, r) => s + Number(r.ttd_amount ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Receipts"
        subtitle={`${rows.length} item${rows.length === 1 ? "" : "s"} · Reimbursable ${formatTTD(reimbursableTotal)}`}
        action={
          <Link
            href="/upload"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Upload
          </Link>
        }
      />

      <div className="mb-4">
        <MonthSelect months={months} current={selected} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          No receipts for {formatMonthKey(selected)}.{" "}
          <Link href="/upload" className="font-medium text-slate-900 underline">
            Upload some
          </Link>
          .
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3 font-semibold">Date</th>
                <th className="px-4 py-3 font-semibold">Vendor</th>
                <th className="px-4 py-3 font-semibold">Category</th>
                <th className="px-4 py-3 font-semibold">Payment</th>
                <th className="px-4 py-3 text-right font-semibold">Amount</th>
                <th className="px-4 py-3 text-right font-semibold">TTD</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {r.receipt_date ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-medium text-slate-900">
                    {r.vendor_name ?? "Unknown"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {r.categories?.name ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">
                    {PAYMENT_LABEL[r.payment_method]}
                    {r.card_last4 ? ` ••${r.card_last4}` : ""}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-slate-600">
                    {r.amount != null
                      ? `${r.currency} ${Number(r.amount).toFixed(2)}`
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-slate-900">
                    {r.ttd_amount != null ? formatTTD(r.ttd_amount) : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/receipts/${r.id}`}
                      className="text-sm font-medium text-slate-900 underline"
                    >
                      Edit
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
