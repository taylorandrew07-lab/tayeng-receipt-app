import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import { ReportDocument, type ReportRow } from "@/lib/reports/report-document";
import {
  addOmissionsPage,
  addPartCover,
  appendReceiptDocuments,
} from "@/lib/reports/append-receipts";
import { partHeaders, slicePart } from "@/lib/reports/parts";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
import { PAYMENT_LABEL } from "@/components/receipts/labels";
import { formatMonthKey, formatTTD } from "@/lib/month";
import { getApprovedUser } from "@/lib/auth/guard";
import type { Receipt } from "@/lib/types";

export const maxDuration = 60;

// Leave headroom inside Vercel's 60s. This route previously had no deadline at
// all, so a large report simply timed out and returned nothing.
const APPENDIX_DEADLINE_MS = 42_000;

type Row = Receipt & { categories: { name: string } | null };

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!approved) return new Response("Account not approved", { status: 403 });

  const month =
    request.nextUrl.searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
  const type = request.nextUrl.searchParams.get("type") ?? "all";

  // A reimbursement claim is about what you are still OWED, not about what
  // happened inside a calendar window. An unpaid June receipt still has to
  // appear in today's claim, so the reimbursable report defaults to every
  // unpaid receipt regardless of month. `scope=month` keeps the old behaviour
  // for reproducing a past month's paperwork.
  //
  // This also sidesteps a trap: `month_key` is the UPLOAD month (migration
  // 0004), not the date on the receipt, so month-scoping files a June receipt
  // uploaded in July under July.
  const outstanding =
    type === "reimbursable" && request.nextUrl.searchParams.get("scope") !== "month";

  // Every row, paginated with a TOTAL order (receipt_date alone is not unique,
  // so pages could skip or repeat rows past 1000). A failed read used to
  // produce an empty report that looked like "nothing to claim"; it now fails.
  let allRows: Row[];
  let profile: { full_name: string | null; company_name: string | null } | null;
  let usdRate: number;
  try {
    const [p, s, rows] = await Promise.all([
      supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
      supabase.from("user_settings").select("usd_to_ttd_rate").eq("user_id", user.id).single(),
      fetchAll<Row>((from, to) => {
        let q = supabase
          .from("receipts")
          .select("*, categories(name)")
          .is("duplicate_of", null) // never include flagged duplicates in a report
          .order("receipt_date", { ascending: true, nullsFirst: true })
          .order("id", { ascending: true });
        q = outstanding
          ? q.eq("reimbursable", true).eq("paid", false)
          : q.eq("month_key", month);
        return asPage<Row>(q.range(from, to));
      }),
    ]);
    profile = p.data;
    usdRate = Number(s.data?.usd_to_ttd_rate ?? 6.8);
    allRows = rows;
  } catch (e) {
    return new Response(
      `The report could not be produced because its data could not be loaded: ${
        (e as Error).message
      }. Try again.`,
      { status: 500 }
    );
  }

  const rowsData = outstanding
    ? allRows // already filtered to unpaid reimbursables by the query
    : type === "reimbursable"
      ? allRows.filter((r) => r.reimbursable === true)
      : type === "company"
        ? allRows.filter((r) => r.payment_method === "company_card")
        : allRows;
  const reportTitle =
    type === "reimbursable"
      ? "Reimbursable Expense Report"
      : type === "company"
        ? "Company Card Report"
        : "Expense Report";
  const today = new Date().toISOString().slice(0, 10);
  const period = outstanding ? `All unpaid reimbursables as at ${today}` : formatMonthKey(month);
  const ttd = (r: Row) => Number(r.ttd_amount ?? 0);
  const sumBy = (pred: (r: Row) => boolean) =>
    rowsData.filter(pred).reduce((a, r) => a + ttd(r), 0);

  // The payment-method lines PARTITION the rows, so they sum to the total.
  const MAIN = ["personal_card", "cash", "company_card"];
  const byMethod = {
    personal_card: sumBy((r) => r.payment_method === "personal_card"),
    cash: sumBy((r) => r.payment_method === "cash"),
    company_card: sumBy((r) => r.payment_method === "company_card"),
    other_methods: sumBy((r) => !MAIN.includes(r.payment_method)),
  };
  const reimbursableTotal = sumBy((r) => r.reimbursable === true);
  const grandTotal = rowsData.reduce((a, r) => a + ttd(r), 0);
  const needsReview = rowsData.filter((r) => r.status === "needs_review").length;

  // The documents, numbered globally so part 2 says "#41 to #80".
  const all = rowsData.map((r, i) => ({
    receiptId: r.id,
    label: `Receipt #${i + 1} · ${r.vendor_name ?? "Unknown"} · ${
      r.ttd_amount != null ? formatTTD(r.ttd_amount) : "—"
    }`,
  }));
  const slice = slicePart(all, request.nextUrl.searchParams.get("part"));
  const baseName = outstanding ? `reimbursable-outstanding-${today}` : `expense-report-${month}`;
  const filename = slice.parts > 1 ? `${baseName}-part-${slice.part}.pdf` : `${baseName}.pdf`;
  const headers = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    ...partHeaders(slice),
  };

  let merged: PDFDocument;
  if (slice.part > 1) {
    // Part 2 onwards: documents only, with a cover saying what it is.
    merged = await PDFDocument.create();
    await addPartCover(merged, reportTitle, slice.part, slice.parts, slice.first, slice.last);
  } else {
    const rows: ReportRow[] = rowsData.map((r, i) => ({
      n: i + 1,
      date: r.receipt_date ?? "—",
      vendor: r.vendor_name ?? "Unknown",
      category: r.categories?.name ?? "—",
      payment: PAYMENT_LABEL[r.payment_method],
      card_last4: r.card_last4 ?? "",
      currency: r.currency ?? "",
      amount: r.amount != null ? Number(r.amount).toFixed(2) : "—",
      ttd: r.ttd_amount != null ? Number(r.ttd_amount).toFixed(2) : "—",
      reimbursable: r.reimbursable === true ? "Yes" : r.reimbursable === false ? "No" : "?",
      notes: r.notes ?? "",
    }));

    const coverBytes = await renderToBuffer(
      ReportDocument({
        title: reportTitle,
        company: profile?.company_name ?? "",
        userName: profile?.full_name ?? user.email ?? "",
        period:
          slice.parts > 1
            ? `${period} · part 1 of ${slice.parts} (receipt documents #1 to #${slice.last}; download the other parts from the Reports page)`
            : period,
        rows,
        totals: {
          reimbursable: formatTTD(reimbursableTotal),
          personal_card: formatTTD(byMethod.personal_card),
          cash: formatTTD(byMethod.cash),
          company_card: formatTTD(byMethod.company_card),
          other_methods: formatTTD(byMethod.other_methods),
          needs_review_count: needsReview,
          count: rowsData.length,
        },
        rate: usdRate.toFixed(2),
        totalTtd: formatTTD(grandTotal),
        usdSubtotal: `USD ${rowsData
          .filter((r) => (r.currency ?? "").toUpperCase() === "USD")
          .reduce((a, r) => a + Number(r.amount ?? 0), 0)
          .toFixed(2)}`,
      })
    );
    merged = await PDFDocument.load(coverBytes);
  }

  let omitted;
  try {
    ({ omitted } = await appendReceiptDocuments(merged, supabase, slice.items, {
      deadline: startedAt + APPENDIX_DEADLINE_MS,
    }));
  } catch (e) {
    return new Response(`Could not load the receipt documents: ${(e as Error).message}`, {
      status: 500,
    });
  }
  await addOmissionsPage(merged, omitted, slice);

  const pdf = await merged.save();

  // Cache the totals for the dashboard / history — once per report, from
  // part 1. Skipped for an outstanding run: monthly_reports is keyed by month,
  // and an across-all-months claim filed under one month would corrupt that
  // month's history.
  if (!outstanding && slice.part === 1) {
    await supabase.from("monthly_reports").upsert(
      {
        user_id: user.id,
        month_key: month,
        totals: {
          reimbursable: reimbursableTotal,
          personal_card: byMethod.personal_card,
          cash: byMethod.cash,
          company_card: byMethod.company_card,
          other_methods: byMethod.other_methods,
          needs_review_count: needsReview,
          unmatched_count: 0,
        },
      },
      { onConflict: "user_id,month_key" }
    );
  }

  return new Response(new Uint8Array(pdf), { headers });
}
