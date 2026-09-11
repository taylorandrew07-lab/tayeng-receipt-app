import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_EMBED_BYTES = 25 * 1024 * 1024; // one receipt file
const MAX_PAGES_PER_RECEIPT = 20;
/** Downloaded at once. Also the most file bytes held in memory at one time. */
const WINDOW = 4;
/**
 * Total document bytes one PDF may embed. The old version downloaded EVERY
 * file before embedding any, so 60 receipts at up to 25 MB each could hold
 * 1.5 GB in memory on a function with 1–2 GB. Past this budget the remaining
 * documents are listed as omitted and go into the next part.
 */
const BYTE_BUDGET = 120 * 1024 * 1024;
const A4: [number, number] = [595.28, 841.89];

export type ReceiptItem = { receiptId: string; label: string };

/** Something promised in the report that is not in this PDF, and why. */
export type Omission = { label: string; reason: string };

export type AppendResult = {
  /** Documents actually embedded (in full or page-capped). */
  embedded: number;
  omitted: Omission[];
  /** Items never reached (deadline or byte budget) — they belong in a later part. */
  notReached: number;
};

export type AppendOptions = {
  /** Absolute Date.now() after which no further document is started. */
  deadline?: number;
};

type FileRow = {
  receipt_id: string;
  storage_path: string;
  mime_type: string | null;
  file_name: string | null;
};

/**
 * Appends each receipt's real document, labelled, and accounts for EVERY item:
 * each one is either embedded in full or listed in `omitted` with the reason —
 * including a PDF cut short at MAX_PAGES_PER_RECEIPT, which the old version
 * truncated silently.
 *
 * Throws if the file list itself cannot be read: a report that quietly
 * printed "no file attached" for every receipt would look complete and be
 * worthless.
 */
export async function appendReceiptDocuments(
  merged: PDFDocument,
  supabase: SupabaseClient,
  items: ReceiptItem[],
  options: AppendOptions = {}
): Promise<AppendResult> {
  const omitted: Omission[] = [];
  if (items.length === 0) return { embedded: 0, omitted, notReached: 0 };

  const font = await merged.embedFont(StandardFonts.Helvetica);

  // One query for every receipt's primary (earliest) file.
  const ids = [...new Set(items.map((i) => i.receiptId))];
  const fileByReceipt = new Map<string, FileRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("receipt_files")
      .select("receipt_id, storage_path, mime_type, file_name, created_at")
      .in("receipt_id", ids.slice(i, i + 200))
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw new Error(`Could not read the receipt files: ${error.message}`);
    for (const f of (data ?? []) as FileRow[]) {
      if (!fileByReceipt.has(f.receipt_id)) fileByReceipt.set(f.receipt_id, f);
    }
  }

  let embedded = 0;
  let spent = 0;
  let stoppedAt = items.length;
  let stopReason = "";

  for (let w = 0; w < items.length; w += WINDOW) {
    if (options.deadline && Date.now() > options.deadline) {
      stoppedAt = w;
      stopReason = "not reached before the time limit — download this part again, or open the receipt in the app";
      break;
    }
    if (spent >= BYTE_BUDGET) {
      stoppedAt = w;
      stopReason = "this PDF reached its size limit — download this part again, or open the receipt in the app";
      break;
    }

    // Download ONE window, embed it, let it go. Memory is bounded by WINDOW
    // files, not by the whole report.
    const window = items.slice(w, w + WINDOW);
    const bytes = await Promise.all(
      window.map(async (item): Promise<Uint8Array | string> => {
        const file = fileByReceipt.get(item.receiptId);
        if (!file) return "no document is attached to this receipt";
        try {
          const { data: blob, error } = await supabase.storage
            .from("documents")
            .download(file.storage_path);
          if (error || !blob) return "the document could not be downloaded";
          if (blob.size > MAX_EMBED_BYTES) return "the document is larger than 25 MB";
          return new Uint8Array(await blob.arrayBuffer());
        } catch {
          return "the document could not be downloaded";
        }
      })
    );

    for (let k = 0; k < window.length; k++) {
      const item = window[k];
      const b = bytes[k];
      if (typeof b === "string") {
        drawLabel(merged.addPage(A4), font, `${item.label} — NOT INCLUDED: ${b}`);
        omitted.push({ label: item.label, reason: b });
        continue;
      }
      spent += b.byteLength;
      const file = fileByReceipt.get(item.receiptId)!;
      const name = (file.file_name ?? "").toLowerCase();
      const mime = (file.mime_type ?? "").toLowerCase();
      const isPng = mime.includes("png") || name.endsWith(".png");
      const isJpg = mime.includes("jpeg") || /\.jpe?g$/.test(name);
      const isPdf = mime.includes("pdf") || name.endsWith(".pdf");

      try {
        if (isPdf) {
          const src = await PDFDocument.load(b, { ignoreEncryption: true });
          const total = src.getPageCount();
          const keep = src.getPageIndices().slice(0, MAX_PAGES_PER_RECEIPT);
          const pages = await merged.copyPages(src, keep);
          pages.forEach((p, idx) => {
            merged.addPage(p);
            if (idx === 0) {
              drawLabel(
                p,
                font,
                total > keep.length
                  ? `${item.label} — pages 1–${keep.length} of ${total}`
                  : item.label
              );
            }
          });
          embedded++;
          if (total > keep.length) {
            omitted.push({
              label: item.label,
              reason: `pages ${keep.length + 1}–${total} of ${total} not included (limit ${MAX_PAGES_PER_RECEIPT} pages per document)`,
            });
          }
        } else if (isJpg || isPng) {
          const img = isPng ? await merged.embedPng(b) : await merged.embedJpg(b);
          const page = merged.addPage(A4);
          const margin = 28;
          const scale = Math.min(
            (A4[0] - margin * 2) / img.width,
            (A4[1] - margin * 2 - 20) / img.height,
            1
          );
          const iw = img.width * scale;
          const ih = img.height * scale;
          page.drawImage(img, { x: (A4[0] - iw) / 2, y: (A4[1] - ih) / 2 - 10, width: iw, height: ih });
          drawLabel(page, font, item.label);
          embedded++;
        } else {
          drawLabel(merged.addPage(A4), font, `${item.label} — NOT INCLUDED: unsupported file type`);
          omitted.push({ label: item.label, reason: "unsupported file type" });
        }
      } catch {
        drawLabel(merged.addPage(A4), font, `${item.label} — NOT INCLUDED: could not be embedded`);
        omitted.push({ label: item.label, reason: "the document could not be read (damaged or protected)" });
      }
    }
  }

  for (const item of items.slice(stoppedAt)) {
    omitted.push({ label: item.label, reason: stopReason });
  }

  return { embedded, omitted, notReached: items.length - stoppedAt };
}

