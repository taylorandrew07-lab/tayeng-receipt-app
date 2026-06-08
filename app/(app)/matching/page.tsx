import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { runMatching, confirmMatch, rejectMatch } from "@/lib/matching/actions";
import { formatTTD } from "@/lib/month";
import type { Receipt, Statement, StatementTransaction } from "@/lib/types";

type MatchRow = {
  id: string;
  status: string;
  confidence: number | null;
  confirmed: boolean;
  receipt_id: string | null;
  statement_transaction_id: string | null;
  receipts: Pick<
    Receipt,
    "vendor_name" | "ttd_amount" | "receipt_date" | "currency" | "amount"
  > | null;
};

export default async function MatchingPage({
  searchParams,
}: {
  searchParams: Promise<{ statement?: string }>;
}) {
  const supabase = await createClient();
  const { statement: statementId } = await searchParams;

  if (!statementId) return <StatementPicker />;

  const { data: statement } = await supabase
    .from("statements")
    .select("*")
    .eq("id", statementId)
    .single();
  if (!statement) return <StatementPicker />;
  const st = statement as Statement;

  const { data: txnData } = await supabase
    .from("statement_transactions")
    .select("*")
    .eq("statement_id", statementId)
    .order("txn_date", { ascending: true });
  const txns = (txnData ?? []) as StatementTransaction[];
  const txnIds = txns.map((t) => t.id);
  const txnById = new Map(txns.map((t) => [t.id, t]));

  const { data: matchData } = txnIds.length
    ? await supabase
        .from("receipt_statement_matches")
        .select(
          "id, status, confidence, confirmed, receipt_id, statement_transaction_id, receipts(vendor_name, ttd_amount, receipt_date, currency, amount)"
        )
        .in("statement_transaction_id", txnIds)
    : { data: [] };
  const matches = (matchData ?? []) as unknown as MatchRow[];

  const matchedTxnIds = new Set(
    matches.map((m) => m.statement_transaction_id).filter(Boolean) as string[]
  );
  const confirmed = matches.filter((m) => m.confirmed);
  const possible = matches.filter((m) => !m.confirmed);
  const missing = txns.filter((t) => !matchedTxnIds.has(t.id));

  // Receipts with no confirmed match anywhere = receipts lacking a statement line.
  const { data: confirmedAll } = await supabase
    .from("receipt_statement_matches")
    .select("receipt_id")
    .eq("confirmed", true);
  const confirmedReceiptIds = new Set(
    (confirmedAll ?? []).map((m) => m.receipt_id).filter(Boolean) as string[]
  );
  const { data: receiptData } = await supabase
    .from("receipts")
    .select("id, vendor_name, ttd_amount, receipt_date")
    .not("ttd_amount", "is", null)
    .order("receipt_date", { ascending: false });
  const unmatchedReceipts = ((receiptData ?? []) as Pick<
    Receipt,
    "id" | "vendor_name" | "ttd_amount" | "receipt_date"
  >[]).filter((r) => !confirmedReceiptIds.has(r.id));

  return (
    <div>
      <PageHeader
        title="Matching"
        subtitle={`${st.file_name} · ${txns.length} transactions`}
        action={
          <div className="flex items-center gap-3">
            <form action={runMatching}>
              <input type="hidden" name="statement_id" value={st.id} />
              <button
                type="submit"
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Run / refresh matching
              </button>
            </form>
            <a
              href={`/api/reports/statement?id=${st.id}`}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Reconciliation report
            </a>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Matched" value={confirmed.length} tone="good" />
        <Stat label="Possible" value={possible.length} tone="warn" />
        <Stat label="Missing receipt" value={missing.length} />
        <Stat label="Unmatched receipts" value={unmatchedReceipts.length} />
      </div>

      {/* Possible matches — confirm or reject */}
      {possible.length > 0 && (
        <Section title="Possible matches — please confirm">
          <ul className="space-y-3">
            {possible.map((m) => {
              const t = m.statement_transaction_id
                ? txnById.get(m.statement_transaction_id)
                : undefined;
              return (
                <li
                  key={m.id}
                  className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <SideBox title="Statement transaction">
                      <p className="font-medium text-slate-900">
                        {t?.description ?? "—"}
                      </p>
                      <p className="text-sm text-slate-500">
                        {t?.txn_date ?? "—"} ·{" "}
                        {t?.amount != null ? formatTTD(Number(t.amount)) : "—"}
                      </p>
                    </SideBox>
                    <SideBox title="Receipt">
                      <p className="font-medium text-slate-900">
                        {m.receipts?.vendor_name ?? "—"}
                      </p>
                      <p className="text-sm text-slate-500">
                        {m.receipts?.receipt_date ?? "—"} ·{" "}
                        {m.receipts?.ttd_amount != null
                          ? formatTTD(Number(m.receipts.ttd_amount))
                          : "—"}
                      </p>
                      {m.receipt_id && (
                        <Link
                          href={`/receipts/${m.receipt_id}`}
                          className="mt-1 inline-block text-xs font-medium text-slate-900 underline"
                        >
                          Open receipt ↗
                        </Link>
                      )}
                    </SideBox>
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <span className="text-xs text-slate-400">
                      {m.confidence ?? 0}% confidence
                    </span>
                    <div className="ml-auto flex gap-2">
                      <form action={confirmMatch}>
                        <input type="hidden" name="id" value={m.id} />
                        <input
                          type="hidden"
                          name="txn_id"
                          value={m.statement_transaction_id ?? ""}
                        />
                        <button className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-700">
                          Confirm
                        </button>
                      </form>
                      <form action={rejectMatch}>
                        <input type="hidden" name="id" value={m.id} />
                        <input
                          type="hidden"
                          name="txn_id"
                          value={m.statement_transaction_id ?? ""}
                        />
                        <button className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100">
                          Not a match
                        </button>
                      </form>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* Confirmed matches */}
      {confirmed.length > 0 && (
        <Section title="Matched">
          <ul className="space-y-2">
            {confirmed.map((m) => {
              const t = m.statement_transaction_id
                ? txnById.get(m.statement_transaction_id)
                : undefined;
              return (
                <li
                  key={m.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm"
                >
                  <Link
                    href={m.receipt_id ? `/receipts/${m.receipt_id}` : "#"}
                    className="min-w-0 flex-1 text-slate-900 hover:underline"
                    title="Open the receipt to verify this match"
                  >
                    {m.receipts?.vendor_name ?? "Receipt"} ↔ {t?.description ?? "Transaction"}
                  </Link>
                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap text-slate-500">
                      R {m.receipts?.ttd_amount != null ? formatTTD(Number(m.receipts.ttd_amount)) : "—"}
                      {" · "}
                      S {t?.amount != null ? formatTTD(Number(t.amount)) : "—"}
                    </span>
                    <form action={rejectMatch}>
                      <input type="hidden" name="id" value={m.id} />
                      <input
                        type="hidden"
                        name="txn_id"
                        value={m.statement_transaction_id ?? ""}
                      />
                      <button className="text-xs text-slate-400 hover:text-red-700">
                        Unmatch
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {/* Missing receipts */}
      {missing.length > 0 && (
        <Section title="Statement transactions with no receipt">
          <ul className="space-y-2">
            {missing.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm"
              >
                <span className="text-slate-900">{t.description ?? "—"}</span>
                <span className="text-slate-500">
                  {t.txn_date ?? "—"} ·{" "}
                  {t.amount != null ? formatTTD(Number(t.amount)) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Unmatched receipts */}
      {unmatchedReceipts.length > 0 && (
        <Section title="Receipts not yet matched to a statement">
          <ul className="space-y-2">
            {unmatchedReceipts.slice(0, 50).map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm"
              >
                <Link
                  href={`/receipts/${r.id}`}
                  className="font-medium text-slate-900 underline"
                >
                  {r.vendor_name ?? "Unknown"}
                </Link>
                <span className="text-slate-500">
                  {r.receipt_date ?? "—"} ·{" "}
                  {r.ttd_amount != null ? formatTTD(Number(r.ttd_amount)) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

async function StatementPicker() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("statements")
    .select("id, file_name, period_start, period_end")
    .order("created_at", { ascending: false });
  const statements = data ?? [];

  return (
    <div>
      <PageHeader
        title="Matching"
        subtitle="Pick a statement to match its transactions against your receipts."
      />
      {statements.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          Upload a statement first on the{" "}
          <Link href="/statements" className="font-medium text-slate-900 underline">
            Statements
          </Link>{" "}
          page.
        </div>
      ) : (
        <ul className="space-y-2">
          {statements.map((s) => (
            <li key={s.id}>
              <Link
                href={`/matching?statement=${s.id}`}
                className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-slate-300"
              >
                <span className="font-medium text-slate-900">{s.file_name}</span>
                <span className="text-xs text-slate-400">
                  {s.period_start && s.period_end
                    ? `${s.period_start} → ${s.period_end}`
                    : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 font-semibold text-slate-900">{title}</h2>
      {children}
    </section>
  );
}

function SideBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </p>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "warn";
}) {
  const cls =
    tone === "good" ? "text-green-700" : tone === "warn" ? "text-amber-600" : "text-slate-900";
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${cls}`}>{value}</p>
    </div>
  );
}
