import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import {
  BillBackReportDocument,
  type BillBackGroup,
} from "@/lib/reports/billback-report-document";
import { appendReceiptDocuments } from "@/lib/reports/append-receipts";
import { normalizeVendor } from "@/lib/classification/classify";
import { formatMonthKey, formatTTD } from "@/lib/month";
import { getApprovedUser } from "@/lib/auth/guard";

export const maxDuration = 60;

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
    const key = r.bill_back_normalized || normalizeVendor(r.bill_back_name);
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
  await appendReceiptDocuments(
    merged,
    supabase,
    numbered.map(({ n: num, row, groupName }) => ({
      receiptId: row.id,
      label: `#${num} · ${groupName} · ${row.vendor_name ?? "Receipt"}`,
    }))
  );

  const pdf = await merged.save();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="bill-back-report-${month}.pdf"`,
    },
  });
}
