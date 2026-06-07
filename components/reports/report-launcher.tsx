"use client";

import { useState } from "react";
import { formatMonthKey } from "@/lib/month";

export function ReportLauncher({ months }: { months: string[] }) {
  const [month, setMonth] = useState(months[0]);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const res = await fetch(`/api/reports/generate?month=${month}`);
      if (!res.ok) throw new Error("Failed to generate report");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `expense-report-${month}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert("Sorry, the report could not be generated. Please try again.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Month</span>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
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
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {downloading ? "Generating…" : "Generate PDF report"}
        </button>
      </div>
      <p className="mt-3 text-xs text-slate-400">
        The report includes a summary, a detailed table, and copies of your receipt
        images, each numbered to match the table.
      </p>
    </div>
  );
}
