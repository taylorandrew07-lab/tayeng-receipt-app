import { type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "pdf-lib";
import { createClient } from "@/lib/supabase/server";
import {
  BillBackReportDocument,
  type BillBackGroup,
} from "@/lib/reports/billback-report-document";
import {
  addOmissionsPage,
  addPartCover,
  appendReceiptDocuments,
} from "@/lib/reports/append-receipts";
import { partHeaders, slicePart } from "@/lib/reports/parts";
import { asPage, fetchAll } from "@/lib/reconciliation/paginate";
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

  const startedAt = Date.now();
  // Paginated with a TOTAL order, and failing visibly: a failed read used to
  // produce an empty bill-back report that looked like "nothing to bill".
  let profile: { full_name: string | null; company_name: string | null } | null;
  let rows: Row[];
  try {
    const [p, r] = await Promise.all([
      supabase.from("profiles").select("full_name, company_name").eq("id", user.id).single(),
      fetchAll<Row>((from, to) =>
        asPage<Row>(
          supabase
            .from("receipts")
            .select(
              "id, receipt_date, vendor_name, ttd_amount, bill_back_type, bill_back_name, bill_back_normalized"
            )
            .eq("month_key", month)
            .eq("bill_back", true)
            .is("duplicate_of", null)
            .order("bill_back_normalized", { ascending: true })
            .order("receipt_date", { ascending: true, nullsFirst: true })
            .order("id", { ascending: true })
            .range(from, to)
        )
      ),
    ]);
    profile = p.data;
    rows = r;
  } catch (e) {
    return new Response(
      `The bill-back report could not be produced because its data could not be loaded: ${
        (e as Error).message
      }. Try again.`,
      { status: 500 }
    );
  }

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

  // The original documents, in the same numbered order, in parts so that
  // every one is obtainable, with anything left out listed by name.
  const slice = slicePart(
    numbered.map(({ n: num, row, groupName }) => ({
      receiptId: row.id,
      label: `#${num} · ${groupName} · ${row.vendor_name ?? "Receipt"}`,
    })),
    request.nextUrl.searchParams.get("part")
  );
  let merged: PDFDocument;
  if (slice.part > 1) {
    merged = await PDFDocument.create();
    await addPartCover(merged, "Bill-back report", slice.part, slice.parts, slice.first, slice.last);
  } else {
    merged = await PDFDocument.load(coverBytes);
  }
  let omitted;
  try {
    ({ omitted } = await appendReceiptDocuments(merged, supabase, slice.items, {
      deadline: startedAt + 42_000,
    }));
  } catch (e) {
    return new Response(`Could not load the receipt documents: ${(e as Error).message}`, {
      status: 500,
    });
  }
  await addOmissionsPage(merged, omitted, slice);

  const pdf = await merged.save();
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="bill-back-report-${month}${
        slice.parts > 1 ? `-part-${slice.part}` : ""
      }.pdf"`,
      ...partHeaders(slice),
    },
  });
}
