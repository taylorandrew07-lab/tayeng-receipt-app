import { describe, expect, it } from "vitest";
import { receiptStage, type StageInput } from "./stage";

const r = (over: Partial<StageInput> = {}): StageInput => ({
  status: "confirmed",
  duplicate_of: null,
  payment_method: "company_card",
  sent: false,
  paid: false,
  ...over,
});

describe("receiptStage — reconciled, awaiting review, ready to send, sent", () => {
  it("distinguishes the four states that 'Confirmed' used to blur together", () => {
    expect(receiptStage(r(), false).label).toBe("Waiting for a statement line");
    expect(receiptStage(r(), true).label).toBe("Matched · ready to send");
    expect(receiptStage(r({ sent: true }), true).label).toBe("Sent to accountant");
    expect(receiptStage(r({ status: "needs_review" }), false).label).toBe("Needs review");
  });

  it("follows a reimbursable through claim and payment", () => {
    expect(receiptStage(r({ payment_method: "cash" }), false).label).toBe("Ready to claim");
    expect(receiptStage(r({ payment_method: "cash", sent: true }), false).label).toBe(
      "Claimed · awaiting payment"
    );
    expect(receiptStage(r({ payment_method: "personal_card", sent: true, paid: true }), false).label).toBe(
      "Paid back"
    );
  });

  it("treats an unknown payment method as expected on the statement (0021)", () => {
    expect(receiptStage(r({ payment_method: "unknown" }), false).label).toBe(
      "Waiting for a statement line"
    );
  });

  it("puts review and duplicates ahead of everything else", () => {
    expect(receiptStage(r({ duplicate_of: "x", sent: true }), true).label).toBe("Possible duplicate");
    expect(receiptStage(r({ status: "processing" }), true).label).toBe("Reading…");
  });
});
