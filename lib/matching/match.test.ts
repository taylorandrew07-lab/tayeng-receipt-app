import { describe, expect, it } from "vitest";
import {
  matchReceipts,
  scorePairDetail,
  withinReceiptWindow,
  type MatchReceipt,
  type MatchTxn,
} from "./match";

const settings = { dateToleranceDays: 3, amountTolerancePct: 5 };

const txn = (over: Partial<MatchTxn> = {}): MatchTxn => ({
  id: "t1",
  txn_date: "2026-07-15",
  description: "AMAZON MKTPL*3A0EU8Q23 Amzn.com/billWA",
  amount: 648.14,
  card_last4: "4881",
  ...over,
});

const receipt = (over: Partial<MatchReceipt> = {}): MatchReceipt => ({
  id: "r1",
  receipt_date: "2026-07-14",
  vendor_name: "Amazon.com",
  ttd_amount: 648.14,
  card_last4: "4881",
  ...over,
});

describe("scorePairDetail", () => {
  it("scores an exact same-week pair very high and lets it auto-confirm", () => {
    const s = scorePairDetail(txn(), receipt(), settings);
    expect(s.confidence).toBeGreaterThanOrEqual(75);
    expect(s.datesAgree).toBe(true);
  });

  it("still scores a distant same-vendor, same-amount pair high but blocks auto-confirm", () => {
    // The live case: a 654.77 Amazon receipt from 29 Apr scored 78 against a
    // 648.14 Amazon charge on 15 Jul and was auto-confirmed, closing a charge
    // whose real receipt had never been uploaded.
    const s = scorePairDetail(
      txn(),
      receipt({ receipt_date: "2026-04-29", ttd_amount: 654.77 }),
      settings
    );
    expect(s.confidence).toBeGreaterThanOrEqual(75);
    expect(s.datesAgree).toBe(false);
  });

  it("treats an unknown date as never agreeing", () => {
    expect(scorePairDetail(txn(), receipt({ receipt_date: null }), settings).datesAgree).toBe(
      false
    );
    expect(scorePairDetail(txn({ txn_date: null }), receipt(), settings).datesAgree).toBe(false);
  });

  it("rejects a pair whose amount is nowhere near", () => {
    expect(scorePairDetail(txn(), receipt({ ttd_amount: 1200 }), settings).confidence).toBe(0);
  });
});

describe("matchReceipts", () => {
  it("auto-confirms only when the dates agree", () => {
    const near = matchReceipts([txn()], [receipt()], settings);
    expect(near.pairings[0].status).toBe("matched");

    const far = matchReceipts(
      [txn()],
      [receipt({ receipt_date: "2026-04-29", ttd_amount: 654.77 })],
      settings
    );
    expect(far.pairings[0].status).toBe("possible_match");
    expect(far.pairings[0].confidence).toBeGreaterThanOrEqual(75);
  });

  it("prefers the closer receipt when two are plausible, one each way", () => {
    const out = matchReceipts(
      [txn(), txn({ id: "t2", txn_date: "2026-04-30", amount: 654.77 })],
      [receipt(), receipt({ id: "r2", receipt_date: "2026-04-29", ttd_amount: 654.77 })],
      settings
    );
    const pick = Object.fromEntries(out.pairings.map((p) => [p.transaction_id, p.receipt_id]));
    expect(pick.t1).toBe("r1");
    expect(pick.t2).toBe("r2");
  });

  it("uses each receipt at most once and reports what is left over", () => {
    const out = matchReceipts([txn()], [receipt(), receipt({ id: "r2" })], settings);
    expect(out.pairings).toHaveLength(1);
    expect(out.unmatchedReceiptIds).toHaveLength(1);
    expect(out.missingReceiptTxnIds).toHaveLength(0);
  });
});

describe("withinReceiptWindow", () => {
  // Andrew's decided scope: 60 days before period_start, 15 days after
  // period_end. Stored in user_settings since 0014 and, until now, never read.
  const start = "2026-07-14";
  const end = "2026-08-17";
  const inWindow = (d: string | null) => withinReceiptWindow(d, start, end, 60, 15);

  it("accepts a receipt inside the period", () => {
    expect(inWindow("2026-07-20")).toBe(true);
  });

  it("accepts a receipt within the before-window and rejects one past it", () => {
    expect(inWindow("2026-05-16")).toBe(true); // 59 days before
    expect(inWindow("2026-05-10")).toBe(false); // 65 days before
  });

  it("accepts a receipt within the after-window and rejects one past it", () => {
    expect(inWindow("2026-08-30")).toBe(true); // 13 days after
    expect(inWindow("2026-09-08")).toBe(false); // 22 days after
  });

  it("never excludes an undated receipt", () => {
    // We cannot judge it, and dropping it would hide it from matching
    // entirely. Its missing date already blocks auto-confirmation.
    expect(inWindow(null)).toBe(true);
  });
});

describe("matchReceipts options", () => {
  it("never auto-confirms when auto-confirm is off", () => {
    // user_settings.auto_confirm_enabled is false by design (0014): "the
    // consolidated run produces suggestions, not confirmations".
    const out = matchReceipts([txn()], [receipt()], settings, { autoConfirm: false });
    expect(out.pairings[0].status).toBe("possible_match");
    expect(out.pairings[0].confidence).toBeGreaterThanOrEqual(75);
  });

  it("never re-offers a pair the user rejected", () => {
    const out = matchReceipts([txn()], [receipt()], settings, {
      isBlocked: (t, r) => t === "t1" && r === "r1",
    });
    expect(out.pairings).toHaveLength(0);
    expect(out.missingReceiptTxnIds).toEqual(["t1"]);
  });

  it("gives the receipt to its next-best charge when the best pair is blocked", () => {
    // Blocking must happen BEFORE the greedy assignment, or the rejected pair
    // consumes the receipt and then gets discarded, stranding both sides.
    const out = matchReceipts(
      [txn(), txn({ id: "t2", txn_date: "2026-07-16" })],
      [receipt()],
      settings,
      { isBlocked: (t, r) => t === "t1" && r === "r1" }
    );
    expect(out.pairings).toHaveLength(1);
    expect(out.pairings[0].transaction_id).toBe("t2");
  });
});
