import "server-only";

/**
 * Renders the first page of a PDF to a PNG buffer so it can be embedded as a
 * receipt image in the report. Returns null if rendering fails (the report
 * then falls back to a "PDF document" placeholder).
 */
export async function pdfFirstPagePng(data: Uint8Array): Promise<Buffer | null> {
  try {
    const { pdf } = await import("pdf-to-img");
    const doc = await pdf(Buffer.from(data), { scale: 2 });
    return await doc.getPage(1);
  } catch {
    return null;
  }
}
