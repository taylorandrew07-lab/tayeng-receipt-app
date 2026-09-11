import Link from "next/link";
import { PageHeader } from "@/components/ui";
import { formatMoney, formatTTD } from "@/lib/month";
import { completenessOf } from "@/lib/reports/completeness";
import { closeOutAppendix } from "@/lib/reports/closeout-appendix";
import { slicePart } from "@/lib/reports/parts";
import type {
  CloseOutData,
  ChargeRow,
  OrphanRow,
  StatementCoverageRow,
} from "@/lib/reconciliation/types";
import { AttachReceipt } from "@/components/matching/attach-receipt";
import { RunMatchingButton } from "@/components/reconcile/run-matching-button";
import { ChargeDecision } from "@/components/reconcile/charge-decision";

function daysOpen(date: string | null): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/**
 * The close-out screen, drawn from already-loaded data.
 *
 * Kept separate from the page (which only loads) so the screen can be
 * rendered and checked with any data — including at phone width — without a
 * signed-in session.
 */
export function CloseOutView({ d, show = "open" }: { d: CloseOutData; show?: string }) {
  const t = d.totals;

  const inflated = t.rawLineTotal - t.spendTotal;
  // One button per PDF part, from the same list the route slices — so the
  // buttons and the parts can never disagree.
  const appendixItems = closeOutAppendix(d);
  const { parts } = slicePart(appendixItems, "1");
  const docCount = appendixItems.length;

  return (
    <div>
      <PageHeader
        title="Close-Out"
        subtitle={
          d.statements.length
            ? `${d.statements.length} statement${d.statements.length === 1 ? "" : "s"} · ${dateRange(
                d.statements
              )}`
            : "No statements uploaded yet."
        }
        action={
          // Two actions, one of them primary. The PDFs are an end-of-cycle
          // job and live in their own card below, not in the header.
          <>
            <RunMatchingButton />
            <Link
              href="/reconcile/board"
              role="button"
              className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              Match them up →
            </Link>
          </>
        }
      />

      {/* The one number that matters */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-bold tracking-tight text-slate-900">
            {t.openCount === 0 ? "All closed" : `${t.openCount} open`}
          </span>
          {t.openCount > 0 && (
            <span className="text-xl font-semibold text-slate-500">
              {formatTTD(t.openValue)}
            </span>
          )}
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
          {/* scaleX, not width: transform animates off the main thread. */}
          <div
            className="h-full w-full origin-left rounded-full bg-emerald-500 transition-transform duration-300 ease-out"
            style={{
              transform: `scaleX(${t.totalCount ? t.closedCount / t.totalCount : 0})`,
            }}
          />
        </div>
        <p className="mt-2 text-sm text-slate-500">
          {t.closedCount} of {t.totalCount} closed · total spend {formatTTD(t.spendTotal)}
        </p>
        {inflated > 0.005 && (
          <p className="mt-1 text-xs text-slate-400">
            {formatTTD(inflated)} of statement lines are repeats from overlapping statements —
            each charge is counted once.
          </p>
        )}
        <ControlTotal
          statements={d.statements}
          proven={t.statementsProven}
          failing={t.statementsFailing}
          names={t.failingNames}
        />
        {/* Never folded into a TTD total — shown in their own currency. */}
        {t.foreignCharges.length > 0 && (
          <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
            Not included in the totals above, because they are not in TTD:{" "}
            {t.foreignCharges
              .map((f) => `${f.count} charge${f.count === 1 ? "" : "s"} · ${formatMoney(f.total, f.currency)}`)
              .join(", ")}
            .
          </p>
        )}
      </div>

      <AccountantPdf docs={docCount} parts={parts} />

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

      {((show === "open" && t.openCount > 0) || show === "needs") && (
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

      {((show === "open" && t.openCount > 0) || show === "orphans") && (
        <Section
          title="Receipts with no statement line"
          note="These appear on no statement — cash, another card, or the statement isn't uploaded yet. They still go to the accountant."
          count={d.orphansOpen.length}
          value={t.orphanOpenValue}
        >
          {d.orphansOpen.map((o) => (
            <OrphanItem
              key={o.receipt_id}
              o={o}
              latestEnd={d.statements[0]?.effective_end}
              earliestStart={
                d.statements.length
                  ? d.statements.reduce(
                      (min, s) => (s.effective_start < min ? s.effective_start : min),
                      d.statements[0].effective_start
                    )
                  : undefined
              }
            />
          ))}
        </Section>
      )}

      {/* Paid by cash or personal card — never on a card statement. */}
      {t.reimbursableCount > 0 && (
        <div className="mt-6 rounded-xl border border-sky-200 bg-sky-50 p-4">
          <p className="text-sm font-semibold text-sky-900">
            {t.reimbursableCount} receipts you paid for yourself ·{" "}
            {formatTTD(t.reimbursableValue)}
          </p>
          <p className="mt-1 text-sm text-sky-800">
            Cash and personal-card receipts never appear on a company card statement, so
            they are not part of closing out the statements. You claim these back through
            the reimbursable report instead.
          </p>
          <Link
            href="/reports"
            className="mt-2 inline-block text-sm font-medium text-sky-900 underline"
          >
            Go to the reimbursable report →
          </Link>
        </div>
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
                className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 text-slate-700">{c.description ?? "—"}</span>
                <span className="whitespace-nowrap text-slate-500">
                  {c.txn_date ?? "—"} · {formatMoney(Number(c.amount ?? 0), c.currency)}
                </span>
                <ChargeDecision chargeId={c.charge_id} close={false} label="Reopen" />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            Fees and interest are taken off the work list automatically. If one of these does
            need a receipt, tap Reopen and it goes back on your list.
          </p>
        </details>
      )}

      {/* Real purchases YOU closed without a receipt. Same database flag as the
          bank charges above, completely different meaning — so never shown in
          the same list, and never sent to the accountant as a bank fee. */}
      {d.clearedByHand.length > 0 && (
        <details className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            ✓ Closed off by you — no receipt needed · {d.clearedByHand.length} ·{" "}
            {formatTTD(t.clearedByHandValue)}
          </summary>
          <ul className="mt-3 space-y-1">
            {d.clearedByHand.map((c) => (
              <li
                key={c.charge_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm"
              >
                <span className="min-w-0 flex-1 text-slate-700">{c.description ?? "—"}</span>
                <span className="whitespace-nowrap text-slate-500">
                  {c.txn_date ?? "—"} · {formatMoney(Number(c.amount ?? 0), c.currency)}
                </span>
                <ChargeDecision chargeId={c.charge_id} close={false} label="Reopen" />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">
            These are real purchases you decided to close without chasing paperwork. They
            are kept here for your own records and are <strong>not</strong> included in the
            close-out PDF you give the accountant.
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

/**
 * Can this list prove it is complete?
 *
 * Until 0022 the app had no answer: it read transactions and nothing else, so a
 * line the parser skipped looked exactly like a line that was never there. Now
 * each statement carries its own printed purchases total and the extracted
 * lines are checked against it.
 *
 * Three states, deliberately distinct — "we did not check" must never read as
 * "we checked and it was fine".
 */
function ControlTotal({
  statements,
  proven,
  failing,
  names,
}: {
  statements: StatementCoverageRow[];
  proven: number;
  failing: number;
  names: string[];
}) {
  if (statements.length === 0) return null;
  const n = statements.length;

  // Per-statement detail, worded exactly as the PDF words it
  // (lib/reports/completeness). Folded away unless something actually FAILED —
  // five identical "not read" lines said nothing five times.
  const detail = (
    <ul className="mt-1.5 space-y-0.5">
      {statements.map((s) => (
        <li key={s.id}>
          <span className="font-medium">{s.file_name.replace(/\.pdf$/i, "")}</span> —{" "}
          {completenessOf(s).label}
        </li>
      ))}
    </ul>
  );
  const fix = (
    <Link href="/statements" className="font-semibold underline">
      Go to your statements →
    </Link>
  );

  if (failing > 0) {
    return (
      <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
        <p>
          <strong>
            {failing} statement{failing === 1 ? " doesn't" : "s don't"} add up
          </strong>{" "}
          — {names.map((x) => x.replace(/\.pdf$/i, "")).join(", ")}. A line was missed or
          misread, so don&apos;t rely on this list until {failing === 1 ? "it's" : "they're"}{" "}
          fixed. {fix}
        </p>
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer select-none">All statements</summary>
          {detail}
        </details>
      </div>
    );
  }

  if (proven === n) {
    return (
      <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        ✓ Every statement adds up to the totals printed on it, to the cent.
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <p>
        {proven === 0 ? (
          <>
            <strong>Not yet proven complete.</strong>{" "}
            The printed totals haven&apos;t been read
            from {n === 1 ? "your statement" : `any of your ${n} statements`} yet — open each
            one and tap <em>Read this statement again</em>.
          </>
        ) : (
          <>
            <strong>
              {proven} of {n} statements proven complete.
            </strong>{" "}
            The other {n - proven}{" "}
            haven&apos;t had their printed totals read yet.
          </>
        )}{" "}
        {fix}
      </p>
      {proven > 0 && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer select-none">Which statements?</summary>
          {detail}
        </details>
      )}
    </div>
  );
}

/**
 * The close-out PDF for the accountant: an end-of-cycle job, so it sits in
 * its own quiet card rather than as a row of big buttons in the header.
 */
function AccountantPdf({ docs, parts }: { docs: number; parts: number }) {
  return (
    <section className="mt-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-semibold text-slate-900">Close-out PDF for the accountant</p>
        <p className="mt-0.5 text-sm text-slate-500">
          {docs} receipt document{docs === 1 ? "" : "s"}
          {parts > 1
            ? ` — in ${parts} parts, so each one downloads in time. Part 1 has the summary.`
            : " included."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {Array.from({ length: parts }, (_, i) => (
          <a
            key={i}
            href={`/api/reports/closeout?part=${i + 1}`}
            role="button"
            className={`inline-flex min-h-10 items-center rounded-lg px-4 text-sm font-semibold ${
              i === 0
                ? "bg-emerald-600 text-white hover:bg-emerald-700"
                : "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50"
            }`}
          >
            {parts === 1 ? "Download PDF" : i === 0 ? "Download part 1" : `Part ${i + 1}`}
          </a>
        ))}
        <a
          href="/api/reports/closeout?appendix=none"
          className="px-2 text-sm font-medium text-slate-600 underline hover:text-slate-900"
        >
          Work list only
        </a>
      </div>
    </section>
  );
}

/** "16 Apr – 17 Aug 2026": the span the statements cover, in plain words. */
function dateRange(statements: StatementCoverageRow[]): string {
  const start = statements.reduce(
    (m, s) => (s.effective_start < m ? s.effective_start : m),
    statements[0].effective_start
  );
  const end = statements.reduce(
    (m, s) => (s.effective_end > m ? s.effective_end : m),
    statements[0].effective_end
  );
  const fmt = (iso: string, withYear: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${fmt(start, !sameYear)} – ${fmt(end, true)}`;
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
          {formatMoney(Number(c.amount ?? 0), c.currency)}
        </span>
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-start justify-end gap-2">
          <AttachReceipt
            txnId={c.canonical_txn_id}
            txnAmount={c.amount != null ? Number(c.amount) : null}
            receipts={attachable}
          />
          <ChargeDecision
            chargeId={c.charge_id}
            close
            label="No receipt needed"
            confirmText="Close this charge without a receipt? It comes off your list and stays off the accountant's report. You can reopen it any time."
          />
        </div>
      )}
    </li>
  );
}

function OrphanItem({
  o,
  latestEnd,
  earliestStart,
}: {
  o: OrphanRow;
  latestEnd?: string;
  earliestStart?: string;
}) {
  const afterPeriod =
    o.receipt_date && latestEnd ? o.receipt_date > latestEnd : false;
  // Predates every statement we hold, so no statement here could ever match it.
  const beforePeriod =
    o.receipt_date && earliestStart ? o.receipt_date < earliestStart : false;
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
          {beforePeriod && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
              older than every statement you&apos;ve uploaded
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
