"use client";

import { useState } from "react";
import { formatMonthKey } from "@/lib/month";
import { toast } from "@/components/toast";

const TYPES = [
  { value: "reimbursable", label: "Reimbursable (personal + cash)" },
  { value: "company", label: "Company card (accounting)" },
  { value: "all", label: "All expenses" },
  { value: "billback", label: "Bill-back (by client / vessel)" },
];

export function ReportLauncher({ months }: { months: string[] }) {
  const [month, setMonth] = useState(months[0]);
  const [type, setType] = useState("reimbursable");
  const [scope, setScope] = useState("outstanding");
  const [downloading, setDownloading] = useState(false);

  // A reimbursement claim is "what am I still owed", not "what happened in
  // July" — an unpaid June receipt still belongs in today's claim.
  const outstanding = type === "reimbursable" && scope === "outstanding";

  async function download() {
    setDownloading(true);
    try {
      const endpoint =
        type === "billback"
          ? `/api/reports/billback?month=${month}`
          : outstanding
            ? `/api/reports/generate?type=reimbursable&scope=outstanding`
            : `/api/reports/generate?month=${month}&type=${type}&scope=month`;
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error("Failed to generate report");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = outstanding
        ? `reimbursable-outstanding-${new Date().toISOString().slice(0, 10)}.pdf`
        : `${type}-report-${month}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast("Sorry, the report could not be generated. Please try again.", "error");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Report type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        {type === "reimbursable" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Covering</span>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            >
              <option value="outstanding">Everything still unpaid</option>
              <option value="month">One month only</option>
            </select>
          </label>
        )}

        <label className={`block ${outstanding ? "hidden" : ""}`}>
          <span className="mb-1 block text-sm font-medium text-slate-700">Month</span>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {formatMonthKey(m)}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={download}
          disabled={downloading}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {downloading ? "Generating…" : "Generate PDF report"}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        {outstanding
          ? "Every reimbursable receipt you have not yet been paid for, whatever month it came from — anything already marked paid is left out. Includes a summary, a detailed table, and copies of your receipts, each numbered to match the table."
          : "The report includes a summary, a detailed table, and copies of your receipt images, each numbered to match the table."}
      </p>
    </div>
  );
}
