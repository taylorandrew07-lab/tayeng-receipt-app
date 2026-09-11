import { describe, expect, it } from "vitest";
import { removeReceiptsSafely, type RemoveClient } from "./remove";

/**
 * A fake of exactly the calls removeReceiptsSafely makes, recording whether
 * storage was ever asked to delete anything.
 */
function fakeClient(opts: {
  files: { receipt_id: string; storage_path: string }[];
  deleted: string[] | "error";
}) {
  const removed: string[][] = [];
  const client: RemoveClient = {
    from: () => ({
      select: () => ({
        in: async () => ({ data: opts.files, error: null }),
      }),
      delete: () => ({
        in: () => ({
          select: async () =>
            opts.deleted === "error"
              ? { data: null, error: { message: "boom" } }
              : { data: opts.deleted.map((id) => ({ id })), error: null },
        }),
      }),
    }),
    storage: {
      from: () => ({
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
      }),
    },
  };
  return { client, removed };
}

const files = [
  { receipt_id: "r1", storage_path: "u/r1/a.pdf" },
  { receipt_id: "r2", storage_path: "u/r2/b.jpg" },
];

describe("removeReceiptsSafely — files never outlive a FAILED delete", () => {
  it("removes no file at all when the database delete errors", async () => {
    const { client, removed } = fakeClient({ files, deleted: "error" });
    const res = await removeReceiptsSafely(client, ["r1", "r2"]);
    expect(res.ok).toBe(false);
    expect(removed).toEqual([]);
  });

  // The silent case: RLS filters the delete to zero rows and reports no error.
  // The old code treated "no error" as success and removed the documents.
  it("removes no file when the delete silently affects zero rows", async () => {
    const { client, removed } = fakeClient({ files, deleted: [] });
    const res = await removeReceiptsSafely(client, ["r1", "r2"]);
    expect(res.ok).toBe(false);
    expect(removed).toEqual([]);
  });

  it("on a partial delete, removes only the files of receipts actually deleted", async () => {
    const { client, removed } = fakeClient({ files, deleted: ["r1"] });
    const res = await removeReceiptsSafely(client, ["r1", "r2"]);
    expect(res).toMatchObject({ ok: false, count: 1 });
    expect(removed).toEqual([["u/r1/a.pdf"]]);
  });

  it("removes every file after a full delete", async () => {
    const { client, removed } = fakeClient({ files, deleted: ["r1", "r2"] });
    const res = await removeReceiptsSafely(client, ["r1", "r2"]);
    expect(res).toMatchObject({ ok: true, count: 2 });
    expect(removed).toEqual([["u/r1/a.pdf", "u/r2/b.jpg"]]);
  });
});
