import { describe, expect, it } from "vitest";
import {
  chargeIneligibility,
  oneLinePerCharge,
  receiptIneligibility,
  selectCandidates,
  selectOpenLines,
  type CandidateReceipt,
} from "./eligibility";

const ok = {
  status: "confirmed",
  duplicate_of: null,
  ttd_amount: 100,
  payment_method: "company_card",
};

describe("receiptIneligibility — one rule for run, attach and confirm", () => {
  it("accepts an ordinary company-card receipt", () => {
    expect(receiptIneligibility(ok)).toBeNull();
  });

  it.each([
    ["a flagged duplicate", { duplicate_of: "r0" }, /duplicate/],
    ["a receipt still in review", { status: "needs_review" }, /review/],
    ["a receipt with no TTD amount", { ttd_amount: null }, /TTD amount/],
    ["a cash receipt", { payment_method: "cash" }, /cash or on a personal card/],
    ["a personal-card receipt", { payment_method: "personal_card" }, /personal card/],
  ])("refuses %s, and says why", (_label, patch, reason) => {
    expect(receiptIneligibility({ ...ok, ...patch })).toMatch(reason);
  });

  // 0021: decided by payment_method alone. These can't be proven off-card, so
  // they must stay matchable — hiding them is the worst failure available.
  it.each(["unknown", "online", "other"])("keeps a '%s' receipt matchable", (pm) => {
    expect(receiptIneligibility({ ...ok, payment_method: pm })).toBeNull();
  });
});

describe("chargeIneligibility — closed charges", () => {
  it("refuses a closed charge until it is reopened", () => {
    expect(chargeIneligibility({ no_receipt_expected: true })).toMatch(/Reopen/);
    expect(chargeIneligibility({ no_receipt_expected: false })).toBeNull();
  });
});

describe("oneLinePerCharge — overlapping statement copies", () => {
  it("collapses copies of one charge to a single line", () => {
    const out = oneLinePerCharge([
      { id: "b", charge_id: "c1", txn_date: "2026-07-20" },
      { id: "a", charge_id: "c1", txn_date: "2026-07-18" },
      { id: "c", charge_id: "c2", txn_date: "2026-07-19" },
    ]);
    expect(out.map((l) => l.id).sort()).toEqual(["a", "c"]);
  });

  it("keeps the same canonical copy as charge_reconciliation (date, created_at, id)", () => {
    const pick = (lines: Parameters<typeof oneLinePerCharge>[0]) =>
      oneLinePerCharge(lines)[0].id;
    // Earliest date wins.
    expect(
      pick([
        { id: "z", charge_id: "c", txn_date: "2026-07-01" },
        { id: "a", charge_id: "c", txn_date: "2026-07-02" },
      ])
    ).toBe("z");
    // Same date: earliest created_at wins, whatever the id.
    expect(
      pick([
        { id: "a", charge_id: "c", txn_date: "2026-07-01", created_at: "2026-07-09T10:00:00Z" },
        { id: "z", charge_id: "c", txn_date: "2026-07-01", created_at: "2026-07-08T10:00:00Z" },
      ])
    ).toBe("z");
    // A dated copy beats an undated one (nulls last).
    expect(
      pick([
        { id: "a", charge_id: "c", txn_date: null },
        { id: "z", charge_id: "c", txn_date: "2026-07-05" },
      ])
    ).toBe("z");
  });

  it("gives the same answer whatever order the rows arrive in", () => {
    const rows = [
      { id: "b", charge_id: "c", txn_date: "2026-07-01", created_at: "t2" },
      { id: "a", charge_id: "c", txn_date: "2026-07-01", created_at: "t2" },
      { id: "c", charge_id: "c", txn_date: "2026-07-01", created_at: "t2" },
    ];
    expect(oneLinePerCharge(rows)[0].id).toBe("a");
    expect(oneLinePerCharge([...rows].reverse())[0].id).toBe("a");
  });

  it("keeps lines that have no charge yet", () => {
    expect(oneLinePerCharge([{ id: "x", charge_id: null, txn_date: null }])).toHaveLength(1);
  });
});

describe("selectOpenLines — what a run hunts for", () => {
  const lines = [
    { id: "t1", charge_id: "open", txn_date: "2026-07-01" },
    { id: "t2", charge_id: "open", txn_date: "2026-07-02" }, // overlapping copy
    { id: "t3", charge_id: "covered", txn_date: "2026-07-01" },
    { id: "t4", charge_id: "closed", txn_date: "2026-07-01" },
  ];

  it("hunts once per open charge, and never for covered or closed ones", () => {
    const out = selectOpenLines(lines, {
      confirmedTxnIds: new Set(),
      // "covered" has its receipt on ANOTHER statement's copy — the txn-id
      // check alone would miss it.
      confirmedChargeIds: new Set(["covered"]),
      closedChargeIds: new Set(["closed"]),
    });
    expect(out.map((l) => l.id)).toEqual(["t1"]);
  });

  it("never auto-scores a line in another currency against a TTD receipt", () => {
    const out = selectOpenLines(
      [
        { id: "ttd", charge_id: "a", txn_date: "2026-07-01", currency: "TTD" },
        { id: "usd", charge_id: "b", txn_date: "2026-07-01", currency: "USD" },
      ],
      { confirmedTxnIds: new Set(), confirmedChargeIds: new Set(), closedChargeIds: new Set() }
    );
    expect(out.map((l) => l.id)).toEqual(["ttd"]);
  });

  it("puts a closed charge back once it is reopened", () => {
    const out = selectOpenLines(lines, {
      confirmedTxnIds: new Set(),
      confirmedChargeIds: new Set(["covered"]),
      closedChargeIds: new Set(), // reopened
    });
    expect(out.map((l) => l.id).sort()).toEqual(["t1", "t4"]);
  });
});

describe("selectCandidates — the date window and its exemption", () => {
  const scope = {
    confirmedReceiptIds: new Set<string>(),
    periodStart: "2026-07-14",
    periodEnd: "2026-08-17",
    windowBefore: 60,
    windowAfter: 15,
  };
  const r = (over: Partial<CandidateReceipt>): CandidateReceipt => ({
    ...ok,
    id: "r",
    receipt_date: "2026-07-20",
    sent: false,
    ...over,
  });

  it("drops an old unsent receipt outside the window", () => {
    expect(selectCandidates([r({ receipt_date: "2026-03-01" })], scope)).toHaveLength(0);
  });

  // Andrew's decided exemption (2026-07-28). Without it an old charge that
  // reappears on a new overlapping statement is reported "missing" even
  // though its receipt was found and sent months ago.
  it("keeps an old SENT receipt regardless of age", () => {
    expect(
      selectCandidates([r({ receipt_date: "2026-03-01", sent: true })], scope)
    ).toHaveLength(1);
  });

  it("never offers a receipt that is already confirmed elsewhere", () => {
    expect(
      selectCandidates([r({ id: "taken" })], {
        ...scope,
        confirmedReceiptIds: new Set(["taken"]),
      })
    ).toHaveLength(0);
  });

  it("applies the shared eligibility rule — a cash receipt is never offered", () => {
    expect(selectCandidates([r({ payment_method: "cash" })], scope)).toHaveLength(0);
  });
});
