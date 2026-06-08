import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import { ReportDocument, type ReportRow } from "@/lib/reports/report-document";
import { PAYMENT_LABEL } from "@/components/receipts/labels";
import { formatMonthKey, formatTTD } from "@/lib/month";
import { getApprovedUser } from "@/lib/auth/guard";
import type { Receipt } from "@/lib/types";

export const maxDuration = 60;

// Caps so a single huge / many-page receipt can't blow the report's memory/time.
const MAX_EMBED_BYTES = 25 * 1024 * 1024; // 25 MB per receipt file
const MAX_PAGES_PER_RECEIPT = 20;

type Row = Receipt & { categories: { name: string } | null };

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!approved) return new Response("Account not approved", { status: 403 });

  const month =
    request.nextUrl.searchParams.get("month") ??
    new Date().toISOString().slice(0, 7);
  const type = request.nextUrl.searchParams.get("type") ?? "all";

  const [{ data: profile }, { data: settings }, { data: receipts }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    supabase.from("user_settings").select("usd_to_ttd_rate").eq("user_id", user.id).single(),
    supabase
      .from("receipts")
      .select("*, categories(name)")
      .eq("month_key", month)
      .is("duplicate_of", null) // never include flagged duplicates in a report
      .order("receipt_date", { ascending: true, nullsFirst: true }),
  ]);
  const usdRate = Number(settings?.usd_to_ttd_rate ?? 6.8);

  const allRows = (receipts ?? []) as Row[];
  const rowsData =
    type === "reimbursable"
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
  const ttd = (r: Row) => Number(r.ttd_amount ?? 0);

  const totals = {
    reimbursable: formatTTD(rowsData.filter((r) => r.reimbursable).reduce((a, r) => a + ttd(r), 0)),
    personal_card: formatTTD(
      rowsData.filter((r) => r.payment_method === "personal_card").reduce((a, r) => a + ttd(r), 0)
    ),
    cash: formatTTD(rowsData.filter((r) => r.payment_method === "cash").reduce((a, r) => a + ttd(r), 0)),
    company_card: formatTTD(
      rowsData.filter((r) => r.payment_method === "company_card").reduce((a, r) => a + ttd(r), 0)
    ),
    needs_review_count: rowsData.filter((r) => r.status === "needs_review").length,
    count: rowsData.length,
  };

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

  // 1) Render the summary + detailed table (cover pages) with @react-pdf.
  const coverBytes = await renderToBuffer(
    ReportDocument({
      title: reportTitle,
      company: profile?.company_name ?? "",
      userName: profile?.full_name ?? user.email ?? "",
      period: formatMonthKey(month),
      rows,
      totals,
      rate: usdRate.toFixed(2),
      totalTtd: formatTTD(rowsData.reduce((a, r) => a + ttd(r), 0)),
      usdSubtotal: `USD ${rowsData
        .filter((r) => (r.currency ?? "").toUpperCase() === "USD")
        .reduce((a, r) => a + Number(r.amount ?? 0), 0)
        .toFixed(2)}`,
    })
  );

  // 2) Merge the ACTUAL receipt documents onto the end with pdf-lib:
  //    PDF receipts have their pages copied in; image receipts get a full page.
  const merged = await PDFDocument.load(coverBytes);
  const labelFont = await merged.embedFont(StandardFonts.Helvetica);
  const A4: [number, number] = [595.28, 841.89];

  const drawLabel = (
    page: import("pdf-lib").PDFPage,
    text: string
  ) => {
    const size = 9;
    const w = labelFont.widthOfTextAtSize(text, size) + 8;
    const y = page.getHeight() - 16;
    page.drawRectangle({
      x: 4,
      y: y - 3,
      width: w,
      height: size + 6,
      color: rgb(1, 1, 1),
      opacity: 0.85,
    });
    page.drawText(text, { x: 8, y, size, font: labelFont, color: rgb(0.06, 0.09, 0.16) });
  };

  for (let i = 0; i < rowsData.length; i++) {
    const r = rowsData[i];
    const label = `Receipt #${i + 1} · ${r.vendor_name ?? "Unknown"} · ${
      r.ttd_amount != null ? formatTTD(r.ttd_amount) : "—"
    }`;

    const { data: file } = await supabase
      .from("receipt_files")
      .select("storage_path, mime_type, file_name")
      .eq("receipt_id", r.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    try {
      if (!file) {
        const page = merged.addPage(A4);
        drawLabel(page, `${label} — no file attached`);
        continue;
      }

      const { data: blob } = await supabase.storage
        .from("documents")
        .download(file.storage_path);
      if (!blob) {
        const page = merged.addPage(A4);
        drawLabel(page, `${label} — file unavailable`);
        continue;
      }

      // Skip files too large to safely load into the serverless function.
      if (blob.size > MAX_EMBED_BYTES) {
        const page = merged.addPage(A4);
        drawLabel(page, `${label} — file too large to include (open it in the app)`);
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
        // Cap pages per receipt so one huge PDF can't blow up the report.
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
        const maxW = A4[0] - margin * 2;
        const maxH = A4[1] - margin * 2 - 20;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, {
          x: (A4[0] - w) / 2,
          y: (A4[1] - h) / 2 - 10,
          width: w,
          height: h,
        });
        drawLabel(page, label);
      } else {
        const page = merged.addPage(A4);
        drawLabel(page, `${label} — unsupported file type`);
      }
    } catch {
      const page = merged.addPage(A4);
      drawLabel(page, `${label} — could not be embedded`);
    }
  }

  const pdf = await merged.save();

  // Cache the totals for the dashboard / history.
  await supabase.from("monthly_reports").upsert(
    {
      user_id: user.id,
      month_key: month,
      totals: {
        reimbursable: rowsData.filter((r) => r.reimbursable).reduce((a, r) => a + ttd(r), 0),
        personal_card: rowsData
          .filter((r) => r.payment_method === "personal_card")
          .reduce((a, r) => a + ttd(r), 0),
        cash: rowsData.filter((r) => r.payment_method === "cash").reduce((a, r) => a + ttd(r), 0),
        company_card: rowsData
          .filter((r) => r.payment_method === "company_card")
          .reduce((a, r) => a + ttd(r), 0),
        needs_review_count: totals.needs_review_count,
        unmatched_count: 0,
      },
    },
    { onConflict: "user_id,month_key" }
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="expense-report-${month}.pdf"`,
    },
  });
}
