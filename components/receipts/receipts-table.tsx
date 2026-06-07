"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteReceipts } from "@/lib/receipts/actions";
import { PAYMENT_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/components/receipts/labels";
import { formatMonthKey, formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";

export type ReceiptRow = Receipt & {
  categories: { name: string } | null;
  receipt_files: { file_name: string }[];
};

type StatusFilter = "all" | "needs_review" | "confirmed";
type SortBy = "receipt_date" | "upload";

export function ReceiptsTable({
  rows,
  months,
  selected,
}: {
  rows: ReceiptRow[];
  months: string[];
  selected: string; // 'all' or 'YYYY-MM'
}) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("upload");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const counts = useMemo(
    () => ({
      all: rows.length,
      needs_review: rows.filter((r) => r.status === "needs_review").length,
      confirmed: rows.filter((r) => r.status === "confirmed").length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    let list = rows;
    if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
    const sorted = [...list].sort((a, b) => {
      if (sortBy === "upload") return b.created_at.localeCompare(a.created_at);
      return (b.receipt_date ?? "").localeCompare(a.receipt_date ?? "");
    });
    return sorted;
  }, [rows, statusFilter, sortBy]);

  const reimbursableTotal = visible
    .filter((r) => r.reimbursable)
    .reduce((s, r) => s + Number(r.ttd_amount ?? 0), 0);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => picked.has(r.id));

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setPicked((prev) => {
      if (visible.every((r) => prev.has(r.id))) {
        const next = new Set(prev);
        visible.forEach((r) => next.delete(r.id));
        return next;
      }
      return new Set([...prev, ...visible.map((r) => r.id)]);
    });
  }

  function bulkDelete() {
    const ids = [...picked];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} receipt${ids.length === 1 ? "" : "s"}? This cannot be undone.`))
      return;
    startTransition(async () => {
      await deleteReceipts(ids);
      setPicked(new Set());
      router.refresh();
    });
  }

  return (
    <div>
      {/* Controls */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={selected}
          onChange={(e) => router.push(`/receipts?month=${e.target.value}`)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-slate-900"
        >
          <option value="all">All months</option>
          {months.map((m) => (
            <option key={m} value={m}>
              Uploaded {formatMonthKey(m)}
            </option>
          ))}
        </select>

        <div className="flex overflow-hidden rounded-lg border border-slate-300 text-sm">
          {(["all", "needs_review", "confirmed"] as StatusFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-2 font-medium ${
                statusFilter === f ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f === "all" ? "All" : f === "needs_review" ? "Needs review" : "Done"} ({counts[f]})
            </button>
          ))}
        </div>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900"
        >
          <option value="upload">Sort: upload order</option>
          <option value="receipt_date">Sort: receipt date</option>
        </select>

        <span className="ml-auto text-sm text-slate-500">
          Reimbursable {formatTTD(reimbursableTotal)}
        </span>
      </div>

      {/* Bulk action bar */}
      {picked.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">
          <span>{picked.size} selected</span>
          <button
            type="button"
            onClick={bulkDelete}
            disabled={pending}
            className="rounded-md bg-red-600 px-3 py-1 font-semibold hover:bg-red-700 disabled:opacity-60"
          >
            {pending ? "Deleting…" : "Delete selected"}
          </button>
          <button
            type="button"
            onClick={() => setPicked(new Set())}
            className="text-slate-300 hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
          Nothing here.{" "}
          <Link href="/upload" className="font-medium text-slate-900 underline">
            Upload some receipts
          </Link>
          .
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-3 py-3">
                  <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} />
                </th>
                <th className="px-3 py-3 font-semibold">Date</th>
                <th className="px-3 py-3 font-semibold">Vendor / File</th>
                <th className="px-3 py-3 font-semibold">Category</th>
                <th className="px-3 py-3 font-semibold">Payment</th>
                <th className="px-3 py-3 text-right font-semibold">TTD</th>
                <th className="px-3 py-3 font-semibold">Status</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const archived = r.status === "confirmed";
                const fileName = r.receipt_files?.[0]?.file_name;
                return (
                  <tr
                    key={r.id}
                    className={`border-b border-slate-100 last:border-0 ${
                      archived ? "bg-slate-50/60" : ""
                    } ${picked.has(r.id) ? "bg-blue-50" : ""}`}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={picked.has(r.id)}
                        onChange={() => toggle(r.id)}
                      />
                    </td>
                    <td className={`whitespace-nowrap px-3 py-3 ${archived ? "text-slate-400" : "text-slate-600"}`}>
                      {r.receipt_date ?? "—"}
                    </td>
                    <td className="px-3 py-3">
                      <div className={`font-medium ${archived ? "text-slate-500" : "text-slate-900"}`}>
                        {r.vendor_name ?? "Unknown"}
                        {r.duplicate_of && (
                          <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                            Duplicate
                          </span>
                        )}
                      </div>
                      {fileName && (
                        <div className="text-xs text-slate-400 truncate max-w-[220px]">{fileName}</div>
                      )}
                    </td>
                    <td className={`px-3 py-3 ${archived ? "text-slate-400" : "text-slate-600"}`}>
                      {r.categories?.name ?? "—"}
                    </td>
                    <td className={`px-3 py-3 ${archived ? "text-slate-400" : "text-slate-600"}`}>
                      {PAYMENT_LABEL[r.payment_method]}
                      {r.card_last4 ? ` ••${r.card_last4}` : ""}
                    </td>
                    <td className={`whitespace-nowrap px-3 py-3 text-right ${archived ? "text-slate-500" : "text-slate-900"}`}>
                      {r.ttd_amount != null ? formatTTD(r.ttd_amount) : "—"}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <Link
                        href={`/receipts/${r.id}`}
                        className="text-sm font-medium text-slate-900 underline"
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
