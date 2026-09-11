import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatCard } from "@/components/ui";
import { currentMonthKey, formatMonthKey, formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";

type Row = Pick<
  Receipt,
  | "id"
  | "status"
  | "reimbursable"
  | "paid" | "sent"
  | "payment_method"
  | "ttd_amount"
  | "month_key"
>;

export default async function DashboardPage() {
  const supabase = await createClient();
  const monthKey = currentMonthKey();

  // All receipts (excluding flagged duplicates) plus which are confirmed-matched
  // to a statement (referenced). Outstanding/paid accumulate across months —
  // they're about money owed/handled, not a single month. Fetched in parallel.
  // Paginated with a total order: these reads were unbounded, so past
  // PostgREST's silent 1000-row cap every total on this page would quietly
  // have stopped counting.
  const [rows, matched] = await Promise.all([
    fetchAll<Row>((from, to) =>
      asPage<Row>(
        supabase
          .from("receipts")
          .select("id, status, reimbursable, paid, sent, payment_method, ttd_amount, month_key")
          .is("duplicate_of", null)
          .order("id", { ascending: true })
          .range(from, to)
      )
    ),
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

  const referenced = new Set(matched.map((m) => m.receipt_id).filter(Boolean) as string[]);

  const ttd = (r: Row) => Number(r.ttd_amount ?? 0);

  const reimb = rows.filter((r) => r.reimbursable);
  const outstandingTotal = reimb.filter((r) => !r.paid).reduce((s, r) => s + ttd(r), 0);
  const outstandingCount = reimb.filter((r) => !r.paid).length;
  const paidTotal = reimb.filter((r) => r.paid).reduce((s, r) => s + ttd(r), 0);

  const company = rows.filter((r) => r.payment_method === "company_card");
  const companyTotal = company.reduce((s, r) => s + ttd(r), 0);
  // Still open = no statement line AND not yet sent to the accountant — the
  // same test the Close-Out list uses. Ignoring `sent` made this card say "14
  // need statement referencing" for receipts already sent (as "no statement
  // line") on 9 Sep, while Close-Out correctly said nothing was open.
  const companyNeedRef = company.filter(
    (r) => r.status === "confirmed" && !referenced.has(r.id) && !r.sent
  );
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
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 active:scale-[0.98]"
          >
            Upload receipts
          </Link>
        }
      />

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
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
              : "Nothing left to reference"
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

      <div className="stagger mt-6 grid gap-4 lg:grid-cols-3">
        <QuickLink
          href="/receipts?month=all&kind=reimbursable&paid=unpaid"
          title="Clear paid reimbursements"
          body="Got reimbursed? Open your unpaid reimbursables, select all, and mark them paid — they'll drop off your outstanding total."
        />
        <QuickLink
          href="/reconcile"
          title="Close out company card"
          body={
            companyNeedRefCount > 0
              ? `${companyNeedRefCount} company-card receipt${companyNeedRefCount === 1 ? "" : "s"} still need matching to a statement.`
              : "Every company-card receipt is matched or already sent to the accountant."
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
      className="group rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition duration-200 ease-out hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_28px_rgba(15,23,42,0.08)]"
    >
      <p className="font-semibold text-slate-900">
        {title}
        <span className="ml-1 inline-block text-slate-300 transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </p>
      <p className="mt-1 text-sm leading-relaxed text-slate-500">{body}</p>
    </Link>
  );
}
