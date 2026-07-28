import { describe, expect, it } from "vitest";
import { fetchAll } from "./paginate";

function pagedSource(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls: Array<[number, number]> = [];
  const build = (from: number, to: number) => {
    calls.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  };
  return { build, calls };
}

describe("fetchAll", () => {
  it("returns everything when the table is smaller than one page", async () => {
    const { build, calls } = pagedSource(42);
    expect(await fetchAll(build)).toHaveLength(42);
    expect(calls).toEqual([[0, 999]]);
  });

  it("keeps paging past the 1000-row cap that silently truncated these queries", async () => {
    const { build, calls } = pagedSource(2350);
    const all = await fetchAll(build);
    expect(all).toHaveLength(2350);
    expect(all[2349]).toEqual({ id: 2349 });
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("makes one extra request when the total is an exact multiple of the page size", async () => {
    // The dangerous case: a full page is indistinguishable from the cap, so we
    // must ask again rather than assume we are done.
    const { build, calls } = pagedSource(1000);
    expect(await fetchAll(build)).toHaveLength(1000);
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("throws rather than silently returning a partial result", async () => {
    await expect(
      fetchAll(() => Promise.resolve({ data: null, error: { message: "boom" } }))
    ).rejects.toThrow("boom");
  });

  it("handles an empty table", async () => {
    const { build } = pagedSource(0);
    expect(await fetchAll(build)).toEqual([]);
  });
});
