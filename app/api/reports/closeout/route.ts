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
import {
  addOmissionsPage,
  addPartCover,
  appendReceiptDocuments,
  type ReceiptItem,
} from "@/lib/reports/append-receipts";
import { closeOutAppendix } from "@/lib/reports/closeout-appendix";
import { completenessOf } from "@/lib/reports/completeness";
import { closeOutTotals } from "@/lib/reports/closeout-totals";
import { partHeaders, slicePart } from "@/lib/reports/parts";
import { formatMoney, formatTTD } from "@/lib/month";
import type { ChargeRow, OrphanRow } from "@/lib/reconciliation/types";

export const maxDuration = 60;

// Leave headroom inside Vercel's 60s so the PDF is always returned.
const APPENDIX_DEADLINE_MS = 42_000;

/**
 * The close-out PDF Andrew hands to the accountant.
 *
 * `?part=N` — the receipt documents are split into parts so every one of them
 *             can be downloaded (previously anything past 60 was unobtainable).
 * `?appendix=none` — the tables only, always fast.
 *
 * Charges Andrew closed BY HAND are internal housekeeping and appear nowhere
 * in this document — not in a table, and not in any total. The totals below
 * are therefore built only from the rows actually printed, so every figure on
 * the cover can be ticked back to the tables.
 */
