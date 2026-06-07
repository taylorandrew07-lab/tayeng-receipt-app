"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { currentMonthKey } from "@/lib/month";

type Item = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "processing" | "done" | "error";
  result?: "confirmed" | "needs_review";
  message?: string;
};

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,application/pdf";

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-120) || "file";
}

export function Uploader() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const next: Item[] = Array.from(fileList).map((file, i) => ({
      id: `${Date.now()}-${i}-${file.name}`,
      file,
      status: "queued",
    }));
    setItems((prev) => [...prev, ...next]);
  }

  function update(id: string, patch: Partial<Item>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function processAll() {
    setBusy(true);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setBusy(false);
      return;
    }
    const month = currentMonthKey();

    for (const item of items) {
      if (item.status === "done") continue;
      try {
        update(item.id, { status: "uploading" });

        // 1. Create the receipt row first to get its id.
        const { data: receipt, error: rErr } = await supabase
          .from("receipts")
          .insert({ user_id: user.id, status: "processing" })
          .select("id")
          .single();
        if (rErr || !receipt) throw new Error(rErr?.message ?? "insert failed");

        // 2. Upload the file to the user's storage folder.
        const path = `${user.id}/${month}/${receipt.id}/${safeName(item.file.name)}`;
        const { error: upErr } = await supabase.storage
          .from("documents")
          .upload(path, item.file, {
            contentType: item.file.type || undefined,
            upsert: true,
          });
        if (upErr) throw new Error(upErr.message);

        // 3. Record the file row.
        const { error: fErr } = await supabase.from("receipt_files").insert({
          receipt_id: receipt.id,
          user_id: user.id,
          storage_path: path,
          file_name: item.file.name,
          mime_type: item.file.type || null,
          size_bytes: item.file.size,
        });
        if (fErr) throw new Error(fErr.message);

        // 4. Kick off extraction + classification on the server.
        update(item.id, { status: "processing" });
        const res = await fetch("/api/receipts/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ receiptId: receipt.id }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "processing failed");

        update(item.id, { status: "done", result: json.status });
      } catch (e) {
        update(item.id, { status: "error", message: String(e) });
      }
    }

    setBusy(false);
    router.refresh();
  }

  const allDone = items.length > 0 && items.every((i) => i.status === "done");

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Choose files
          </button>
          <button
            type="button"
            onClick={() => cameraInput.current?.click()}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            📷 Take photo
          </button>

          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Receipts, invoices, and statement PDFs. JPG, PNG, WebP, or PDF. You can
          select many at once.
        </p>
      </div>

      {items.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <ul className="divide-y divide-slate-100">
            {items.map((it) => (
              <li
                key={it.id}
                className="flex items-center justify-between gap-3 py-3"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {it.file.name}
                </span>
                <StatusBadge item={it} />
              </li>
            ))}
          </ul>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={processAll}
              disabled={busy}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {busy
                ? "Processing…"
                : `Upload & process ${items.length} file${items.length === 1 ? "" : "s"}`}
            </button>
            {allDone && (
              <>
                <a
                  href="/receipts"
                  className="text-sm font-medium text-slate-900 underline"
                >
                  View receipts
                </a>
                <a
                  href="/review"
                  className="text-sm font-medium text-amber-700 underline"
                >
                  Go to Needs Review
                </a>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ item }: { item: Item }) {
  if (item.status === "queued")
    return <span className="text-xs text-slate-400">Queued</span>;
  if (item.status === "uploading")
    return <span className="text-xs text-blue-600">Uploading…</span>;
  if (item.status === "processing")
    return <span className="text-xs text-blue-600">Reading…</span>;
  if (item.status === "error")
    return (
      <span className="text-xs text-red-600" title={item.message}>
        Failed
      </span>
    );
  // done
  return item.result === "needs_review" ? (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      Needs review
    </span>
  ) : (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
      Done
    </span>
  );
}
