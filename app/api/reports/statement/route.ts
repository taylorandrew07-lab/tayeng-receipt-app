import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import {
  StatementReportDocument,
  type ReconRow,
} from "@/lib/reports/statement-report-document";
import { appendReceiptDocuments } from "@/lib/reports/append-receipts";
import { formatTTD } from "@/lib/month";
import { getApprovedUser } from "@/lib/auth/guard";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
import { coverageLabel, isCovered, loadChargeCoverage } from "@/lib/reconciliation/coverage";

export const maxDuration = 60;

type Txn = {
  id: string;
  txn_date: string | null;
  description: string | null;
  amount: number | null;
  charge_id: string | null;
};

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!approved) return new Response("Account not approved", { status: 403 });

  const statementId = request.nextUrl.searchParams.get("id") ?? "";
  if (!statementId) return new Response("Missing statement id", { status: 400 });

  const { data: statement } = await supabase
    .from("statements")
    .select("id, file_name, period_start, period_end, card_id")
    .eq("id", statementId)
    .single();
  if (!statement) return new Response("Statement not found", { status: 404 });

  const [{ data: profile }, { data: card }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    statement.card_id
      ? supabase.from("cards").select("nickname, last4").eq("id", statement.card_id).single()
      : Promise.resolve({ data: null }),
  ]);

  // Every line, paginated, with a unique tiebreak so pages cannot overlap.
  // A report built from a failed or truncated read would look complete.
  let txns: Txn[];
  let coverage: Awaited<ReturnType<typeof loadChargeCoverage>>;
  try {
    txns = await fetchAll<Txn>((from, to) =>
      asPage<Txn>(
        supabase
          .from("statement_transactions")
          .select("id, txn_date, description, amount, charge_id")
          .eq("statement_id", statementId)
          .order("txn_date", { ascending: true, nullsFirst: false })
          .order("id", { ascending: true })
          .range(from, to)
      )
    );
    // Coverage by CHARGE. The old per-line lookup reported every charge whose
    // receipt sat on another overlapping statement's copy as "missing" — the
    // exact bug the charge model exists to fix.
    coverage = await loadChargeCoverage(supabase, txns.map((t) => t.charge_id));
  } catch (e) {
    return new Response(`Could not load this statement: ${(e as Error).message}`, { status: 500 });
  }

  const coverOf = (t: Txn) => (t.charge_id ? coverage.get(t.charge_id) : undefined);

  const rows: ReconRow[] = txns.map((t, i) => {
    const c = coverOf(t);
    return {
      n: i + 1,
      date: t.txn_date ?? "—",
      description: t.description ?? "—",
      amount: t.amount != null ? formatTTD(Number(t.amount)) : "—",
      matched: isCovered(c),
      receipt: c?.receipt_vendor ?? (isCovered(c) ? coverageLabel(c) : ""),
    };
  });

  const matchedTxns = txns.filter((t) => isCovered(coverOf(t)));
  const missingTxns = txns.filter((t) => !isCovered(coverOf(t)));
  const sum = (arr: Txn[]) => arr.reduce((a, t) => a + Number(t.amount ?? 0), 0);

  const cardLabel = card
    ? `${card.nickname}${card.last4 ? ` ••${card.last4}` : ""}`
    : "";
  const period =
    statement.period_start && statement.period_end
      ? `${statement.period_start} → ${statement.period_end}`
      : "";

  const coverBytes = await renderToBuffer(
    StatementReportDocument({
      company: profile?.company_name ?? "",
      userName: profile?.full_name ?? user.email ?? "",
      statementName: statement.file_name,
      period,
      card: cardLabel,
      rows,
      totalAmount: formatTTD(sum(txns)),
      matchedCount: matchedTxns.length,
      matchedTotal: formatTTD(sum(matchedTxns)),
      missingCount: missingTxns.length,
      missingTotal: formatTTD(sum(missingTxns)),
    })
  );

  // Append the matched receipts' documents after the reconciliation table,
  // in transaction order (only transactions that have a confirmed receipt).
  const merged = await PDFDocument.load(coverBytes);
  // One document per RECEIPT: two copies of a charge on one statement never
  // happen (0015 GUARD 1), but de-duplicating costs nothing and is explicit.
  const seen = new Set<string>();
  const items = txns
    .map((t, i) => ({ i, c: coverOf(t) }))
    .filter(({ c }) => c?.receipt_id && !seen.has(c.receipt_id) && seen.add(c.receipt_id))
    .map(({ i, c }) => ({
      receiptId: c!.receipt_id as string,
      label: `Txn #${i + 1} · ${c!.receipt_vendor ?? "Receipt"}`,
    }));
  await appendReceiptDocuments(merged, supabase, items);

  const pdf = await merged.save();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="statement-reconciliation.pdf"`,
    },
  });
}
