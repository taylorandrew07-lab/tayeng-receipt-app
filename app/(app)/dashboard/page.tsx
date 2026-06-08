import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatCard } from "@/components/ui";
import { currentMonthKey, formatMonthKey, formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";

export default async function DashboardPage() {
  const supabase = await createClient();
  const monthKey = currentMonthKey();

  const { data: receipts } = await supabase
    .from("receipts")
    .select(
      "id, status, reimbursable, payment_method, ttd_amount, amount, currency"
    )
    .eq("month_key", monthKey);

  const rows = (receipts ?? []) as Pick<
    Receipt,
    "id" | "status" | "reimbursable" | "payment_method" | "ttd_amount" | "amount" | "currency"
  >[];

  const ttd = (r: (typeof rows)[number]) =>
    Number(r.ttd_amount ?? (r.currency === "TTD" ? r.amount : 0) ?? 0);

  const needsReview = rows.filter((r) => r.status === "needs_review").length;
  const reimbursableTotal = rows
    .filter((r) => r.reimbursable === true)
    .reduce((s, r) => s + ttd(r), 0);
  const companyCardTotal = rows
    .filter((r) => r.payment_method === "company_card")
    .reduce((s, r) => s + ttd(r), 0);
  const cashTotal = rows
    .filter((r) => r.payment_method === "cash")
    .reduce((s, r) => s + ttd(r), 0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Your workspace for ${formatMonthKey(monthKey)}`}
        action={
          <Link
            href="/upload"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Upload receipts
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Receipts this month"
          value={String(rows.length)}
          hint={formatMonthKey(monthKey)}
          href="/receipts"
        />
        <StatCard
          label="Needs review"
          value={String(needsReview)}
          tone={needsReview > 0 ? "warn" : "default"}
          hint={needsReview > 0 ? "Action needed" : "All clear"}
          href="/review"
        />
        <StatCard
          label="Reimbursable"
          value={formatTTD(reimbursableTotal)}
          tone="good"
          hint="Tap to see all reimbursable"
          href="/receipts?month=all&kind=reimbursable"
        />
        <StatCard
          label="Company card"
          value={formatTTD(companyCardTotal)}
          hint="Tap to see all company card"
          href="/receipts?month=all&kind=company"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <QuickLink
          href="/upload"
          title="Upload documents"
          body="Add receipts, invoices, or statement PDFs. Batch upload and phone camera supported."
        />
        <QuickLink
          href="/review"
          title="Needs Review"
          body={
            needsReview > 0
              ? `${needsReview} item${needsReview === 1 ? "" : "s"} waiting for your confirmation.`
              : "Nothing waiting. Uncertain items will appear here."
          }
        />
        <QuickLink
          href="/reports"
          title="Monthly report"
          body="Generate a PDF summary with a detailed table and receipt images."
        />
      </div>

      {cashTotal > 0 && (
        <p className="mt-6 text-sm text-slate-500">
          Cash expenses this month: {formatTTD(cashTotal)}
        </p>
      )}
    </div>
  );
}

function QuickLink({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-slate-300 hover:shadow"
    >
      <p className="font-semibold text-slate-900">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{body}</p>
    </Link>
  );
}
