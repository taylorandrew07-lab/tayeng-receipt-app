import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import {
  ReportDocument,
  type ReportRow,
  type ReportImage,
} from "@/lib/reports/report-document";
import { PAYMENT_LABEL } from "@/components/receipts/labels";
import { formatMonthKey, formatTTD } from "@/lib/month";
import { pdfFirstPagePng } from "@/lib/reports/pdf-to-image";
import type { Receipt } from "@/lib/types";

export const maxDuration = 60;

type Row = Receipt & { categories: { name: string } | null };

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const month =
    request.nextUrl.searchParams.get("month") ??
    new Date().toISOString().slice(0, 7);
  const type = request.nextUrl.searchParams.get("type") ?? "all";

  const [{ data: profile }, { data: receipts }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    supabase
      .from("receipts")
      .select("*, categories(name)")
      .eq("month_key", month)
      .is("duplicate_of", null) // never include flagged duplicates in a report
      .order("receipt_date", { ascending: true, nullsFirst: true }),
  ]);

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

  // Fetch each receipt's primary file and turn it into an embeddable image:
  // JPG/PNG are embedded directly; PDFs are rendered (first page) to PNG.
  // Done sequentially to keep memory/time predictable on the serverless runtime.
  const images: ReportImage[] = [];
  for (let i = 0; i < rowsData.length; i++) {
    const r = rowsData[i];
    const base: ReportImage = {
      n: i + 1,
      vendor: r.vendor_name ?? "Unknown",
      ttd: r.ttd_amount != null ? formatTTD(r.ttd_amount) : "—",
      dataUrl: null,
    };

    const { data: file } = await supabase
      .from("receipt_files")
      .select("storage_path, mime_type, file_name")
      .eq("receipt_id", r.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!file) {
      images.push(base);
      continue;
    }

    const { data: blob } = await supabase.storage
      .from("documents")
      .download(file.storage_path);
    if (!blob) {
      images.push(base);
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = (file.file_name ?? "").toLowerCase();
    const mime = (file.mime_type ?? "").toLowerCase();
    const isPng = mime.includes("png") || name.endsWith(".png");
    const isJpg = mime.includes("jpeg") || /\.jpe?g$/.test(name);
    const isPdf = mime.includes("pdf") || name.endsWith(".pdf");

    if (isJpg || isPng) {
      const b64 = Buffer.from(bytes).toString("base64");
      images.push({
        ...base,
        dataUrl: `data:${isPng ? "image/png" : "image/jpeg"};base64,${b64}`,
      });
    } else if (isPdf) {
      const png = await pdfFirstPagePng(bytes);
      images.push(
        png
          ? { ...base, dataUrl: `data:image/png;base64,${png.toString("base64")}` }
          : base
      );
    } else {
      images.push(base);
    }
  }

  const pdf = await renderToBuffer(
    ReportDocument({
      title: reportTitle,
      company: profile?.company_name ?? "",
      userName: profile?.full_name ?? user.email ?? "",
      period: formatMonthKey(month),
      rows,
      totals,
      images,
    })
  );

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
