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

export const maxDuration = 60;

type Txn = {
  id: string;
  txn_date: string | null;
  description: string | null;
  amount: number | null;
};

type Match = {
  statement_transaction_id: string | null;
  confirmed: boolean;
  receipts: { id: string; vendor_name: string | null } | null;
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

  const [{ data: profile }, { data: card }, { data: txnData }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    statement.card_id
      ? supabase.from("cards").select("nickname, last4").eq("id", statement.card_id).single()
      : Promise.resolve({ data: null }),
    supabase
      .from("statement_transactions")
      .select("id, txn_date, description, amount")
      .eq("statement_id", statementId)
      .order("txn_date", { ascending: true }),
  ]);

  const txns = (txnData ?? []) as Txn[];
  const txnIds = txns.map((t) => t.id);

  const { data: matchData } = txnIds.length
    ? await supabase
        .from("receipt_statement_matches")
        .select("statement_transaction_id, confirmed, receipts(id, vendor_name)")
        .in("statement_transaction_id", txnIds)
        .eq("confirmed", true)
    : { data: [] };
  const matches = (matchData ?? []) as unknown as Match[];
  const matchByTxn = new Map(
    matches
      .filter((m) => m.statement_transaction_id)
      .map((m) => [m.statement_transaction_id as string, m])
  );

  const rows: ReconRow[] = txns.map((t, i) => {
    const m = matchByTxn.get(t.id);
    return {
      n: i + 1,
      date: t.txn_date ?? "—",
      description: t.description ?? "—",
      amount: t.amount != null ? formatTTD(Number(t.amount)) : "—",
      matched: Boolean(m),
      receipt: m?.receipts?.vendor_name ?? "",
    };
  });

  const matchedTxns = txns.filter((t) => matchByTxn.has(t.id));
  const missingTxns = txns.filter((t) => !matchByTxn.has(t.id));
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
  const items = txns
    .map((t, i) => ({ i, m: matchByTxn.get(t.id) }))
    .filter(({ m }) => m?.receipts?.id)
    .map(({ i, m }) => ({
      receiptId: m!.receipts!.id,
      label: `Txn #${i + 1} · ${m!.receipts!.vendor_name ?? "Receipt"}`,
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
