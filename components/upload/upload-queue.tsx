"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { currentMonthKey } from "@/lib/month";

export type QueueStatus =
  | "queued"
  | "uploading"
  | "processing"
  | "done"
  | "error";

export type QueueItem = {
  id: string;
  name: string;
  status: QueueStatus;
  result?: "confirmed" | "needs_review";
  message?: string;
  file?: File; // present for fresh uploads
  receiptId?: string; // present once the receipt row exists / for resumes
};

type Ctx = {
  items: QueueItem[];
  enqueueFiles: (files: FileList | File[]) => void;
  clearFinished: () => void;
  activeCount: number;
};

const UploadQueueContext = createContext<Ctx | null>(null);

export function useUploadQueue() {
  const ctx = useContext(UploadQueueContext);
  if (!ctx) throw new Error("useUploadQueue must be used within UploadQueueProvider");
  return ctx;
}

const ACTIVE: QueueStatus[] = ["queued", "uploading", "processing"];

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(-120) || "file";
}

export function UploadQueueProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // `items` (state) drives rendering; `itemsRef` mirrors it so the async
  // processing loop always sees the latest queue without stale closures.
  const [items, setItemsState] = useState<QueueItem[]>([]);
  const itemsRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);

  function setItems(updater: (prev: QueueItem[]) => QueueItem[]) {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItemsState(next);
  }
  function update(id: string, patch: Partial<QueueItem>) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function processItem(item: QueueItem) {
    const supabase = createClient();
    try {
      update(item.id, { status: item.file ? "uploading" : "processing" });
      let receiptId = item.receiptId;

      if (item.file) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in");

        const { data: receipt, error: rErr } = await supabase
          .from("receipts")
          .insert({ user_id: user.id, status: "processing" })
          .select("id")
          .single();
        if (rErr || !receipt) throw new Error(rErr?.message ?? "insert failed");
        receiptId = receipt.id;

        const path = `${user.id}/${currentMonthKey()}/${receiptId}/${safeName(item.file.name)}`;
        const { error: upErr } = await supabase.storage
          .from("documents")
          .upload(path, item.file, {
            contentType: item.file.type || undefined,
            upsert: true,
          });
        if (upErr) throw new Error(upErr.message);

        const { error: fErr } = await supabase.from("receipt_files").insert({
          receipt_id: receiptId,
          user_id: user.id,
          storage_path: path,
          file_name: item.file.name,
          mime_type: item.file.type || null,
          size_bytes: item.file.size,
        });
        if (fErr) throw new Error(fErr.message);

        update(item.id, { status: "processing", receiptId });
      }

      const res = await fetch("/api/receipts/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receiptId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "processing failed");

      update(item.id, { status: "done", result: json.status });
    } catch (e) {
      update(item.id, { status: "error", message: String(e) });
    }
  }

  async function runLoop() {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      for (;;) {
        const next = itemsRef.current.find((i) => i.status === "queued");
        if (!next) break;
        await processItem(next);
      }
    } finally {
      runningRef.current = false;
      router.refresh(); // surface new receipts in lists/dashboard
    }
  }

  function enqueueFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const newItems: QueueItem[] = arr.map((file, i) => ({
      id: `${Date.now()}-${i}-${file.name}`,
      name: file.name,
      status: "queued",
      file,
    }));
    setItems((prev) => [...prev, ...newItems]);
    void runLoop();
  }

  function clearFinished() {
    setItems((prev) => prev.filter((i) => ACTIVE.includes(i.status)));
  }

  // Auto-resume anything left in "processing" from an interrupted session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      // Resume items older than 90s (avoids racing receipts processing right now).
      const resumeCutoff = new Date(Date.now() - 90_000).toISOString();
      // Only treat a file-less receipt as a true orphan after 30 minutes — a slow
      // mobile upload can legitimately sit between the receipt insert and the
      // receipt_files insert, and must NOT be deleted by another tab.
      const orphanCutoff = Date.now() - 30 * 60_000;
      const { data: stuck } = await supabase
        .from("receipts")
        .select("id, created_at, receipt_files(id, file_name)")
        .eq("status", "processing")
        .lt("created_at", resumeCutoff);
      if (cancelled || !stuck || stuck.length === 0) return;

      const resumeItems: QueueItem[] = [];
      for (const r of stuck as {
        id: string;
        created_at: string;
        receipt_files: { id: string; file_name: string }[];
      }[]) {
        const file = r.receipt_files?.[0];
        if (file) {
          resumeItems.push({
            id: `resume-${r.id}`,
            name: file.file_name ?? "Document",
            status: "queued",
            receiptId: r.id,
          });
        } else if (Date.parse(r.created_at) < orphanCutoff) {
          // File-less for 30+ minutes — the upload genuinely never completed.
          await supabase.from("receipts").delete().eq("id", r.id);
        }
      }
      if (!cancelled && resumeItems.length > 0) {
        setItems((prev) => {
          const have = new Set(prev.map((p) => p.id));
          return [...resumeItems.filter((r) => !have.has(r.id)), ...prev];
        });
        void runLoop();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warn before closing/refreshing the tab while work is in flight.
  const activeCount = items.filter((i) => ACTIVE.includes(i.status)).length;
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (itemsRef.current.some((i) => ACTIVE.includes(i.status))) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  return (
    <UploadQueueContext.Provider
      value={{ items, enqueueFiles, clearFinished, activeCount }}
    >
      {children}
      <GlobalProgress />
    </UploadQueueContext.Provider>
  );
}

function GlobalProgress() {
  const { items, activeCount } = useUploadQueue();
  if (activeCount === 0) return null;
  const done = items.filter((i) => i.status === "done").length;
  const total = items.length;
  return (
    <Link
      href="/upload"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg hover:border-slate-300"
    >
      <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-900" />
      <span className="text-sm font-medium text-slate-900">
        Processing {done + 1}/{total}…
      </span>
      <span className="text-xs text-slate-400">keep this tab open</span>
    </Link>
  );
}
