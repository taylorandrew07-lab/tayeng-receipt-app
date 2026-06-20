"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  deleteReceipts,
  findDuplicates,
  setReceiptsSent,
  setReceiptsPaid,
  dismissDuplicate,
} from "@/lib/receipts/actions";
import { PAYMENT_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/components/receipts/labels";
import { formatMonthKey, formatTTD } from "@/lib/month";
import { toast } from "@/components/toast";
import type { Receipt } from "@/lib/types";

// raw_extraction (a heavy JSON blob) is intentionally not fetched for the list.
export type ReceiptRow = Omit<Receipt, "raw_extraction"> & {
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
  initialPaid = "all",
}: {
  rows: ReceiptRow[];
  months: string[];
  selected: string;
  initialKind?: string;
  initialPaid?: string;
}) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>(
    (["reimbursable", "company", "cash", "personal"].includes(initialKind)
      ? initialKind
      : "all") as KindFilter
  );
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [sentFilter, setSentFilter] = useState<"all" | "not" | "sent">("all");
  const [paidFilter, setPaidFilter] = useState<"all" | "unpaid" | "paid">(
    (["unpaid", "paid"].includes(initialPaid) ? initialPaid : "all") as
      | "all"
      | "unpaid"
      | "paid"
  );
  const [billBackFilter, setBillBackFilter] = useState<
    "all" | "billback" | "not" | "client" | "vessel"
  >("all");
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
    if (sentFilter === "not") list = list.filter((r) => !r.sent);
    else if (sentFilter === "sent") list = list.filter((r) => r.sent);
    if (paidFilter === "unpaid") list = list.filter((r) => !r.paid);
    else if (paidFilter === "paid") list = list.filter((r) => r.paid);
    if (billBackFilter === "billback") list = list.filter((r) => r.bill_back);
    else if (billBackFilter === "not") list = list.filter((r) => !r.bill_back);
    else if (billBackFilter === "client")
      list = list.filter((r) => r.bill_back && r.bill_back_type === "client");
    else if (billBackFilter === "vessel")
      list = list.filter((r) => r.bill_back && r.bill_back_type === "vessel");
    const dir = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = sortVal(a, sortKey);
      const vb = sortVal(b, sortKey);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [
    rows,
    statusFilter,
    kind,
    duplicatesOnly,
    sentFilter,
    paidFilter,
    billBackFilter,
    sortKey,
    sortDir,
  ]);

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

  function markSent(sent: boolean) {
    const ids = [...picked];
    if (ids.length === 0) return;
    startTransition(async () => {
      await setReceiptsSent(ids, sent);
      setPicked(new Set());
      router.refresh();
    });
  }

  function markPaid(paid: boolean) {
    const ids = [...picked];
    if (ids.length === 0) return;
    startTransition(async () => {
      await setReceiptsPaid(ids, paid);
      setPicked(new Set());
      router.refresh();
    });
  }

  function runFindDuplicates() {
    startTransition(async () => {
      const res = await findDuplicates();
      router.refresh();
      setDuplicatesOnly(res.flagged > 0 || counts.duplicates > 0);
      toast(
        res.flagged > 0
          ? `Flagged ${res.flagged} possible duplicate${res.flagged === 1 ? "" : "s"}. They're shown now and marked "Duplicate".`
          : "No new duplicates found.",
        res.flagged > 0 ? "success" : "info"
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
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald-500"
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
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>

        <select
          value={sentFilter}
          onChange={(e) => setSentFilter(e.target.value as "all" | "not" | "sent")}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        >
          <option value="all">Sent &amp; not sent</option>
          <option value="not">Not sent yet</option>
          <option value="sent">Sent (archived)</option>
        </select>

        <select
          value={paidFilter}
          onChange={(e) => setPaidFilter(e.target.value as "all" | "unpaid" | "paid")}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        >
          <option value="all">Paid &amp; unpaid</option>
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>

        <select
          value={billBackFilter}
          onChange={(e) =>
            setBillBackFilter(
              e.target.value as "all" | "billback" | "not" | "client" | "vessel"
            )
          }
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500"
        >
          <option value="all">All bill-back</option>
          <option value="billback">Bill-back only</option>
          <option value="not">Not bill-back</option>
          <option value="client">Clients</option>
          <option value="vessel">Vessels</option>
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
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">
          <span>{picked.size} selected</span>
          <span className="font-semibold">Total {formatTTD(selectedTotal)}</span>
          <button
            type="button"
            onClick={() => markPaid(true)}
            disabled={pending}
            className="rounded-md bg-green-600 px-3 py-1 font-semibold hover:bg-green-700 disabled:opacity-60"
          >
            Mark as paid
          </button>
          <button
            type="button"
            onClick={() => markPaid(false)}
            disabled={pending}
            className="rounded-md border border-slate-500 px-3 py-1 font-medium hover:bg-slate-800 disabled:opacity-60"
          >
            Unpaid
          </button>
          <button
            type="button"
            onClick={() => markSent(true)}
            disabled={pending}
            className="rounded-md bg-emerald-600 px-3 py-1 font-semibold hover:bg-emerald-700 disabled:opacity-60"
          >
            Mark sent
          </button>
          <button
            type="button"
            onClick={() => markSent(false)}
            disabled={pending}
            className="rounded-md border border-slate-500 px-3 py-1 font-medium hover:bg-slate-800 disabled:opacity-60"
          >
            Not sent
          </button>
          <button
            type="button"
            onClick={bulkDelete}
            disabled={pending}
            className="rounded-md bg-red-600 px-3 py-1 font-semibold hover:bg-red-700 disabled:opacity-60"
          >
            {pending ? "Working…" : "Delete"}
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
                const archived = r.status === "confirmed" || r.sent || r.paid;
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
                      {r.bill_back && (
                        <div className="max-w-[220px] truncate text-xs font-medium text-purple-700">
                          ↩ Bill back ({r.bill_back_type}): {r.bill_back_name}
                        </div>
                      )}
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
                      <div className="flex flex-col items-start gap-1">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[r.status]}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                        {r.paid && (
                          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                            💰 Paid
                          </span>
                        )}
                        {r.sent && (
                          <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                            ✓ Sent
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {r.duplicate_of && (
                          <form action={dismissDuplicate}>
                            <input type="hidden" name="id" value={r.id} />
                            <button className="whitespace-nowrap text-xs font-medium text-amber-700 underline">
                              Not a dup
                            </button>
                          </form>
                        )}
                        <Link href={`/receipts/${r.id}`} className="text-sm font-medium text-slate-900 underline">
                          Open
                        </Link>
                      </div>
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
