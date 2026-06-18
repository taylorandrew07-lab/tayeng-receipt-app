import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

export type BillBackItem = {
  n: number;
  date: string;
  vendor: string;
  amount: string;
};

export type BillBackGroup = {
  name: string;
  type: string; // "client" | "vessel"
  total: string;
  items: BillBackItem[];
};

export type BillBackReportData = {
  company: string;
  userName: string;
  period: string;
  groups: BillBackGroup[];
  grandTotal: string;
};

const s = StyleSheet.create({
  page: { padding: 32, fontSize: 10, color: "#0f172a", fontFamily: "Helvetica" },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold" },
  sub: { fontSize: 10, color: "#64748b", marginTop: 3 },
  grand: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1.5,
    borderTopColor: "#0f172a",
  },
  groupHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: "#f3e8ff",
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginTop: 16,
    borderRadius: 3,
  },
  groupName: { fontSize: 12, fontFamily: "Helvetica-Bold", color: "#581c87" },
  groupTotal: { fontSize: 12, fontFamily: "Helvetica-Bold", color: "#581c87" },
  tHead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#cbd5e1",
    paddingVertical: 4,
    paddingHorizontal: 4,
    color: "#64748b",
    fontSize: 9,
  },
  tRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#eef2f7",
  },
  cell: { paddingHorizontal: 2 },
});

export function BillBackReportDocument(data: BillBackReportData) {
  return (
    <Document>
      <Page size="A4" style={s.page}>
        <Text style={s.h1}>Bill-Back Expenses</Text>
        <Text style={s.sub}>
          {data.company ? `${data.company} · ` : ""}
          {data.userName}
        </Text>
        <Text style={s.sub}>{data.period}</Text>

        <View style={s.grand}>
          <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold" }}>
            GRAND TOTAL (TTD)
          </Text>
          <Text style={{ fontSize: 13, fontFamily: "Helvetica-Bold" }}>
            {data.grandTotal}
          </Text>
        </View>

        {data.groups.map((g) => (
          <View key={`${g.type}:${g.name}`} wrap={false}>
            <View style={s.groupHead}>
              <Text style={s.groupName}>
                {g.name}{" "}
                <Text style={{ fontSize: 9, fontFamily: "Helvetica" }}>
                  ({g.type})
                </Text>
              </Text>
              <Text style={s.groupTotal}>{g.total}</Text>
            </View>
            <View style={s.tHead}>
              <Text style={[s.cell, { width: "8%" }]}>#</Text>
              <Text style={[s.cell, { width: "20%" }]}>Date</Text>
              <Text style={[s.cell, { width: "52%" }]}>Vendor</Text>
              <Text style={[s.cell, { width: "20%", textAlign: "right" }]}>Amount</Text>
            </View>
            {g.items.map((it) => (
              <View style={s.tRow} key={it.n}>
                <Text style={[s.cell, { width: "8%" }]}>{it.n}</Text>
                <Text style={[s.cell, { width: "20%" }]}>{it.date}</Text>
                <Text style={[s.cell, { width: "52%" }]}>{it.vendor}</Text>
                <Text style={[s.cell, { width: "20%", textAlign: "right" }]}>{it.amount}</Text>
              </View>
            ))}
          </View>
        ))}
      </Page>
    </Document>
  );
}
