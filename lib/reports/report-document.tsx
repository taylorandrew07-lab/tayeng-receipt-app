import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";

export type ReportRow = {
  n: number;
  date: string;
  vendor: string;
  category: string;
  payment: string;
  card_last4: string;
  currency: string;
  amount: string;
  ttd: string;
  reimbursable: string;
  notes: string;
};

export type ReportImage = {
  n: number;
  vendor: string;
  ttd: string;
  dataUrl: string | null; // null for PDFs / unembeddable originals
};

export type ReportTotalsView = {
  reimbursable: string;
  personal_card: string;
  cash: string;
  company_card: string;
  needs_review_count: number;
  count: number;
};

export type ReportData = {
  company: string;
  userName: string;
  period: string;
  rows: ReportRow[];
  totals: ReportTotalsView;
  images: ReportImage[];
};

const s = StyleSheet.create({
  page: { padding: 32, fontSize: 10, color: "#0f172a", fontFamily: "Helvetica" },
  pageLand: { padding: 28, fontSize: 8, color: "#0f172a", fontFamily: "Helvetica" },
  h1: { fontSize: 22, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 11, color: "#64748b", marginTop: 4 },
  sectionTitle: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 8, marginTop: 18 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  summaryLabel: { color: "#475569" },
  summaryValue: { fontFamily: "Helvetica-Bold" },
  tHead: {
    flexDirection: "row",
    backgroundColor: "#0f172a",
    color: "#ffffff",
    paddingVertical: 5,
    paddingHorizontal: 3,
  },
  tRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 3,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  cell: { paddingHorizontal: 2 },
  imgGrid: { flexDirection: "row", flexWrap: "wrap" },
  imgCard: {
    width: "33.33%",
    padding: 6,
  },
  imgBox: {
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 4,
    padding: 4,
  },
  img: { width: "100%", height: 150, objectFit: "contain" },
  imgCaption: { fontSize: 8, marginTop: 3, color: "#475569" },
  pdfBox: {
    height: 150,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafc",
    borderRadius: 2,
  },
});

// Column widths for the detail table (must sum to ~100).
const COLS = {
  n: 4,
  date: 9,
  vendor: 18,
  category: 11,
  payment: 11,
  card: 6,
  currency: 6,
  amount: 9,
  ttd: 9,
  reimb: 6,
  notes: 11,
};

export function ReportDocument(data: ReportData) {
  return (
    <Document>
      {/* Cover / summary */}
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Expense Report</Text>
        <Text style={s.sub}>
          {data.company ? `${data.company} · ` : ""}
          {data.userName}
        </Text>
        <Text style={s.sub}>Period: {data.period}</Text>

        <Text style={s.sectionTitle}>Summary</Text>
        <Summary label="Total reimbursable" value={data.totals.reimbursable} />
        <Summary label="Personal card expenses" value={data.totals.personal_card} />
        <Summary label="Cash expenses" value={data.totals.cash} />
        <Summary label="Company card expenses" value={data.totals.company_card} />
        <Summary label="Items still needing review" value={String(data.totals.needs_review_count)} />
        <Summary label="Total items" value={String(data.totals.count)} />
      </Page>

      {/* Detailed table (landscape for width) */}
      <Page size="A4" orientation="landscape" style={s.pageLand}>
        <Text style={s.sectionTitle}>Detailed transactions</Text>
        <View style={s.tHead} fixed>
          <Text style={[s.cell, { width: `${COLS.n}%` }]}>#</Text>
          <Text style={[s.cell, { width: `${COLS.date}%` }]}>Date</Text>
          <Text style={[s.cell, { width: `${COLS.vendor}%` }]}>Vendor</Text>
          <Text style={[s.cell, { width: `${COLS.category}%` }]}>Category</Text>
          <Text style={[s.cell, { width: `${COLS.payment}%` }]}>Payment</Text>
          <Text style={[s.cell, { width: `${COLS.card}%` }]}>Card</Text>
          <Text style={[s.cell, { width: `${COLS.currency}%` }]}>Curr</Text>
          <Text style={[s.cell, { width: `${COLS.amount}%`, textAlign: "right" }]}>Amount</Text>
          <Text style={[s.cell, { width: `${COLS.ttd}%`, textAlign: "right" }]}>TTD</Text>
          <Text style={[s.cell, { width: `${COLS.reimb}%` }]}>Reimb</Text>
          <Text style={[s.cell, { width: `${COLS.notes}%` }]}>Notes</Text>
        </View>
        {data.rows.map((r) => (
          <View style={s.tRow} key={r.n} wrap={false}>
            <Text style={[s.cell, { width: `${COLS.n}%` }]}>{r.n}</Text>
            <Text style={[s.cell, { width: `${COLS.date}%` }]}>{r.date}</Text>
            <Text style={[s.cell, { width: `${COLS.vendor}%` }]}>{r.vendor}</Text>
            <Text style={[s.cell, { width: `${COLS.category}%` }]}>{r.category}</Text>
            <Text style={[s.cell, { width: `${COLS.payment}%` }]}>{r.payment}</Text>
            <Text style={[s.cell, { width: `${COLS.card}%` }]}>{r.card_last4}</Text>
            <Text style={[s.cell, { width: `${COLS.currency}%` }]}>{r.currency}</Text>
            <Text style={[s.cell, { width: `${COLS.amount}%`, textAlign: "right" }]}>{r.amount}</Text>
            <Text style={[s.cell, { width: `${COLS.ttd}%`, textAlign: "right" }]}>{r.ttd}</Text>
            <Text style={[s.cell, { width: `${COLS.reimb}%` }]}>{r.reimbursable}</Text>
            <Text style={[s.cell, { width: `${COLS.notes}%` }]}>{r.notes}</Text>
          </View>
        ))}
      </Page>

      {/* Receipt images, multiple per page, numbered to match the table */}
      {data.images.length > 0 && (
        <Page size="A4" style={s.page}>
          <Text style={s.sectionTitle}>Receipt copies</Text>
          <View style={s.imgGrid}>
            {data.images.map((img) => (
              <View style={s.imgCard} key={img.n} wrap={false}>
                <View style={s.imgBox}>
                  {img.dataUrl ? (
                    <Image style={s.img} src={img.dataUrl} />
                  ) : (
                    <View style={s.pdfBox}>
                      <Text style={{ fontSize: 9, color: "#64748b" }}>PDF document</Text>
                    </View>
                  )}
                  <Text style={s.imgCaption}>
                    #{img.n} · {img.vendor} · {img.ttd}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </Page>
      )}
    </Document>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.summaryRow}>
      <Text style={s.summaryLabel}>{label}</Text>
      <Text style={s.summaryValue}>{value}</Text>
    </View>
  );
}
