import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addOmissionsPage, appendReceiptDocuments, pdfSafe } from "./append-receipts";

/** A real PDF with `pages` pages, as bytes. */
async function pdfWith(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

type Stored = { bytes?: Uint8Array; fail?: boolean; size?: number };

/** Fakes exactly the two Supabase calls appendReceiptDocuments makes. */
function fakeSupabase(files: Record<string, Stored>, opts: { listError?: boolean } = {}) {
  const rows = Object.keys(files).map((id) => ({
    receipt_id: id,
    storage_path: `p/${id}`,
    mime_type: "application/pdf",
    file_name: `${id}.pdf`,
    created_at: "2026-01-01",
  }));
  const chain = {
    select: () => chain,
    in: () => chain,
    order: () => chain,
    then: (res: (v: unknown) => unknown) =>
      Promise.resolve(
        opts.listError ? { data: null, error: { message: "db down" } } : { data: rows, error: null }
      ).then(res),
  };
  return {
    from: () => chain,
    storage: {
      from: () => ({
        download: async (path: string) => {
          const f = files[path.slice(2)];
          if (!f || f.fail) return { data: null, error: { message: "gone" } };
          const bytes = f.bytes ?? new Uint8Array();
          return {
            data: { size: f.size ?? bytes.byteLength, arrayBuffer: async () => bytes.buffer },
            error: null,
          };
        },
      }),
    },
  } as unknown as SupabaseClient;
}

const item = (id: string) => ({ receiptId: id, label: `#${id} · Vendor ${id}` });

describe("appendReceiptDocuments — every item embedded or accounted for", () => {
  it("embeds documents and reports nothing omitted when all is well", async () => {
    const merged = await PDFDocument.create();
    const sb = fakeSupabase({ a: { bytes: await pdfWith(2) }, b: { bytes: await pdfWith(1) } });
    const res = await appendReceiptDocuments(merged, sb, [item("a"), item("b")]);
    expect(res).toEqual({ embedded: 2, omitted: [], notReached: 0 });
    expect(merged.getPageCount()).toBe(3);
  });

  // Previously truncated SILENTLY at 20 pages.
  it("names the pages it leaves out of a long document", async () => {
    const merged = await PDFDocument.create();
    const res = await appendReceiptDocuments(
      merged,
      fakeSupabase({ long: { bytes: await pdfWith(25) } }),
      [item("long")]
    );
    expect(res.embedded).toBe(1);
    expect(res.omitted).toEqual([
      { label: "#long · Vendor long", reason: expect.stringMatching(/pages 21–25 of 25 not included/) },
    ]);
    expect(merged.getPageCount()).toBe(20);
  });

  it("lists each missing, failed or oversized document by name, and never counts it as embedded", async () => {
    const merged = await PDFDocument.create();
    const res = await appendReceiptDocuments(
      merged,
      fakeSupabase({
        ok: { bytes: await pdfWith(1) },
        broken: { fail: true },
        huge: { bytes: new Uint8Array(8), size: 30 * 1024 * 1024 },
      }),
      [item("ok"), item("broken"), item("huge"), item("nofile")]
    );
    expect(res.embedded).toBe(1);
    expect(res.omitted.map((o) => o.label)).toEqual([
      "#broken · Vendor broken",
      "#huge · Vendor huge",
      "#nofile · Vendor nofile",
    ]);
    expect(res.omitted.map((o) => o.reason)).toEqual([
      "the document could not be downloaded",
      "the document is larger than 25 MB",
      "no document is attached to this receipt",
    ]);
  });

  it("past the deadline, lists every document not reached", async () => {
    const merged = await PDFDocument.create();
    const res = await appendReceiptDocuments(
      merged,
      fakeSupabase({ a: { bytes: await pdfWith(1) }, b: { bytes: await pdfWith(1) } }),
      [item("a"), item("b")],
      { deadline: Date.now() - 1 }
    );
    expect(res.embedded).toBe(0);
    expect(res.notReached).toBe(2);
    expect(res.omitted.every((o) => /time limit/.test(o.reason))).toBe(true);
  });

  // A failed file-list read must not masquerade as "no file attached" for all.
  it("throws — rather than printing a hollow report — when the file list can't be read", async () => {
    await expect(
      appendReceiptDocuments(await PDFDocument.create(), fakeSupabase({}, { listError: true }), [
        item("a"),
      ])
    ).rejects.toThrow(/Could not read the receipt files/);
  });
});

describe("text drawn into a PDF", () => {
  it("keeps Latin text and replaces what the standard font can't encode", () => {
    expect(pdfSafe("Café Mocha — #3 “ok” …")).toBe("Café Mocha — #3 “ok” …");
    expect(pdfSafe("北京 Shop 😀")).toBe("?? Shop ??");
  });

  // Labels carry vendor names; one non-Latin vendor used to abort the report.
  it("an omissions page naming a non-Latin vendor still renders", async () => {
    const merged = await PDFDocument.create();
    await addOmissionsPage(merged, [{ label: "#1 · 北京 Trading", reason: "no document" }], {
      part: 1,
      parts: 1,
    });
    expect(merged.getPageCount()).toBe(1);
    await expect(merged.save()).resolves.toBeInstanceOf(Uint8Array);
  });
});
