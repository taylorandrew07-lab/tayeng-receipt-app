import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import {
  BillBackReportDocument,
  type BillBackGroup,
} from "@/lib/reports/billback-report-document";
import { formatMonthKey, formatTTD } from "@/lib/month";
import { getApprovedUser } from "@/lib/auth/guard";

export const maxDuration = 60;

const MAX_EMBED_BYTES = 25 * 1024 * 1024;
const MAX_PAGES_PER_RECEIPT = 20;
const A4: [number, number] = [595.28, 841.89];

type Row = {
  id: string;
  receipt_date: string | null;
  vendor_name: string | null;
  ttd_amount: number | null;
  bill_back_type: string | null;
  bill_back_name: string | null;
  bill_back_normalized: string | null;
};

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { user, approved } = await getApprovedUser(supabase);
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!approved) return new Response("Account not approved", { status: 403 });

  const month =
    request.nextUrl.searchParams.get("month") ??
    new Date().toISOString().slice(0, 7);

  const [{ data: profile }, { data: receipts }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
    supabase
      .from("receipts")
      .select(
        "id, receipt_date, vendor_name, ttd_amount, bill_back_type, bill_back_name, bill_back_normalized"
      )
      .eq("month_key", month)
      .eq("bill_back", true)
      .is("duplicate_of", null)
      .order("bill_back_normalized", { ascending: true })
      .order("receipt_date", { ascending: true, nullsFirst: true }),
  ]);

  const rows = (receipts ?? []) as Row[];

  // Group by normalized bill-back name; keep an ordered list of (row, n).
  const order: string[] = [];
  const byKey = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.bill_back_normalized || normalizeKey(r.bill_back_name);
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(r);
  }

  let n = 0;
  const numbered: { n: number; row: Row; groupName: string }[] = [];
  const groups: BillBackGroup[] = order.map((key) => {
    const items = byKey.get(key)!;
    const name = items[0].bill_back_name ?? "Unnamed";
    const type = items[0].bill_back_type ?? "client";
    const total = items.reduce((a, r) => a + Number(r.ttd_amount ?? 0), 0);
    return {
      name,
      type,
      total: formatTTD(total),
      items: items.map((r) => {
        n += 1;
        numbered.push({ n, row: r, groupName: name });
        return {
          n,
          date: r.receipt_date ?? "—",
          vendor: r.vendor_name ?? "Unknown",
          amount: r.ttd_amount != null ? formatTTD(Number(r.ttd_amount)) : "—",
        };
      }),
    };
  });

  const grandTotal = rows.reduce((a, r) => a + Number(r.ttd_amount ?? 0), 0);

  const coverBytes = await renderToBuffer(
    BillBackReportDocument({
      company: profile?.company_name ?? "",
      userName: profile?.full_name ?? user.email ?? "",
      period: `Bill-back expenses · ${formatMonthKey(month)}`,
      groups,
      grandTotal: formatTTD(grandTotal),
    })
  );

  // Append the original receipt documents in the same numbered order.
  const merged = await PDFDocument.load(coverBytes);
  const labelFont = await merged.embedFont(StandardFonts.Helvetica);
  const drawLabel = (page: import("pdf-lib").PDFPage, text: string) => {
    const size = 9;
    const w = labelFont.widthOfTextAtSize(text, size) + 8;
    const y = page.getHeight() - 16;
    page.drawRectangle({ x: 4, y: y - 3, width: w, height: size + 6, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(text, { x: 8, y, size, font: labelFont, color: rgb(0.06, 0.09, 0.16) });
  };

  for (const { n: num, row, groupName } of numbered) {
    const label = `#${num} · ${groupName} · ${row.vendor_name ?? "Receipt"}`;
    try {
      const { data: file } = await supabase
        .from("receipt_files")
        .select("storage_path, mime_type, file_name")
        .eq("receipt_id", row.id)
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
      "Content-Disposition": `attachment; filename="bill-back-report-${month}.pdf"`,
    },
  });
}

function normalizeKey(name: string | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
