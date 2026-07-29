import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { formatTTD } from "@/lib/month";
import { loadCloseOut } from "@/lib/reconciliation/board-data";
import type { ChargeRow, OrphanRow } from "@/lib/reconciliation/types";
import { AttachReceipt } from "@/components/matching/attach-receipt";

export const dynamic = "force-dynamic";

function daysOpen(date: string | null): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show = "open" } = await searchParams;
  const supabase = await createClient();
  const d = await loadCloseOut(supabase);
  const t = d.totals;

  const inflated = t.rawLineTotal - t.spendTotal;

  return (
    <div>
      <PageHeader
        title="Close-Out"
        subtitle={
          d.statements.length
            ? `${d.statements.length} statements · ${d.statements
                .map((s) => s.file_name.replace(/\.pdf$/i, ""))
                .join(", ")}`
            : "No statements uploaded yet."
        }
      />

      {/* The one number that matters */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-bold text-slate-900">{t.openCount} open</span>
          <span className="text-xl font-semibold text-slate-500">
            {formatTTD(t.openValue)}
          </span>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{
              width: `${t.totalCount ? Math.round((t.closedCount / t.totalCount) * 100) : 0}%`,
            }}
          />
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Closed {t.closedCount} of {t.totalCount} · total spend {formatTTD(t.spendTotal)}
        </p>
        {inflated > 0.005 && (
          <p className="mt-1 text-xs text-slate-400">
            Your statements list {formatTTD(t.rawLineTotal)} of lines, but{" "}
            {formatTTD(inflated)} of that is the same charges repeated on overlapping
            statements. Each one is counted once here.
          </p>
        )}
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
          Statement totals not yet read from the PDFs — this list can&apos;t yet prove every
          line was captured.
        </p>
      </div>

      <nav className="mt-5 flex flex-wrap gap-2">
        <Chip href="/reconcile?show=open" active={show === "open"}>
          All open ({t.openCount})
        </Chip>
        <Chip href="/reconcile?show=needs" active={show === "needs"}>
          Needs a receipt ({d.needsReceipt.length})
        </Chip>
        <Chip href="/reconcile?show=suggested" active={show === "suggested"}>
          Suggested ({d.needsConfirmation.length})
        </Chip>
        <Chip href="/reconcile?show=orphans" active={show === "orphans"}>
          No statement line ({d.orphansOpen.length})
        </Chip>
        <Chip href="/reconcile?show=done" active={show === "done"}>
          Done ({d.readyToSend.length + d.alreadySent.length})
        </Chip>
      </nav>

      {(show === "open" || show === "needs") && (
        <Section
          title="Needs a receipt"
          note="No receipt anywhere for these. This is the list to work down."
          count={d.needsReceipt.length}
        >
          {d.needsReceipt.map((c) => (
            <ChargeItem key={c.charge_id} c={c} attachable={d.attachable} />
          ))}
        </Section>
      )}

      {(show === "open" || show === "suggested") && d.needsConfirmation.length > 0 && (
        <Section
          title="Suggested — needs your confirmation"
          note="The matcher found a likely receipt. Check it on the Matching page."
          count={d.needsConfirmation.length}
        >
          {d.needsConfirmation.map((c) => (
            <ChargeItem key={c.charge_id} c={c} attachable={d.attachable} />
          ))}
        </Section>
      )}

      {(show === "open" || show === "orphans") && (
        <Section
          title="Receipts with no statement line"
          note="These appear on no statement — cash, another card, or the statement isn't uploaded yet. They still go to the accountant."
          count={d.orphansOpen.length}
          value={t.orphanOpenValue}
        >
          {d.orphansOpen.map((o) => (
            <OrphanItem key={o.receipt_id} o={o} latestEnd={d.statements[0]?.effective_end} />
          ))}
        </Section>
      )}

      {show === "done" && (
        <>
          <Section
            title="Matched — ready to send"
            note="A receipt is attached but you haven't sent it to the accountant yet."
            count={d.readyToSend.length}
          >
            {d.readyToSend.map((c) => (
              <ChargeItem key={c.charge_id} c={c} attachable={d.attachable} />
            ))}
          </Section>
          <Section title="Already sent — nothing to do" count={d.alreadySent.length}>
            {d.alreadySent.map((c) => (
              <ChargeItem key={c.charge_id} c={c} attachable={d.attachable} />
            ))}
          </Section>
        </>
      )}

      {/* Always present, never a filter: real money, nothing to chase. */}
      {d.bankCharges.length > 0 && (
        <details className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            🏦 Bank charges — nothing to chase · {d.bankCharges.length} ·{" "}
            {formatTTD(t.bankChargesValue)}
          </summary>
          <ul className="mt-3 space-y-1">
            {d.bankCharges.map((c) => (
              <li
                key={c.charge_id}
                className="flex items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm"
              >
                <span className="text-slate-700">{c.description ?? "—"}</span>
                <span className="whitespace-nowrap text-slate-500">
                  {c.txn_date ?? "—"} · {formatTTD(Number(c.amount ?? 0))}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            Fees and interest are taken off the work list automatically. If something here
            does need a receipt, tell me and I&apos;ll add a one-tap way to put it back.
          </p>
        </details>
      )}

      {t.openCount === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-10 text-center">
          <p className="text-lg font-semibold text-emerald-900">Nothing outstanding.</p>
          <p className="mt-1 text-sm text-emerald-800">
            Every charge has a receipt and every receipt is accounted for.
          </p>
        </div>
      )}
    </div>
  );
}

function ChargeItem({
  c,
  attachable,
}: {
  c: ChargeRow;
  attachable: { id: string; vendor_name: string | null; ttd_amount: number | null; receipt_date: string | null }[];
}) {
  const age = daysOpen(c.txn_date);
  const open = c.state === "genuinely_new" || c.state === "needs_confirmation";

  return (
    <li className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-slate-900">{c.description ?? "—"}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>{c.txn_date ?? "no date"}</span>
            {age != null && age > 0 && <span>· open {age} days</span>}
            {c.copies > 1 && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                on {c.copies} statements · counted once
              </span>
            )}
            {c.receipt_vendor && (
              <Link
                href={c.receipt_id ? `/receipts/${c.receipt_id}` : "#"}
                className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-800 underline"
              >
                {c.receipt_vendor}
                {c.receipt_sent ? " · sent" : ""} ↗
              </Link>
            )}
            {c.state === "needs_confirmation" && c.best_confidence != null && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                {c.best_confidence}% suggestion
              </span>
            )}
          </p>
        </div>
        <span className="whitespace-nowrap text-base font-semibold text-slate-900">
          {formatTTD(Number(c.amount ?? 0))}
        </span>
      </div>
      {open && (
        <div className="mt-2 flex justify-end">
          <AttachReceipt
            txnId={c.canonical_txn_id}
            txnAmount={c.amount != null ? Number(c.amount) : null}
            receipts={attachable}
          />
        </div>
      )}
    </li>
  );
}

