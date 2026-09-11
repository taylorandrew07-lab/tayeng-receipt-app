import { describe, expect, it } from "vitest";
import { duplicateKeys, type DupSource } from "./duplicates";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

const r = (over: Partial<DupSource>): DupSource => ({
  receipt_date: null,
  vendor_name: null,
  ttd_amount: null,
  amount: null,
  card_last4: null,
  contentHash: null,
  ...over,
});
const same = (a: DupSource, b: DupSource) => {
  const k = new Set(duplicateKeys(a));
  return duplicateKeys(b).some((x) => k.has(x));
};

describe("duplicateKeys — by content, never by file name", () => {
  // The regression: "IMG_0001.jpg" from two different days, or two different
  // suppliers' "invoice.pdf", were flagged duplicates and dropped from every
  // report. A name is no longer a key at all.
  it("two unrelated documents that share a file name are NOT duplicates", () => {
    const a = r({ contentHash: H1, vendor_name: "Amazon", ttd_amount: 100, receipt_date: "2026-08-01" });
    const b = r({ contentHash: H2, vendor_name: "Star Petrol", ttd_amount: 250, receipt_date: "2026-08-09" });
    expect(same(a, b)).toBe(false);
  });

  it("the same bytes uploaded twice ARE duplicates, whatever the extraction says", () => {
    expect(same(r({ contentHash: H1, vendor_name: "A" }), r({ contentHash: H1, vendor_name: "B" }))).toBe(true);
  });

  it("still catches a re-photographed receipt: same vendor, amount and date", () => {
    const a = r({ contentHash: H1, vendor_name: "Amazon.com", ttd_amount: 648.14, receipt_date: "2026-07-15" });
    const b = r({ contentHash: H2, vendor_name: "AMAZON.COM", ttd_amount: 648.14, receipt_date: "2026-07-15" });
    expect(same(a, b)).toBe(true);
  });

  it("two genuine same-amount purchases on different days are not duplicates", () => {
    const a = r({ vendor_name: "Star Petrol", ttd_amount: 250, receipt_date: "2026-08-01" });
    const b = r({ vendor_name: "Star Petrol", ttd_amount: 250, receipt_date: "2026-08-02" });
    expect(same(a, b)).toBe(false);
  });

  it("ignores a malformed hash rather than keying on it", () => {
    expect(duplicateKeys(r({ contentHash: "not-a-hash" }))).toEqual([]);
  });
});
