"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteReceipts, findDuplicates } from "@/lib/receipts/actions";
import { PAYMENT_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/components/receipts/labels";
import { formatMonthKey, formatTTD } from "@/lib/month";
import type { Receipt } from "@/lib/types";

export type ReceiptRow = Receipt & {
  categories: { name: string } | null;
  receipt_files: { file_name: string }[];
};

type StatusFilter = "all" | "needs_review" | "confirmed";
type KindFilter = "all" | "reimbursable" | "company" | "cash" | "personal";
type SortKey = "upload" | "receipt_date" | "vendor" | "category" | "payment" | "ttd" | "status";

const KINDS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All types" },
  { value: "reimbursable", label: "Reimbursable" },
  { value: "company", label: "Company card" },
  { value: "cash", label: "Cash" },
  { value: "personal", label: "Personal card" },
];

function kindMatch(r: ReceiptRow, k: KindFilter): boolean {
  switch (k) {
    case "reimbursable":
      return r.reimbursable === true;
    case "company":
      return r.payment_method === "company_card";
    case "cash":
      return r.payment_method === "cash";
    case "personal":
      return r.payment_method === "personal_card";
    default:
      return true;
  }
}

function sortVal(r: ReceiptRow, key: SortKey): string | number {
  switch (key) {
    case "upload":
      return r.created_at;
    case "receipt_date":
      return r.receipt_date ?? "";
    case "vendor":
      return (r.vendor_name ?? "").toLowerCase();
    case "category":
      return (r.categories?.name ?? "").toLowerCase();
    case "payment":
      return PAYMENT_LABEL[r.payment_method];
    case "ttd":
      return Number(r.ttd_amount ?? 0);
    case "status":
      return r.status;
  }
}

export function ReceiptsTable({
  rows,
  months,
  selected,
  initialKind = "all",
}: {
  rows: ReceiptRow[];
  months: string[];
  selected: string;
  initialKind?: string;
}) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>(
    (["reimbursable", "company", "cash", "personal"].includes(initialKind)
      ? initialKind
      : "all") as KindFilter
  );
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("upload");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const counts = useMemo(
    () => ({
      all: rows.length,
      needs_review: rows.filter((r) => r.status === "needs_review").length,
      confirmed: rows.filter((r) => r.status === "confirmed").length,
      duplicates: rows.filter((r) => r.duplicate_of).length,
    }),
    [rows]
  );

  const visible = useMemo(() => {
    let list = rows;
    if (statusFilter !== "all") list = list.filter((r) => r.status === statusFilter);
    if (kind !== "all") list = list.filter((r) => kindMatch(r, kind));
    if (duplicatesOnly) list = list.filter((r) => r.duplicate_of);
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = sortVal(a, sortKey);
      const vb = sortVal(b, sortKey);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, statusFilter, kind, duplicatesOnly, sortKey, sortDir]);

  const reimbursableTotal = visible
    .filter((r) => r.reimbursable)
    .reduce((s, r) => s + Number(r.ttd_amount ?? 0), 0);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => picked.has(r.id));
  const selectedTotal = rows
    .filter((r) => picked.has(r.id))
    .reduce((s, r) => s + Number(r.ttd_amount ?? 0), 0);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
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
  function setSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "ttd" || key.includes("date") || key === "upload" ? "desc" : "asc");
    }
  }
  function arrow(key: SortKey) {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
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

  function runFindDuplicates() {
    startTransition(async () => {
      const res = await findDuplicates();
      router.refresh();
      setDuplicatesOnly(res.flagged > 0 || counts.duplicates > 0);
      window.alert(
        res.flagged > 0
          ? `Flagged ${res.flagged} possible duplicate${res.flagged === 1 ? "" : "s"}. They're shown now and marked "Duplicate".`
          : "No new duplicates found."
      );
    });
  }

  const th = "cursor-pointer select-none px-3 py-3 font-semibold hover:text-slate-700";

  return (
    <div>
      {/* Row 1: month + status */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
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

        <span className="ml-auto text-sm text-slate-500">
          Reimbursable {formatTTD(reimbursableTotal)}
        </span>
      </div>

      {/* Row 2: type + duplicates */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as KindFilter)}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={runFindDuplicates}
          disabled={pending}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
        >
          {pending ? "Checking…" : "🔍 Find duplicates"}
        </button>

        {counts.duplicates > 0 && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={duplicatesOnly}
              onChange={(e) => setDuplicatesOnly(e.target.checked)}
            />
            Show duplicates only ({counts.duplicates})
          </label>
        )}
      </div>

      {/* Bulk bar */}
      {picked.size > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">
          <span>{picked.size} selected</span>
          <span className="font-semibold">Total {formatTTD(selectedTotal)}</span>
          <button
            type="button"
            onClick={bulkDelete}
            disabled={pending}
            className="rounded-md bg-red-600 px-3 py-1 font-semibold hover:bg-red-700 disabled:opacity-60"
          >
            {pending ? "Deleting…" : "Delete selected"}
          </button>
          <button type="button" onClick={() => setPicked(new Set())} className="text-slate-300 hover:text-white">
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
                <th className={th} onClick={() => setSort("receipt_date")}>Date{arrow("receipt_date")}</th>
                <th className={th} onClick={() => setSort("vendor")}>Vendor / File{arrow("vendor")}</th>
                <th className={th} onClick={() => setSort("category")}>Category{arrow("category")}</th>
                <th className={th} onClick={() => setSort("payment")}>Payment{arrow("payment")}</th>
                <th className={`${th} text-right`} onClick={() => setSort("ttd")}>TTD{arrow("ttd")}</th>
                <th className={th} onClick={() => setSort("status")}>Status{arrow("status")}</th>
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
                      <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
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
                        <div className="max-w-[220px] truncate text-xs text-slate-400">{fileName}</div>
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
                      <Link href={`/receipts/${r.id}`} className="text-sm font-medium text-slate-900 underline">
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
