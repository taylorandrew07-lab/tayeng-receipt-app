"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Item = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "parsing" | "done" | "error";
  count?: number;
  message?: string;
  /**
   * Set as soon as the statement row exists. A retry then only RE-READS it.
   * Without this, pressing the button again after a failed read uploaded the
   * file a second time under a new id — which is how a duplicate statement
   * ("andrew 5.pdf") ended up in the live data.
   */
  statementId?: string;
  /** false = read, but the statement could not be proven complete. */
  proven?: boolean | null;
};

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-120) || "file";
}

export function StatementUploader() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function add(list: FileList | null) {
    if (!list) return;
    setItems((p) => [
      ...p,
      ...Array.from(list).map((file, i) => ({
        id: `${Date.now()}-${i}`,
        file,
        status: "queued" as const,
      })),
    ]);
  }
  function update(id: string, patch: Partial<Item>) {
    setItems((p) => p.map((it) => (it.id === id ? { ...it, ...patch } : it)));
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

    for (const item of items) {
      if (item.status === "done") continue;
      try {
        let sid = item.statementId;
        if (!sid) {
          update(item.id, { status: "uploading", message: undefined });
          sid = crypto.randomUUID();
          const path = `${user.id}/statements/${sid}/${safeName(item.file.name)}`;

          const { error: upErr } = await supabase.storage
            .from("documents")
            .upload(path, item.file, {
              contentType: item.file.type || undefined,
              upsert: true,
            });
          if (upErr) throw new Error(upErr.message);

          const { error: sErr } = await supabase.from("statements").insert({
            id: sid,
            user_id: user.id,
            storage_path: path,
            file_name: item.file.name,
          });
          if (sErr) throw new Error(sErr.message);
          // From here on a retry re-reads THIS statement; it never re-uploads.
          update(item.id, { statementId: sid });
        }

        update(item.id, { status: "parsing", message: undefined });
        const res = await fetch("/api/statements/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statementId: sid }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Reading the statement failed.");

        update(item.id, {
          status: "done",
          count: json.count,
          message: json.message,
          proven: json.reconciled ?? null,
        });
      } catch (e) {
        update(item.id, { status: "error", message: (e as Error).message ?? String(e) });
      }
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        >
          Choose statement PDF(s)
        </button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          multiple
          className="hidden"
          onChange={(e) => add(e.target.files)}
        />
        <p className="mt-3 text-xs text-slate-400">
          Credit card statement PDFs. The app reads the transactions so you can
          match them to receipts.
        </p>
      </div>

      {items.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <ul className="divide-y divide-slate-100">
            {items.map((it) => (
              <li key={it.id} className="flex items-center justify-between gap-3 py-3">
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">
                  {it.file.name}
                </span>
                <Badge item={it} />
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={processAll}
            disabled={busy}
            className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy
              ? "Reading…"
              : items.some((i) => i.status === "error")
                ? "Try again"
                : "Upload & read statements"}
          </button>
        </div>
      )}
    </div>
  );
}

function Badge({ item }: { item: Item }) {
  if (item.status === "queued") return <span className="text-xs text-slate-400">Queued</span>;
  if (item.status === "uploading") return <span className="text-xs text-blue-600">Uploading…</span>;
  if (item.status === "parsing") return <span className="text-xs text-blue-600">Reading…</span>;
  if (item.status === "error")
    return (
      // The reason is TEXT, not a hover tooltip: there is no hover on a phone,
      // so "Failed" used to be all Andrew could ever see.
      <span className="block max-w-[16rem] text-right text-xs text-red-700">
        <strong>Failed.</strong> {item.message}
      </span>
    );
  // The completeness verdict, in words — not just a line count.
  return (
    <span
      className={`block max-w-[16rem] text-right text-xs ${
        item.proven === false ? "text-red-700" : item.proven ? "text-green-800" : "text-amber-800"
      }`}
    >
      <strong>{item.count ?? 0} charges read.</strong> {item.message}
    </span>
  );
}
