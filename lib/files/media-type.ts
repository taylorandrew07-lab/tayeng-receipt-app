/**
 * Best-effort media type for an uploaded file. Prefers a real, specific MIME
 * type; otherwise falls back to the file-name extension. Used so the model and
 * the storage layer agree on how to read each document.
 */
export function resolveMediaType(mime: string | null, fileName: string | null): string {
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = (fileName ?? "").toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}
