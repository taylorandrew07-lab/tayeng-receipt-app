import { describe, expect, it } from "vitest";
import { slicePart } from "./parts";
import { closeOutTotals } from "./closeout-totals";
import { closeOutAppendix } from "./closeout-appendix";
import type { ChargeRow, CloseOutData, OrphanRow } from "@/lib/reconciliation/types";

describe("slicePart — every attachment is obtainable", () => {
  const docs = Array.from({ length: 95 }, (_, i) => i + 1);

  it("splits into parts and says which documents each holds", () => {
    expect(slicePart(docs, "1", 40)).toMatchObject({ part: 1, parts: 3, first: 1, last: 40 });
    expect(slicePart(docs, "3", 40)).toMatchObject({ part: 3, parts: 3, first: 81, last: 95 });
  });

  it("covers every document exactly once across all parts", () => {
    const seen = [1, 2, 3].flatMap((p) => slicePart(docs, String(p), 40).items);
    expect(seen).toEqual(docs);
  });

  it("clamps a nonsense or out-of-range part instead of returning nothing", () => {
    expect(slicePart(docs, "99", 40).part).toBe(3);
    expect(slicePart(docs, "0", 40).part).toBe(1);
    expect(slicePart(docs, "abc", 40).part).toBe(1);
    expect(slicePart(docs, null, 40).part).toBe(1);
  });

  it("an empty report is one part with no documents", () => {
    expect(slicePart([], "1")).toMatchObject({ part: 1, parts: 1, first: 0, last: 0, items: [] });
  });
});

// ---------------------------------------------------------------------------
let seq = 0;
const charge = (over: Partial<ChargeRow>): ChargeRow => ({
  charge_id: `c${++seq}`,
  txn_date: "2026-08-01",
  description: "X",
  amount: 100,
  currency: "TTD",
  card_last4: "4881",
  canonical_txn_id: `t${seq}`,
  statement_ids: ["s1"],
  statement_names: ["s1.pdf"],
  copies: 1,
  is_duplicate: false,
  no_receipt_expected: false,
  fee_auto_flagged: false,
  match_id: null,
  receipt_id: null,
  receipt_vendor: null,
  receipt_date: null,
  receipt_amount: null,
  receipt_currency: null,
  receipt_sent: false,
  receipt_sent_at: null,
  pending_count: 0,
  best_confidence: null,
  state: "genuinely_new",
  ...over,
});
const orphan = (over: Partial<OrphanRow>): OrphanRow => ({
  receipt_id: `r${++seq}`,
  receipt_date: "2026-08-01",
  vendor_name: "Shop",
  ttd_amount: 50,
  amount: 50,
  currency: "TTD",
  sent: false,
  sent_at: null,
  paid: false,
  reimbursable: false,
  payment_method: "company_card",
  expected_on_statement: true,
  pending_count: 0,
  possible_duplicate_upload: false,
  ...over,
});

function data(over: Partial<CloseOutData>): CloseOutData {
  return {
    needsReceipt: [],
    needsConfirmation: [],
    readyToSend: [],
    alreadySent: [],
    bankCharges: [],
    clearedByHand: [],
    orphansOpen: [],
    orphansSent: [],
    reimbursables: [],
    attachable: [],
    statements: [],
    totals: {} as CloseOutData["totals"],
    ...over,
  };
}

describe("closeOutTotals — the cover ties back to the printed rows", () => {
  const d = data({
    needsReceipt: [charge({ amount: 100 })],
    readyToSend: [charge({ amount: 200, receipt_id: "r1", state: "already_matched" })],
    alreadySent: [charge({ amount: 300, copies: 2, receipt_id: "r2", state: "already_sent" })],
    bankCharges: [charge({ amount: 45, no_receipt_expected: true, fee_auto_flagged: true })],
    // Real purchases closed BY HAND — internal, and in NO figure below.
    clearedByHand: [charge({ amount: 1877.26, no_receipt_expected: true })],
  });
  const t = closeOutTotals(d);

  it("section totals add up exactly to the listed total", () => {
    expect(t.needsReceiptTotal + t.matchedTotal + t.sentTotal + t.bankTotal).toBe(t.listedTotal);
    expect(t.listedTotal).toBe(645);
    expect(t.listedCount).toBe(4);
  });

  it("a charge closed by hand appears in no total and no count", () => {
    expect(t.listedTotal).not.toBeGreaterThan(645);
    expect(t.listedCount).toBe(4);
    expect(t.listedLines).toBe(5); // 1 + 1 + 2 + 1 — the cleared charge's line is not counted
  });

  it("counts the value repeated across overlapping statements among listed charges", () => {
    expect(t.repeatedValue).toBe(300);
  });

  it("never adds a foreign-currency charge into a TTD total", () => {
    const f = closeOutTotals(
      data({ needsReceipt: [charge({ amount: 100 }), charge({ amount: 50, currency: "USD" })] })
    );
    expect(f.listedTotal).toBe(100);
    expect(f.foreignCurrencies).toEqual(["USD"]);
  });
});

describe("closeOutAppendix — one numbering, shared by the PDF and the screen", () => {
  it("numbers every document globally, matched first, and lists no cleared charge", () => {
    const items = closeOutAppendix(
      data({
        readyToSend: [charge({ receipt_id: "r1", receipt_vendor: "Amazon" })],
        alreadySent: [charge({ receipt_id: "r2", receipt_vendor: "BP" })],
        clearedByHand: [charge({ no_receipt_expected: true })],
        orphansOpen: [orphan({ receipt_id: "o1" })],
        orphansSent: [orphan({ receipt_id: "o2" })],
      })
    );
    expect(items.map((i) => i.receiptId)).toEqual(["r1", "r2", "o1", "o2"]);
    expect(items.map((i) => i.label.split(" · ")[0])).toEqual(["#1", "#2", "#3", "#4"]);
    expect(items[2].label).toMatch(/NO STATEMENT LINE/);
  });
});
