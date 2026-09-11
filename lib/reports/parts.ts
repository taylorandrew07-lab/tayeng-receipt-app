/**
 * Report parts: every receipt document must be OBTAINABLE.
 *
 * A PDF has to finish inside Vercel's 60-second limit, so the old close-out
 * report simply stopped at 60 documents and the rest could never be
 * downloaded at all. Now a report with more documents than fit is split into
 * numbered parts; each part is a complete, self-describing PDF and the route
 * announces the part count in a header so the screen can offer the rest.
 */
export const RECEIPTS_PER_PART = 40;

export type PartSlice<T> = {
  /** 1-based. */
  part: number;
  parts: number;
  /** 1-based number of the first document in this part. */
  first: number;
  /** 1-based number of the last document in this part (0 when empty). */
  last: number;
  items: T[];
};

export function slicePart<T>(
  all: T[],
  requested: string | null | undefined,
  perPart: number = RECEIPTS_PER_PART
): PartSlice<T> {
  const parts = Math.max(1, Math.ceil(all.length / perPart));
  const n = Number.parseInt(requested ?? "1", 10);
  const part = Number.isFinite(n) ? Math.min(Math.max(n, 1), parts) : 1;
  const start = (part - 1) * perPart;
  const items = all.slice(start, start + perPart);
  return { part, parts, first: items.length ? start + 1 : 0, last: start + items.length, items };
}

/** Lets the client offer "part 2 of 3" without guessing. */
export function partHeaders(p: { part: number; parts: number }): Record<string, string> {
  return {
    "X-Report-Part": String(p.part),
    "X-Report-Parts": String(p.parts),
    "Access-Control-Expose-Headers": "X-Report-Part, X-Report-Parts",
  };
}
