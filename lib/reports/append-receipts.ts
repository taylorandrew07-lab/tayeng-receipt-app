import "server-only";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_EMBED_BYTES = 25 * 1024 * 1024; // 25 MB per receipt file
const MAX_PAGES_PER_RECEIPT = 20;
const DOWNLOAD_CONCURRENCY = 5;
const A4: [number, number] = [595.28, 841.89];

export type ReceiptItem = { receiptId: string; label: string };

type FileRow = {
  receipt_id: string;
  storage_path: string;
  mime_type: string | null;
  file_name: string | null;
  created_at: string;
};

/** Run async tasks with a bounded concurrency pool, preserving result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Appends each receipt's actual document pages onto `merged`, labelled.
 * PDF receipts have their (capped) pages copied in; image receipts get a full
 * page. File metadata is fetched in ONE query and blobs download concurrently —
 * no per-receipt round-trip storms.
 */
export async function appendReceiptDocuments(
  merged: PDFDocument,
  supabase: SupabaseClient,
  items: ReceiptItem[]
): Promise<void> {
  const labelFont = await merged.embedFont(StandardFonts.Helvetica);
  const drawLabel = (page: import("pdf-lib").PDFPage, text: string) => {
    const size = 9;
    const w = labelFont.widthOfTextAtSize(text, size) + 8;
    const y = page.getHeight() - 16;
    page.drawRectangle({ x: 4, y: y - 3, width: w, height: size + 6, color: rgb(1, 1, 1), opacity: 0.85 });
    page.drawText(text, { x: 8, y, size, font: labelFont, color: rgb(0.06, 0.09, 0.16) });
  };

  if (items.length === 0) return;

  // 1) One query for every receipt's primary (earliest) file.
  const ids = [...new Set(items.map((i) => i.receiptId))];
  const { data: fileData } = await supabase
    .from("receipt_files")
    .select("receipt_id, storage_path, mime_type, file_name, created_at")
    .in("receipt_id", ids)
    .order("created_at", { ascending: true });
  const fileByReceipt = new Map<string, FileRow>();
  for (const f of (fileData ?? []) as FileRow[]) {
    if (!fileByReceipt.has(f.receipt_id)) fileByReceipt.set(f.receipt_id, f);
  }

  // 2) Download the distinct blobs concurrently (bounded).
  const paths = [...new Set([...fileByReceipt.values()].map((f) => f.storage_path))];
  const bytesByPath = new Map<string, Uint8Array | null>();
  await mapLimit(paths, DOWNLOAD_CONCURRENCY, async (path) => {
    try {
      const { data: blob } = await supabase.storage.from("documents").download(path);
      if (!blob || blob.size > MAX_EMBED_BYTES) {
        bytesByPath.set(path, null);
        return;
      }
      bytesByPath.set(path, new Uint8Array(await blob.arrayBuffer()));
    } catch {
      bytesByPath.set(path, null);
    }
  });

  // 3) Embed in order.
  for (const item of items) {
    const label = item.label;
    const file = fileByReceipt.get(item.receiptId);
    if (!file) {
      drawLabel(merged.addPage(A4), `${label} — no file attached`);
      continue;
    }
    const bytes = bytesByPath.get(file.storage_path);
    if (!bytes) {
      drawLabel(merged.addPage(A4), `${label} — file unavailable or too large`);
      continue;
    }
    const name = (file.file_name ?? "").toLowerCase();
    const mime = (file.mime_type ?? "").toLowerCase();
    const isPng = mime.includes("png") || name.endsWith(".png");
    const isJpg = mime.includes("jpeg") || /\.jpe?g$/.test(name);
    const isPdf = mime.includes("pdf") || name.endsWith(".pdf");

    try {
      if (isPdf) {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const indices = src.getPageIndices().slice(0, MAX_PAGES_PER_RECEIPT);
        const pages = await merged.copyPages(src, indices);
        pages.forEach((p, idx) => {
          merged.addPage(p);
          if (idx === 0) drawLabel(p, label);
        });
      } else if (isJpg || isPng) {
        const img = isPng ? await merged.embedPng(bytes) : await merged.embedJpg(bytes);
        const page = merged.addPage(A4);
        const margin = 28;
        const scale = Math.min(
          (A4[0] - margin * 2) / img.width,
          (A4[1] - margin * 2 - 20) / img.height,
          1
        );
        const w = img.width * scale;
        const h = img.height * scale;
        page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2 - 10, width: w, height: h });
        drawLabel(page, label);
      } else {
        drawLabel(merged.addPage(A4), `${label} — unsupported file type`);
      }
    } catch {
      drawLabel(merged.addPage(A4), `${label} — could not be embedded`);
    }
  }
}
