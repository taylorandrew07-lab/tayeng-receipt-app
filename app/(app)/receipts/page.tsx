import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
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
  // Paginated, with a unique tiebreak: an unpaged read stops SILENTLY at
  // PostgREST's 1000-row cap, and the "All months" view would simply lose the
  // oldest receipts with no sign anything was missing.
  const [rows, matchedRows] = await Promise.all([
    fetchAll<ReceiptRow>((from, to) => {
      let q = supabase
        .from("receipts")
        .select(
          "id, user_id, receipt_date, month_key, vendor_name, vendor_id, category_id, doc_type, amount, currency, ttd_amount, tax_amount, payment_method, card_id, card_last4, reimbursable, status, confidence, notes, duplicate_of, not_duplicate, sent, sent_at, paid, paid_at, bill_back, bill_back_type, bill_back_name, bill_back_normalized, created_at, updated_at, categories(name), receipt_files(file_name)"
        )
        .order("created_at", { ascending: false })
        .order("id", { ascending: true });
      if (selected !== "all") q = q.eq("month_key", selected);
      return asPage<ReceiptRow>(q.range(from, to));
    }),
    // Which receipts are attached to a statement charge — the one fact the
    // list could not show before ("matched, ready to send").
    fetchAll<{ receipt_id: string | null }>((from, to) =>
      asPage(
        supabase
          .from("receipt_statement_matches")
          .select("receipt_id")
          .eq("confirmed", true)
          .order("id", { ascending: true })
          .range(from, to)
      )
    ),
  ]);
  const matchedIds = matchedRows.map((m) => m.receipt_id).filter(Boolean) as string[];

  return (
    <div>
      <PageHeader
        title="Receipts"
        subtitle="Organised by when you uploaded them. Each receipt shows where it's up to — review, match, send, paid."
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
        matchedIds={matchedIds}
        months={months}
        selected={selected}
        initialKind={kind ?? "all"}
        initialPaid={paid ?? "all"}
      />
    </div>
  );
}
