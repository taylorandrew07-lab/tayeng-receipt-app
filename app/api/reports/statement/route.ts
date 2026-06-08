import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import {
  StatementReportDocument,
  type ReconRow,
} from "@/lib/reports/statement-report-document";
import { formatTTD } from "@/lib/month";
import { getApprovedUser } from "@/lib/auth/guard";

export const maxDuration = 60;

const MAX_EMBED_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_PER_RECEIPT = 20;
const A4: [number, number] = [595.28, 841.89];

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

  // Append the matched receipts' documents after the reconciliation table.
  const merged = await PDFDocument.load(coverBytes);
  const labelFont = await merged.embedFont(StandardFonts.Helvetica);
  const drawLabel = (page: import("pdf-lib").PDFPage, text: string) => {
    const size = 9;
    const w = labelFont.widthOfTextAtSize(text, size) + 8;
    const y = page.getHeight() - 16;
    page.drawRectangle({ x: 4, y: y - 3, width: w, height: size + 6, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(text, { x: 8, y, size, font: labelFont, color: rgb(0.06, 0.09, 0.16) });
  };

  for (let i = 0; i < txns.length; i++) {
    const t = txns[i];
    const m = matchByTxn.get(t.id);
    if (!m?.receipts?.id) continue;
    const label = `Txn #${i + 1} · ${m.receipts.vendor_name ?? "Receipt"}`;

    try {
      const { data: file } = await supabase
        .from("receipt_files")
        .select("storage_path, mime_type, file_name")
        .eq("receipt_id", m.receipts.id)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (!file) {
        drawLabel(merged.addPage(A4), `${label} — no file`);
        continue;
      }
      const { data: blob } = await supabase.storage.from("documents").download(file.storage_path);
      if (!blob || blob.size > MAX_EMBED_BYTES) {
        drawLabel(merged.addPage(A4), `${label} — file unavailable or too large`);
        continue;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const name = (file.file_name ?? "").toLowerCase();
      const mime = (file.mime_type ?? "").toLowerCase();
      const isPng = mime.includes("png") || name.endsWith(".png");
      const isJpg = mime.includes("jpeg") || /\.jpe?g$/.test(name);
      const isPdf = mime.includes("pdf") || name.endsWith(".pdf");

      if (isPdf) {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const indices = src.getPageIndices().slice(0, MAX_PAGES_PER_RECEIPT);
        const pages = await merged.copyPages(src, indices);
        pages.forEach((p, idx) => {
          merged.addPage(p);
          if (idx === 0) drawLabel(p, label);
        });
      } else if (isJpg || isPng) {
        const img = isPng ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
        const page = merged.addPage(A4);
        const margin = 28;
        const scale = Math.min((A4[0] - margin * 2) / img.width, (A4[1] - margin * 2 - 20) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2 - 10, width: w, height: h });
        drawLabel(page, label);
      } else {
        drawLabel(merged.addPage(A4), `${label} — unsupported file`);
      }
    } catch {
      drawLabel(merged.addPage(A4), `${label} — could not be embedded`);
    }
  }

  const pdf = await merged.save();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="statement-reconciliation.pdf"`,
    },
  });
}
