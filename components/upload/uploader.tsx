"use client";

import { useRef } from "react";
import { useUploadQueue, type QueueItem } from "@/components/upload/upload-queue";

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,application/pdf";

export function Uploader() {
  const { items, enqueueFiles, clearFinished, activeCount } = useUploadQueue();
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  const finishedCount = items.filter(
    (i) => i.status === "done" || i.status === "error"
  ).length;

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
            onChange={(e) => {
              enqueueFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              enqueueFiles(e.target.files ?? []);
              e.target.value = "";
            }}
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Receipts, invoices, and statement PDFs. JPG, PNG, WebP, or PDF. You can
          select many at once.
        </p>
        {activeCount > 0 && (
          <p className="mt-2 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
            Uploads keep processing in the background as you move around the app —
            just keep this browser tab open until they finish.
          </p>
        )}
      </div>

      {items.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold text-slate-900">
              Uploads{" "}
              <span className="text-sm font-normal text-slate-400">
                ({items.filter((i) => i.status === "done").length}/{items.length} done)
              </span>
            </h2>
            {finishedCount > 0 && (
              <button
                type="button"
                onClick={clearFinished}
                className="text-xs text-slate-400 hover:text-slate-700"
              >
                Clear finished
              </button>
            )}
          </div>
          <ul className="divide-y divide-slate-100">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3 py-3">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {it.name}
                </span>
                <StatusBadge item={it} />
                {it.status === "done" && it.receiptId && (
                  <a
                    href={`/receipts/${it.receiptId}`}
                    className="text-sm font-medium text-slate-900 underline"
                  >
                    Open
                  </a>
                )}
              </li>
            ))}
          </ul>

          {activeCount === 0 && (
            <div className="mt-4 flex items-center gap-3">
              <a href="/receipts" className="text-sm font-medium text-slate-900 underline">
                View receipts
              </a>
              <a href="/review" className="text-sm font-medium text-amber-700 underline">
                Go to Needs Review
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ item }: { item: QueueItem }) {
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