/**
 * pdf-lib's standard fonts can only encode WinAnsi (Latin-1 plus a few
 * typographic marks). drawText THROWS on anything else — and labels carry
 * vendor names, so one invoice with, say, Chinese characters would abort the
 * whole report. Replace what cannot be encoded instead.
 */
export function pdfSafe(text: string): string {
  return text.replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, "?");
}

function drawLabel(page: PDFPage, font: PDFFont, raw: string) {
  const size = 9;
  const text = pdfSafe(raw);
  const clipped = text.length > 110 ? `${text.slice(0, 107)}...` : text;
  const w = font.widthOfTextAtSize(clipped, size) + 8;
  const y = page.getHeight() - 16;
  page.drawRectangle({ x: 4, y: y - 3, width: w, height: size + 6, color: rgb(1, 1, 1), opacity: 0.85 });
  page.drawText(clipped, { x: 8, y, size, font, color: rgb(0.06, 0.09, 0.16) });
}

/**
 * The closing page of every report PDF: exactly what is NOT in it, receipt by
 * receipt, and where to get the rest. The old version said "N further
 * receipt document(s) were not included" without saying which.
 */
export async function addOmissionsPage(
  merged: PDFDocument,
  omitted: Omission[],
  continuation: { part: number; parts: number }
): Promise<void> {
  if (omitted.length === 0 && continuation.part >= continuation.parts) return;

  const font = await merged.embedFont(StandardFonts.Helvetica);
  const bold = await merged.embedFont(StandardFonts.HelveticaBold);
  let page = merged.addPage(A4);
  let y = 790;
  const line = (raw: string, f: PDFFont = font, size = 9) => {
    if (y < 50) {
      page = merged.addPage(A4);
      y = 790;
    }
    const text = pdfSafe(raw);
    const clipped = text.length > 120 ? `${text.slice(0, 117)}...` : text;
    page.drawText(clipped, { x: 40, y, size, font: f, color: rgb(0.06, 0.09, 0.16) });
    y -= size + 6;
  };

  line("What is not in this PDF", bold, 13);
  y -= 4;
  if (continuation.part < continuation.parts) {
    line(
      `This is part ${continuation.part} of ${continuation.parts}. The remaining receipt documents are in the later parts —`,
    );
    line("download them from the same screen you downloaded this one.");
    y -= 6;
  }
  if (omitted.length === 0) {
    line("Every document for this part is included in full.");
    return;
  }
  line(`${omitted.length} item${omitted.length === 1 ? "" : "s"} could not be included in full:`);
  y -= 2;
  for (const o of omitted) {
    line(`• ${o.label}`, bold);
    line(`    ${o.reason}`);
  }
}

/** A first page for part 2 onwards, so each PDF says what it is. */
export async function addPartCover(
  merged: PDFDocument,
  title: string,
  part: number,
  parts: number,
  first: number,
  last: number
): Promise<void> {
  const font = await merged.embedFont(StandardFonts.Helvetica);
  const bold = await merged.embedFont(StandardFonts.HelveticaBold);
  const page = merged.addPage(A4);
  page.drawText(pdfSafe(title), { x: 40, y: 780, size: 16, font: bold });
  page.drawText(`Receipt documents — part ${part} of ${parts}`, { x: 40, y: 756, size: 12, font });
  page.drawText(`Documents #${first} to #${last}. The summary and tables are in part 1.`, {
    x: 40,
    y: 736,
    size: 10,
    font,
  });
}
