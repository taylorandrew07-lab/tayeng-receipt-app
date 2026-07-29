import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import { getApprovedUser } from "@/lib/auth/guard";
import { loadCloseOut } from "@/lib/reconciliation/board-data";
import {
  CloseOutReportDocument,
  type CloseOutLine,
} from "@/lib/reports/closeout-report-document";
import { appendReceiptDocuments, type ReceiptItem } from "@/lib/reports/append-receipts";
import { formatTTD } from "@/lib/month";
import type { ChargeRow, OrphanRow } from "@/lib/reconciliation/types";

export const maxDuration = 60;

// Leave headroom inside Vercel's 60s so a partial appendix still returns.
const APPENDIX_DEADLINE_MS = 42_000;
const APPENDIX_MAX_RECEIPTS = 60;

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!approved) return new Response("Account not approved", { status: 403 });

  // appendix=all (default) embeds every receipt; none = table only, always fast.
  const appendix = request.nextUrl.searchParams.get("appendix") ?? "all";

  const [{ data: profile }, d] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    loadCloseOut(supabase),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const money = (n: number) => formatTTD(n);

  // Numbering runs GLOBALLY across the whole document so a row can be quoted
  // by number, and the appendix labels use the same numbers.
  let n = 0;
  const chargeLine = (c: ChargeRow): CloseOutLine => ({
    n: ++n,
    date: c.txn_date ?? "—",
    description: c.description ?? "—",
    amount: money(Number(c.amount ?? 0)),
    statements:
      c.copies > 1
        ? `${c.statement_names.length} stmts`
        : (c.statement_names[0] ?? "—").replace(/\.pdf$/i, ""),
    receipt: c.receipt_vendor
      ? `${c.receipt_vendor}${c.receipt_date ? ` · ${c.receipt_date}` : ""}`
      : "",
  });
  const orphanLine = (o: OrphanRow): CloseOutLine => ({
    n: ++n,
    date: o.receipt_date ?? "—",
    description: o.vendor_name ?? "Unknown",
    amount: o.ttd_amount != null ? money(Number(o.ttd_amount)) : "—",
    statements: "none",
    receipt: o.currency !== "TTD" ? `${o.currency} ${Number(o.amount ?? 0).toFixed(2)}` : "",
  });

  const needsReceipt = d.needsReceipt.concat(d.needsConfirmation).map(chargeLine);
  const orphanRows = d.orphansOpen.map(orphanLine);
  const matchedRows = d.readyToSend.map(chargeLine);
  const sentRows = d.alreadySent.map(chargeLine);
  const bankRows = d.bankCharges.map(chargeLine);

  const sumC = (rows: ChargeRow[]) => rows.reduce((a, c) => a + Number(c.amount ?? 0), 0);
  const sumO = (rows: OrphanRow[]) => rows.reduce((a, o) => a + Number(o.ttd_amount ?? 0), 0);

  // Appendix: EVERY receipt document, matched ones first (in table order),
  // then the ones with no statement line. Andrew hands this to the accountant.
  const items: ReceiptItem[] = [
    ...d.readyToSend
      .concat(d.alreadySent)
      .filter((c) => c.receipt_id)
      .map((c) => ({
        receiptId: c.receipt_id as string,
        label: `${c.txn_date ?? ""} · ${c.receipt_vendor ?? "Receipt"} · ${money(
          Number(c.amount ?? 0)
        )}`,
      })),
    ...d.orphansOpen.concat(d.orphansSent).map((o) => ({
      receiptId: o.receipt_id,
      label: `${o.receipt_date ?? ""} · ${o.vendor_name ?? "Receipt"} · ${
        o.ttd_amount != null ? money(Number(o.ttd_amount)) : ""
      } · NO STATEMENT LINE`,
    })),
  ];

  const periodStart = d.statements.length
    ? d.statements.reduce(
        (min, s) => (s.effective_start < min ? s.effective_start : min),
        d.statements[0].effective_start
      )
    : "";
  const periodEnd = d.statements.length ? d.statements[0].effective_end : "";

  const willEmbed =
    appendix === "none" ? 0 : Math.min(items.length, APPENDIX_MAX_RECEIPTS);

  const coverBytes = await renderToBuffer(
    CloseOutReportDocument({
      company: profile?.company_name ?? "",
      userName: profile?.full_name ?? user.email ?? "",
      generatedAt: today,
      period: periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : "all statements",
      // Two live statements parsed with no period; statement_coverage recovers
      // it from the transactions. Saying so beats printing a date we never read.
      periodInferred: true,
      statements: d.statements.map((s) => ({
        name: s.file_name.replace(/\.pdf$/i, ""),
        period: `${s.effective_start} → ${s.effective_end}`,
        lines: s.txn_count,
      })),
      needsReceipt,
      orphanReceipts: orphanRows,
      matched: matchedRows,
      alreadySent: sentRows,
      bankCharges: bankRows,
      totals: {
        charges:
          d.needsReceipt.length +
          d.needsConfirmation.length +
          d.readyToSend.length +
          d.alreadySent.length +
          d.bankCharges.length,
        rawLines: d.statements.reduce((a, s) => a + s.txn_count, 0),
        spendTotal: money(d.totals.spendTotal),
        duplicateSaving: money(d.totals.rawLineTotal - d.totals.spendTotal),
        needsReceiptTotal: money(sumC(d.needsReceipt) + sumC(d.needsConfirmation)),
        orphanTotal: money(sumO(d.orphansOpen)),
        matchedTotal: money(sumC(d.readyToSend)),
        sentTotal: money(sumC(d.alreadySent)),
        bankTotal: money(sumC(d.bankCharges)),
      },
      appendixNote:
        appendix === "none"
          ? "Not included in this copy — generated as the work list only."
          : `The ${willEmbed} receipt document${willEmbed === 1 ? "" : "s"} follow${
              willEmbed === 1 ? "s" : ""
            } from here, matched ones first, then those with no statement line (each labelled).`,
    })
  );

  const merged = await PDFDocument.load(coverBytes);
  let skipped = 0;
  if (appendix !== "none") {
    const res = await appendReceiptDocuments(merged, supabase, items, {
      maxReceipts: APPENDIX_MAX_RECEIPTS,
      deadline: startedAt + APPENDIX_DEADLINE_MS,
    });
    skipped = res.skipped;
  }

  if (skipped > 0) {
    // Partial output beats a timeout, but it must say so.
    const page = merged.addPage([595.28, 841.89]);
    page.drawText(
      `${skipped} further receipt document(s) were not included in this copy.`,
      { x: 40, y: 780, size: 11 }
    );
    page.drawText("Re-run with fewer receipts, or use the work-list-only copy.", {
      x: 40,
      y: 762,
      size: 9,
    });
  }

  const pdf = await merged.save();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="close-out-${today}.pdf"`,
    },
  });
}
