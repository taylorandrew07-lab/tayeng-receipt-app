import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

export type ReconRow = {
  n: number;
  date: string;
  description: string;
  amount: string;
  matched: boolean;
  receipt: string; // matched receipt label, or ""
};

export type StatementReportData = {
  company: string;
  userName: string;
  statementName: string;
  period: string;
  card: string;
  rows: ReconRow[];
  totalAmount: string;
  matchedCount: number;
  matchedTotal: string;
  missingCount: number;
  missingTotal: string;
};

const s = StyleSheet.create({
  page: { padding: 28, fontSize: 9, color: "#0f172a", fontFamily: "Helvetica" },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 10, color: "#64748b", marginTop: 3 },
  sectionTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 6 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
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
  struck: { textDecoration: "line-through", color: "#64748b" },
});

const COLS = { n: 5, date: 11, desc: 34, amount: 13, status: 13, receipt: 24 };

export function StatementReportDocument(data: StatementReportData) {
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={s.page}>
        <Text style={s.h1}>Statement Reconciliation</Text>
        <Text style={s.sub}>
          {data.company ? `${data.company} · ` : ""}
          {data.userName}
        </Text>
        <Text style={s.sub}>
          {data.statementName}
          {data.card ? ` · ${data.card}` : ""}
          {data.period ? ` · ${data.period}` : ""}
        </Text>

        <View style={{ marginTop: 12, width: "55%" }}>
          <Summary label="Total transactions" value={String(data.rows.length)} />
          <Summary label="Statement total" value={data.totalAmount} />
          <Summary label={`Matched (with receipt)`} value={`${data.matchedCount} · ${data.matchedTotal}`} />
          <Summary label="Missing a receipt" value={`${data.missingCount} · ${data.missingTotal}`} />
        </View>

        <Text style={s.sectionTitle}>Transactions</Text>
        <View style={s.tHead} fixed>
          <Text style={[s.cell, { width: `${COLS.n}%` }]}>#</Text>
          <Text style={[s.cell, { width: `${COLS.date}%` }]}>Date</Text>
          <Text style={[s.cell, { width: `${COLS.desc}%` }]}>Description</Text>
          <Text style={[s.cell, { width: `${COLS.amount}%`, textAlign: "right" }]}>Amount</Text>
          <Text style={[s.cell, { width: `${COLS.status}%` }]}>Status</Text>
          <Text style={[s.cell, { width: `${COLS.receipt}%` }]}>Receipt</Text>
        </View>
        {data.rows.map((r) => (
          <View style={s.tRow} key={r.n} wrap={false}>
            <Text style={[s.cell, { width: `${COLS.n}%` }]}>{r.n}</Text>
            <Text style={[s.cell, { width: `${COLS.date}%` }, r.matched ? s.struck : {}]}>
              {r.date}
            </Text>
            <Text style={[s.cell, { width: `${COLS.desc}%` }, r.matched ? s.struck : {}]}>
              {r.description}
            </Text>
            <Text
              style={[
                s.cell,
                { width: `${COLS.amount}%`, textAlign: "right" },
                r.matched ? s.struck : {},
              ]}
            >
              {r.amount}
            </Text>
            <Text
              style={[
                s.cell,
                { width: `${COLS.status}%`, fontFamily: "Helvetica-Bold" },
                { color: r.matched ? "#15803d" : "#b45309" },
              ]}
            >
              {r.matched ? "Matched" : "MISSING"}
            </Text>
            <Text style={[s.cell, { width: `${COLS.receipt}%` }]}>{r.receipt}</Text>
          </View>
        ))}
      </Page>
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
