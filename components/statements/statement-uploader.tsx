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
        update(item.id, { status: "uploading" });
        const sid = crypto.randomUUID();
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

        update(item.id, { status: "parsing" });
        const res = await fetch("/api/statements/parse", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ statementId: sid }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "parsing failed");

        update(item.id, { status: "done", count: json.count });
      } catch (e) {
        update(item.id, { status: "error", message: String(e) });
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
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
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
            className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy ? "Reading…" : "Upload & read statements"}
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
      <span className="text-xs text-red-600" title={item.message}>
        Failed
      </span>
    );
  return (
    <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
      {item.count ?? 0} transactions
    </span>
  );
}
