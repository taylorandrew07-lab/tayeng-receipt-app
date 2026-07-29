import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

export type CloseOutLine = {
  n: number;
  date: string;
  description: string;
  amount: string;
  statements: string;
  receipt: string; // "" when there is none
};

export type CloseOutReportData = {
  company: string;
  userName: string;
  generatedAt: string;
  period: string;
  periodInferred: boolean;
  statements: { name: string; period: string; lines: number }[];
  needsReceipt: CloseOutLine[];
  orphanReceipts: CloseOutLine[];
  matched: CloseOutLine[];
  alreadySent: CloseOutLine[];
  bankCharges: CloseOutLine[];
  totals: {
    charges: number;
    rawLines: number;
    spendTotal: string;
    duplicateSaving: string;
    needsReceiptTotal: string;
    orphanTotal: string;
    matchedTotal: string;
    sentTotal: string;
    bankTotal: string;
  };
  appendixNote: string;
};

const s = StyleSheet.create({
  page: { padding: 26, fontSize: 8.5, color: "#0f172a", fontFamily: "Helvetica" },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 10, color: "#64748b", marginTop: 3 },
  caution: {
    marginTop: 8,
    padding: 6,
    backgroundColor: "#fef3c7",
    color: "#92400e",
    fontSize: 8,
  },
  sectionTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", marginTop: 16, marginBottom: 2 },
  sectionNote: { fontSize: 8, color: "#64748b", marginBottom: 5 },
  summaryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  summaryLabel: { color: "#475569" },
  summaryValue: { fontFamily: "Helvetica-Bold" },
  tHead: {
    flexDirection: "row",
    backgroundColor: "#0f172a",
    color: "#ffffff",
    paddingVertical: 4,
    paddingHorizontal: 3,
  },
  tRow: {
    flexDirection: "row",
    paddingVertical: 3.5,
    paddingHorizontal: 3,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  cell: { paddingHorizontal: 2 },
  right: { textAlign: "right" },
  muted: { color: "#64748b" },
  footer: {
    position: "absolute",
    bottom: 14,
    left: 26,
    right: 26,
    fontSize: 7.5,
    color: "#94a3b8",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  empty: { fontSize: 8, color: "#64748b", paddingVertical: 6 },
});

// Widths as percentages; `receipt` is dropped on the action list.
const W = { n: 4, date: 10, desc: 33, amount: 11, stmt: 16, receipt: 26 };

function Table({
  rows,
  showReceipt,
  receiptHeading = "Receipt attached",
}: {
  rows: CloseOutLine[];
  showReceipt: boolean;
  receiptHeading?: string;
}) {
  if (rows.length === 0)
    return <Text style={s.empty}>None — nothing outstanding in this section.</Text>;
  return (
    <View>
      <View style={s.tHead}>
        <Text style={[s.cell, { width: `${W.n}%` }]}>#</Text>
        <Text style={[s.cell, { width: `${W.date}%` }]}>Date</Text>
        <Text style={[s.cell, { width: `${showReceipt ? W.desc : W.desc + W.receipt}%` }]}>
          Description
        </Text>
        <Text style={[s.cell, s.right, { width: `${W.amount}%` }]}>Amount</Text>
        <Text style={[s.cell, { width: `${W.stmt}%` }]}>Statement</Text>
        {showReceipt && (
          <Text style={[s.cell, { width: `${W.receipt}%` }]}>{receiptHeading}</Text>
        )}
      </View>
      {rows.map((r) => (
        <View key={`${r.n}-${r.description}`} style={s.tRow} wrap={false}>
          <Text style={[s.cell, { width: `${W.n}%` }]}>{r.n}</Text>
          <Text style={[s.cell, { width: `${W.date}%` }]}>{r.date}</Text>
          <Text style={[s.cell, { width: `${showReceipt ? W.desc : W.desc + W.receipt}%` }]}>
            {r.description}
          </Text>
          <Text style={[s.cell, s.right, { width: `${W.amount}%` }]}>{r.amount}</Text>
          <Text style={[s.cell, s.muted, { width: `${W.stmt}%` }]}>{r.statements}</Text>
          {showReceipt && (
            <Text style={[s.cell, { width: `${W.receipt}%` }]}>{r.receipt || "—"}</Text>
          )}
        </View>
      ))}
    </View>
  );
}

export function CloseOutReportDocument(d: CloseOutReportData) {
  return (
    <Document title={`Close-Out ${d.generatedAt}`} author={d.company || d.userName}>
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Reconciliation — Close-Out</Text>
        <Text style={s.sub}>
          {d.company ? `${d.company} · ` : ""}
          {d.userName}
        </Text>
        <Text style={s.sub}>
          Covering {d.period}
          {d.periodInferred ? " (dates inferred from the transactions)" : ""} · produced{" "}
          {d.generatedAt}
        </Text>

        <Text style={s.sectionTitle}>Statements included</Text>
        {d.statements.map((st) => (
          <View key={st.name} style={s.summaryRow}>
            <Text style={s.summaryLabel}>
              {st.name} · {st.period}
            </Text>
            <Text style={s.summaryValue}>{st.lines} lines</Text>
          </View>
        ))}

        <Text style={s.sectionTitle}>Summary</Text>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>Real charges (after merging repeats)</Text>
          <Text style={s.summaryValue}>{d.totals.charges}</Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>Statement lines read</Text>
          <Text style={s.summaryValue}>{d.totals.rawLines}</Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>Total spend (each charge counted once)</Text>
          <Text style={s.summaryValue}>{d.totals.spendTotal}</Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>Repeated across overlapping statements</Text>
          <Text style={s.summaryValue}>{d.totals.duplicateSaving}</Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>1. Charges still needing a receipt</Text>
          <Text style={s.summaryValue}>
            {d.needsReceipt.length} · {d.totals.needsReceiptTotal}
          </Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>2. Receipts with no statement line</Text>
          <Text style={s.summaryValue}>
            {d.orphanReceipts.length} · {d.totals.orphanTotal}
          </Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>3. Matched, ready to send</Text>
          <Text style={s.summaryValue}>
            {d.matched.length} · {d.totals.matchedTotal}
          </Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>4. Already sent</Text>
          <Text style={s.summaryValue}>
            {d.alreadySent.length} · {d.totals.sentTotal}
          </Text>
        </View>
        <View style={s.summaryRow}>
          <Text style={s.summaryLabel}>5. Bank charges (no receipt exists)</Text>
          <Text style={s.summaryValue}>
            {d.bankCharges.length} · {d.totals.bankTotal}
          </Text>
        </View>

        <Text style={s.caution}>
          A charge appearing on more than one statement is listed ONCE here and counted once.
          Statement totals have not been read from the PDFs, so this list cannot yet prove
          every printed line was captured.
        </Text>

        <View style={s.footer} fixed>
          <Text>
            {d.company || d.userName} · close-out {d.generatedAt}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.sectionTitle}>1. Charges still needing a receipt</Text>
        <Text style={s.sectionNote}>
          These appear on a statement but no receipt has been found. This is the list to
          chase. Total {d.totals.needsReceiptTotal}.
        </Text>
        <Table rows={d.needsReceipt} showReceipt={false} />

        <Text style={s.sectionTitle}>2. Receipts with no statement line</Text>
        <Text style={s.sectionNote}>
          Paperwork that appears on none of the statements — cash, another card, or the
          statement is not uploaded yet. They are still included at the back. Total{" "}
          {d.totals.orphanTotal}.
        </Text>
        <Table rows={d.orphanReceipts} showReceipt={false} />

        <View style={s.footer} fixed>
          <Text>
            {d.company || d.userName} · close-out {d.generatedAt}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>

      <Page size="A4" style={s.page}>
        <Text style={s.sectionTitle}>3. Matched — receipt attached, ready to send</Text>
        <Text style={s.sectionNote}>Total {d.totals.matchedTotal}.</Text>
        <Table rows={d.matched} showReceipt />

        <Text style={s.sectionTitle}>4. Already sent to the accountant</Text>
        <Text style={s.sectionNote}>
          Reference only — no action. Total {d.totals.sentTotal}.
        </Text>
        <Table rows={d.alreadySent} showReceipt />

        <Text style={s.sectionTitle}>5. Bank charges — no receipt exists</Text>
        <Text style={s.sectionNote}>
          Fees, interest and payments to the card. Real money, included in the total above,
          but nothing to chase. Total {d.totals.bankTotal}.
        </Text>
        <Table rows={d.bankCharges} showReceipt={false} />

        <Text style={s.sectionTitle}>Receipt documents</Text>
        <Text style={s.sectionNote}>{d.appendixNote}</Text>

        <View style={s.footer} fixed>
          <Text>
            {d.company || d.userName} · close-out {d.generatedAt}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}
          />
        </View>
      </Page>
    </Document>
  );
}
