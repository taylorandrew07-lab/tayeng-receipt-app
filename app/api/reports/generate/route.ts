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
import type { Receipt } from "@/lib/types";

export const maxDuration = 60;

type Row = Receipt & { categories: { name: string } | null };

const EMBEDDABLE = ["image/jpeg", "image/png"];

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const month =
    request.nextUrl.searchParams.get("month") ??
    new Date().toISOString().slice(0, 7);

  const [{ data: profile }, { data: receipts }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    supabase
      .from("receipts")
      .select("*, categories(name)")
      .eq("month_key", month)
      .order("receipt_date", { ascending: true, nullsFirst: true }),
  ]);

  const rowsData = (receipts ?? []) as Row[];
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

  // Fetch primary files and embed image originals (PNG/JPEG) as data URLs.
  const images: ReportImage[] = await Promise.all(
    rowsData.map(async (r, i): Promise<ReportImage> => {
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
      if (!file) return base;

      const mime = (file.mime_type ?? "").toLowerCase();
      const isJpgPng =
        EMBEDDABLE.includes(mime) ||
        /\.(jpe?g|png)$/i.test(file.file_name ?? "");
      if (!isJpgPng) return base;

      const { data: blob } = await supabase.storage
        .from("documents")
        .download(file.storage_path);
      if (!blob) return base;
      const b64 = Buffer.from(await blob.arrayBuffer()).toString("base64");
      const type = mime.includes("png") || /\.png$/i.test(file.file_name ?? "")
        ? "image/png"
        : "image/jpeg";
      return { ...base, dataUrl: `data:${type};base64,${b64}` };
    })
  );

  const pdf = await renderToBuffer(
    ReportDocument({
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
