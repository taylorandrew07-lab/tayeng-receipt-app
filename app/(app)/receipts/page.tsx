import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReceiptsTable, type ReceiptRow } from "@/components/receipts/receipts-table";
import { currentMonthKey } from "@/lib/month";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const supabase = await createClient();
  const { month } = await searchParams;

  // Months are based on UPLOAD date (month_key is set to the upload month).
  const { data: monthRows } = await supabase
    .from("receipts")
    .select("month_key")
    .not("month_key", "is", null);
  const monthSet = new Set<string>();
  (monthRows ?? []).forEach((r) => r.month_key && monthSet.add(r.month_key));
  const months = Array.from(monthSet).sort().reverse();

  const selected =
    month === "all"
      ? "all"
      : month && monthSet.has(month)
        ? month
        : months.includes(currentMonthKey())
          ? currentMonthKey()
          : (months[0] ?? "all");

  let query = supabase
    .from("receipts")
    .select("*, categories(name), receipt_files(file_name)")
    .order("created_at", { ascending: false });
  if (selected !== "all") query = query.eq("month_key", selected);

  const { data } = await query;
  const rows = (data ?? []) as ReceiptRow[];

  return (
    <div>
      <PageHeader
        title="Receipts"
        subtitle="Organised by when you uploaded them. Confirmed items are greyed out as done."
        action={
          <Link
            href="/upload"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Upload
          </Link>
        }
      />
      <ReceiptsTable rows={rows} months={months} selected={selected} />
    </div>
  );
}