export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!approved) return new Response("Account not approved", { status: 403 });

  const appendix = request.nextUrl.searchParams.get("appendix") ?? "all";

  // A report built from a failed or partial read would look complete. Fail
  // visibly instead.
  let d: Awaited<ReturnType<typeof loadCloseOut>>;
  let profile: { full_name: string | null; company_name: string | null } | null;
  try {
    const [p, data] = await Promise.all([
      supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
      loadCloseOut(supabase),
    ]);
    profile = p.data;
    d = data;
  } catch (e) {
    return new Response(
      `The close-out report could not be produced because its data could not be loaded: ${
        (e as Error).message
      }. Nothing is wrong with your records — try again.`,
      { status: 500 }
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const title = `${profile?.company_name || profile?.full_name || "Close-out"} — close-out ${today}`;

  // Every receipt document, numbered globally so a part can say "#41 to #80".
  const all: ReceiptItem[] = closeOutAppendix(d);
  const slice = slicePart(all, request.nextUrl.searchParams.get("part"));
  const headers = {
    "Content-Type": "application/pdf",
    ...(appendix === "none" ? {} : partHeaders(slice)),
  };

  // ---- Part 2 onwards: documents only, with a cover saying what it is. ----
  if (appendix !== "none" && slice.part > 1) {
    const merged = await PDFDocument.create();
    await addPartCover(merged, title, slice.part, slice.parts, slice.first, slice.last);
    let res;
    try {
      res = await appendReceiptDocuments(merged, supabase, slice.items, {
        deadline: startedAt + APPENDIX_DEADLINE_MS,
      });
    } catch (e) {
      return new Response(`Could not load the receipt documents: ${(e as Error).message}`, {
        status: 500,
      });
    }
    await addOmissionsPage(merged, res.omitted, slice);
    const pdf = await merged.save();
    return new Response(new Uint8Array(pdf), {
      headers: {
        ...headers,
        "Content-Disposition": `attachment; filename="close-out-${today}-part-${slice.part}.pdf"`,
      },
    });
  }

  // ---- Part 1: summary, tables, and the first slice of documents. ----
  let n = 0;
  const chargeLine = (c: ChargeRow): CloseOutLine => ({
    n: ++n,
    date: c.txn_date ?? "—",
    description: c.description ?? "—",
    // In the charge's OWN currency — never a raw foreign amount labelled TTD.
    amount: formatMoney(Number(c.amount ?? 0), c.currency),
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
    amount: o.ttd_amount != null ? formatTTD(Number(o.ttd_amount)) : "—",
    statements: "none",
    receipt: o.currency !== "TTD" ? `${o.currency} ${Number(o.amount ?? 0).toFixed(2)}` : "",
  });

  const needs = d.needsReceipt.concat(d.needsConfirmation);
  const needsReceipt = needs.map(chargeLine);
  const orphanRows = d.orphansOpen.map(orphanLine);
  const matchedRows = d.readyToSend.map(chargeLine);
  const sentRows = d.alreadySent.map(chargeLine);
  // d.bankCharges is machine-recognised FEES ONLY. d.clearedByHand is never
  // read in this file, by design.
  const bankRows = d.bankCharges.map(chargeLine);

  // Every cover figure from the printed rows only (lib/reports/closeout-totals):
  // cleared-by-hand charges are in no total, and only TTD is ever summed.
  const tot = closeOutTotals(d);

  const periodStart = d.statements.length
    ? d.statements.reduce(
        (min, s) => (s.effective_start < min ? s.effective_start : min),
        d.statements[0].effective_start
      )
    : "";
  const periodEnd = d.statements.length ? d.statements[0].effective_end : "";

  const verdicts = d.statements.map((s) => completenessOf(s));
  const proven = verdicts.filter((v) => v.proven).length;
  const completenessNote =
    d.statements.length === 0
      ? "No statements are included."
      : proven === d.statements.length
        ? "Every statement's lines were checked against the totals printed on the statement itself, and add up to the cent. A charge appearing on more than one statement is listed once and counted once."
        : `${d.statements.length - proven} of ${d.statements.length} statements could NOT be proven complete (see "Statements included" above), so this list may be missing lines from ${
            d.statements.length - proven === 1 ? "that statement" : "those statements"
          }. A charge appearing on more than one statement is listed once and counted once.`;

  const willEmbed = appendix === "none" ? 0 : slice.items.length;
  const appendixNote =
    appendix === "none"
      ? "Not included in this copy — generated as the work list only."
      : all.length === 0
        ? "There are no receipt documents to include."
        : slice.parts > 1
          ? `There are ${all.length} receipt documents, split into ${slice.parts} parts so each can be downloaded. This is part 1: documents #1 to #${slice.last}. Download parts 2 to ${slice.parts} from the Close-Out screen.`
          : `The ${willEmbed} receipt document${willEmbed === 1 ? "" : "s"} follow${
              willEmbed === 1 ? "s" : ""
            } from here, matched ones first, then those with no statement line (each labelled).`;

  const coverBytes = await renderToBuffer(
    CloseOutReportDocument({
      company: profile?.company_name ?? "",
      userName: profile?.full_name ?? user.email ?? "",
      generatedAt: today,
      period: periodStart && periodEnd ? `${periodStart} to ${periodEnd}` : "all statements",
      // True only if SOME statement's period was inferred rather than read —
      // it used to be hard-coded true for every report.
      periodInferred: d.statements.some((s) => !s.period_read),
      statements: d.statements.map((s, i) => ({
        name: s.file_name.replace(/\.pdf$/i, ""),
        period: `${s.effective_start} → ${s.effective_end}`,
        completeness: verdicts[i].label,
      })),
      needsReceipt,
      orphanReceipts: orphanRows,
      matched: matchedRows,
      alreadySent: sentRows,
      bankCharges: bankRows,
      totals: {
        charges: tot.listedCount,
        rawLines: tot.listedLines,
        spendTotal: formatTTD(tot.listedTotal),
        duplicateSaving: formatTTD(tot.repeatedValue),
        needsReceiptTotal: formatTTD(tot.needsReceiptTotal),
        orphanTotal: formatTTD(tot.orphanTotal),
        matchedTotal: formatTTD(tot.matchedTotal),
        sentTotal: formatTTD(tot.sentTotal),
        bankTotal: formatTTD(tot.bankTotal),
      },
      foreignNote: tot.foreignCurrencies.length
        ? `Charges in ${tot.foreignCurrencies.join(", ")} are shown in their own currency and are not included in the TTD totals.`
        : "",
      completenessNote,
      appendixNote,
    })
  );

  const merged = await PDFDocument.load(coverBytes);
  if (appendix !== "none") {
    let res;
    try {
      res = await appendReceiptDocuments(merged, supabase, slice.items, {
        deadline: startedAt + APPENDIX_DEADLINE_MS,
      });
    } catch (e) {
      return new Response(`Could not load the receipt documents: ${(e as Error).message}`, {
        status: 500,
      });
    }
    await addOmissionsPage(merged, res.omitted, slice);
  }

  const pdf = await merged.save();
  return new Response(new Uint8Array(pdf), {
    headers: {
      ...headers,
      "Content-Disposition": `attachment; filename="close-out-${today}${
        slice.parts > 1 && appendix !== "none" ? "-part-1" : ""
      }.pdf"`,
    },
  });
}
