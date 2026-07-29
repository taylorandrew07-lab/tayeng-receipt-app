import { describe, expect, it } from "vitest";
import { classify } from "./classify";
import type { ExtractionResult } from "@/lib/types";

const base: ExtractionResult = {
  doc_type: "invoice",
  receipt_date: "2026-05-18",
  vendor_name: "Parc Rayne",
  amount: 85417.05,
  currency: "GYD",
  usd_equivalent: 406.75,
  tax_amount: 10489.82,
  payment_method: "company_card",
  card_last4: null,
  category_guess: "Travel",
  confidence: 95,
  notes: null,
};

const run = (e: Partial<ExtractionResult>) =>
  classify({
    extraction: { ...base, ...e },
    cards: [],
    categories: [{ id: "cat1", user_id: "u", name: "Travel", is_default: true, created_at: "" }],
    rules: [],
    usdToTtdRate: 6.8,
    uploadedAt: new Date("2026-07-29"),
  });

describe("classify — currencies beyond TTD and USD", () => {
  it("values a GYD invoice from the USD figure printed on it", () => {
    const r = run({});
    // GYD 85,417.05 is meaningless to us; USD 406.75 x 6.8 is not.
    expect(r.ttd_amount).toBeCloseTo(2765.9, 2);
    expect(r.currency).toBe("GYD");
    expect(r.amount).toBe(85417.05);
  });

  it("lands close enough to the real statement charge to be matchable", () => {
    // The statement charged TTD 2,755.64 for this stay. The gap is the bank's
    // FX rate vs ours, and must stay inside the board's 0.75% cross-currency
    // tolerance or the receipt can never be flagged as an exact match.
    const r = run({});
    const statementCharge = 2755.64;
    const drift = Math.abs((r.ttd_amount as number) - statementCharge) / statementCharge;
    expect(drift).toBeLessThan(0.0075);
  });

  it("refuses to invent a figure when no USD amount is printed", () => {
    const r = run({ usd_equivalent: null });
    expect(r.ttd_amount).toBeNull();
    expect(r.status).toBe("needs_review");
  });

  it("still handles plain TTD and USD", () => {
    expect(run({ currency: "TTD", amount: 100, usd_equivalent: null }).ttd_amount).toBe(100);
    expect(run({ currency: "USD", amount: 100, usd_equivalent: null }).ttd_amount).toBeCloseTo(680, 2);
  });

  it("flags a converted receipt for review rather than silently confirming it", () => {
    expect(run({}).status).toBe("needs_review");
  });
});
