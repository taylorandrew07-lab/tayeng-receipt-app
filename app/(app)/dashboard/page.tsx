import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatCard } from "@/components/ui";
import { currentMonthKey, formatMonthKey, formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";

type Row = Pick<
  Receipt,
  | "id"
  | "status"
  | "reimbursable"
  | "paid"
  | "payment_method"
  | "ttd_amount"
  | "month_key"
>;

export default async function DashboardPage() {
  const supabase = await createClient();
  const monthKey = currentMonthKey();

  // All receipts (excluding flagged duplicates). Outstanding/paid accumulate
  // across months — they're about money owed/handled, not a single month.
  const { data } = await supabase
    .from("receipts")
    .select("id, status, reimbursable, paid, payment_method, ttd_amount, month_key")
    .is("duplicate_of", null);
  const rows = (data ?? []) as Row[];

  // Which receipts are confirmed-matched to a statement (referenced)?
  const { data: matched } = await supabase
    .from("receipt_statement_matches")
    .select("receipt_id")
    .eq("confirmed", true);
  const referenced = new Set(
    (matched ?? []).map((m) => m.receipt_id).filter(Boolean) as string[]
  );

  const ttd = (r: Row) => Number(r.ttd_amount ?? 0);

  const reimb = rows.filter((r) => r.reimbursable);
  const outstandingTotal = reimb.filter((r) => !r.paid).reduce((s, r) => s + ttd(r), 0);
  const outstandingCount = reimb.filter((r) => !r.paid).length;
  const paidTotal = reimb.filter((r) => r.paid).reduce((s, r) => s + ttd(r), 0);

  const company = rows.filter((r) => r.payment_method === "company_card");
  const companyTotal = company.reduce((s, r) => s + ttd(r), 0);
  const companyNeedRef = company.filter((r) => !referenced.has(r.id));
  const companyNeedRefCount = companyNeedRef.length;

  const needsReview = rows.filter((r) => r.status === "needs_review").length;
  const thisMonthCount = rows.filter((r) => r.month_key === monthKey).length;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Outstanding totals across all months · ${thisMonthCount} uploaded in ${formatMonthKey(monthKey)}`}
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
          label="Reimbursable outstanding"
          value={formatTTD(outstandingTotal)}
          tone={outstandingTotal > 0 ? "good" : "default"}
          hint={`${outstandingCount} not yet paid · tap to view`}
          href="/receipts?month=all&kind=reimbursable&paid=unpaid"
        />
        <StatCard
          label="Reimbursed (paid)"
          value={formatTTD(paidTotal)}
          hint="Already paid out"
          href="/receipts?month=all&kind=reimbursable&paid=paid"
        />
        <StatCard
          label="Company card"
          value={formatTTD(companyTotal)}
          tone={companyNeedRefCount > 0 ? "warn" : "default"}
          hint={
            companyNeedRefCount > 0
              ? `${companyNeedRefCount} need statement referencing`
              : "All referenced to statements"
          }
          href="/receipts?month=all&kind=company"
        />
        <StatCard
          label="Needs review"
          value={String(needsReview)}
          tone={needsReview > 0 ? "warn" : "default"}
          hint={needsReview > 0 ? "Action needed" : "All clear"}
          href="/review"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <QuickLink
          href="/receipts?month=all&kind=reimbursable&paid=unpaid"
          title="Clear paid reimbursements"
          body="Got reimbursed? Open your unpaid reimbursables, select all, and mark them paid — they'll drop off your outstanding total."
        />
        <QuickLink
          href="/matching"
          title="Reference company card"
          body={
            companyNeedRefCount > 0
              ? `${companyNeedRefCount} company-card receipt${companyNeedRefCount === 1 ? "" : "s"} still need matching to a statement.`
              : "All company-card receipts are referenced to a statement."
          }
        />
        <QuickLink
          href="/reports"
          title="Monthly report"
          body="Generate a reimbursable or company-card PDF with totals and receipt copies."
        />
      </div>
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
