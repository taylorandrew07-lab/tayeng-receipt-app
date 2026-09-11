import { describe, expect, it } from "vitest";
import { receiptMoneyProblem, type ReceiptMoneyInput } from "./validate";

const TODAY = new Date("2026-09-11T12:00:00Z");
const ok: ReceiptMoneyInput = {
  currency: "TTD",
  amount: 250,
  ttd_amount: 250,
  tax_amount: 31.25,
  receipt_date: "2026-09-01",
};
const problem = (patch: Partial<ReceiptMoneyInput>) => receiptMoneyProblem({ ...ok, ...patch }, TODAY);

describe("receiptMoneyProblem — sound money before a receipt is confirmed", () => {
  it("accepts a sound TTD receipt", () => {
    expect(problem({})).toBeNull();
  });

  it("accepts a USD receipt whose TTD amount is its converted value", () => {
    expect(problem({ currency: "USD", amount: 36.76, ttd_amount: 250 })).toBeNull();
  });

  // The "inconsistent TTD edit": change one field, forget the other, and the
  // report prints two different figures for the same purchase.
  it("refuses a TTD receipt whose TTD amount differs from its amount", () => {
    expect(problem({ amount: 250, ttd_amount: 205 })).toMatch(/must be the same/);
  });

  it("refuses a confirmed receipt with no TTD amount", () => {
    expect(problem({ ttd_amount: null })).toMatch(/TTD amount/);
  });

  it.each([
    ["no amount", { amount: null }],
    ["a zero amount", { amount: 0, ttd_amount: 0 }],
    ["a negative amount", { amount: -5, ttd_amount: -5 }],
  ])("refuses %s", (_l, patch) => {
    expect(problem(patch as Partial<ReceiptMoneyInput>)).not.toBeNull();
  });

  it("refuses tax larger than the receipt, or negative tax", () => {
    expect(problem({ tax_amount: 300 })).toMatch(/more than the whole/);
    expect(problem({ tax_amount: -1 })).toMatch(/negative/);
  });

  it("refuses an impossible or far-future date", () => {
    expect(problem({ receipt_date: "2026-02-30" })).toMatch(/isn't possible/);
    expect(problem({ receipt_date: "2099-01-01" })).toMatch(/isn't possible/);
  });

  it("refuses a currency that is not a three-letter code", () => {
    expect(problem({ currency: "DOLLARS" })).toMatch(/three-letter/);
  });
});
