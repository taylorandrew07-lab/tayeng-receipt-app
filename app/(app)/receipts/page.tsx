import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReceiptsTable, type ReceiptRow } from "@/components/receipts/receipts-table";
import { currentMonthKey } from "@/lib/month";

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; kind?: string; paid?: string }>;
}) {
  const supabase = await createClient();
  const { month, kind, paid } = await searchParams;

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

  // Explicit columns (every field the table uses) so we never ship the heavy
  // raw_extraction JSON blob down to the page.
  let query = supabase
    .from("receipts")
    .select(
      "id, user_id, receipt_date, month_key, vendor_name, vendor_id, category_id, doc_type, amount, currency, ttd_amount, tax_amount, payment_method, card_id, card_last4, reimbursable, status, confidence, notes, duplicate_of, not_duplicate, sent, sent_at, paid, paid_at, bill_back, bill_back_type, bill_back_name, bill_back_normalized, created_at, updated_at, categories(name), receipt_files(file_name)"
    )
    .order("created_at", { ascending: false });
  if (selected !== "all") query = query.eq("month_key", selected);

  const { data } = await query;
  const rows = (data ?? []) as unknown as ReceiptRow[];

  return (
    <div>
      <PageHeader
        title="Receipts"
        subtitle="Organised by when you uploaded them. Confirmed items are greyed out as done."
        action={
          <Link
            href="/upload"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
          >
            Upload
          </Link>
        }
      />
      <ReceiptsTable
        rows={rows}
        months={months}
        selected={selected}
        initialKind={kind ?? "all"}
        initialPaid={paid ?? "all"}
      />
    </div>
  );
}
