import { describe, expect, it } from "vitest";
import { validateParsedStatement, type ParsedForValidation, type ParsedLine } from "./validate";

const TODAY = new Date("2026-09-11T12:00:00Z");

const debit = (over: Partial<ParsedLine> = {}): ParsedLine => ({
  date: "2026-08-03",
  description: "AMAZON MKTPL",
  amount: 100,
  direction: "debit",
  currency: "TTD",
  card_last4: null,
  ...over,
});

const parsed = (over: Partial<ParsedForValidation> = {}): ParsedForValidation => ({
  document_kind: "credit_card",
  total_purchases: 150,
  transactions: [debit(), debit({ amount: 50 })],
  ...over,
});

const NEW = { lineCount: 0, reconciled: null };

describe("validateParsedStatement — decided BEFORE anything is changed", () => {
  it("accepts a clean credit card reading", () => {
    const v = validateParsedStatement(parsed(), NEW, TODAY);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.lineTotal).toBe(150);
  });

  it("refuses a bank account statement", () => {
    const v = validateParsedStatement(parsed({ document_kind: "bank_account" }), NEW, TODAY);
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/bank account/) });
  });

  // Previously only bank_account was refused; 'other' went straight through to
  // the delete-and-insert with whatever lines the model imagined.
  it("refuses a document that is not a statement at all", () => {
    const v = validateParsedStatement(parsed({ document_kind: "other" }), NEW, TODAY);
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/right file/) });
  });

  it("never lets a reading of NOTHING replace existing lines", () => {
    const v = validateParsedStatement(
      parsed({ transactions: [] }),
      { lineCount: 26, reconciled: null },
      TODAY
    );
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/26 lines .* were kept/) });
  });

  it("counts credits separately and does not store them as charges", () => {
    const v = validateParsedStatement(
      parsed({
        transactions: [
          debit(),
          debit({ amount: 50 }),
          debit({ description: "PAYMENT THANK YOU", amount: 5000, direction: "credit" }),
        ],
      }),
      NEW,
      TODAY
    );
    expect(v.ok && v.debits.length).toBe(2);
    expect(v.ok && v.creditsExcluded).toBe(1);
  });

  it.each([
    ["a negative amount", { amount: -5 }],
    ["a zero amount", { amount: 0 }],
    ["a malformed date", { date: "03/08/2026" }],
    ["an impossible date", { date: "2026-02-30" }],
    ["a date far in the future", { date: "2027-06-01" }],
    ["a date before 2000", { date: "1999-12-31" }],
  ])("refuses a reading containing %s", (_l, patch) => {
    const v = validateParsedStatement(
      parsed({ transactions: [debit(), debit(patch as Partial<ParsedLine>)] }),
      NEW,
      TODAY
    );
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/impossible/) });
  });

  it("accepts an undated line — we store what we can't read as unknown", () => {
    expect(
      validateParsedStatement(parsed({ transactions: [debit({ date: null })], total_purchases: 100 }), NEW, TODAY).ok
    ).toBe(true);
  });

  // The conflicting-control-totals case: never swap a reading that provably
  // adds up for one that provably does not.
  it("keeps existing lines that add up over a new reading that does not", () => {
    const v = validateParsedStatement(
      parsed({ total_purchases: 999 }),
      { lineCount: 2, reconciled: true },
      TODAY
    );
    expect(v).toMatchObject({ ok: false, reason: expect.stringMatching(/DO add up, so they were kept/) });
  });

  it("does replace unreconciled lines with a reading that adds up", () => {
    expect(
      validateParsedStatement(parsed(), { lineCount: 2, reconciled: false }, TODAY).ok
    ).toBe(true);
  });
});