function OrphanItem({ o, latestEnd }: { o: OrphanRow; latestEnd?: string }) {
  const afterPeriod =
    o.receipt_date && latestEnd ? o.receipt_date > latestEnd : false;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
      <div className="min-w-0 flex-1">
        <Link href={`/receipts/${o.receipt_id}`} className="font-medium text-slate-900 underline">
          {o.vendor_name ?? "Unknown"}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>{o.receipt_date ?? "no date"}</span>
          {o.currency !== "TTD" && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
              {o.currency} {Number(o.amount ?? 0).toFixed(2)}
            </span>
          )}
          {afterPeriod && (
            <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-800">
              after the latest statement — likely on the next one
            </span>
          )}
          {o.possible_duplicate_upload && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
              possible duplicate upload
            </span>
          )}
        </p>
      </div>
      <span className="whitespace-nowrap text-base font-semibold text-slate-900">
        {o.ttd_amount != null ? formatTTD(Number(o.ttd_amount)) : "—"}
      </span>
    </li>
  );
}

function Section({
  title,
  note,
  count,
  value,
  children,
}: {
  title: string;
  note?: string;
  count: number;
  value?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="font-semibold text-slate-900">
        {title}{" "}
        <span className="font-normal text-slate-400">
          ({count}
          {value != null ? ` · ${formatTTD(value)}` : ""})
        </span>
      </h2>
      {note && <p className="mb-3 mt-1 text-sm text-slate-500">{note}</p>}
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
          Nothing here.
        </p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </section>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full px-3 py-1.5 text-sm font-medium ${
        active
          ? "bg-slate-900 text-white"
          : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
      }`}
    >
      {children}
    </Link>
  );
}
