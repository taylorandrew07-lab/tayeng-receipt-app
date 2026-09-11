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
  // Set when a report comes back in parts: the rest are offered as buttons.
  const [partsLeft, setPartsLeft] = useState<{ endpoint: string; name: string; parts: number } | null>(null);

  // A reimbursement claim is "what am I still owed", not "what happened in
  // July" — an unpaid June receipt still belongs in today's claim.
  const outstanding = type === "reimbursable" && scope === "outstanding";

  /**
   * Fetch one part and save it. The server states the part count in a header;
   * a report with more documents than fit in one PDF comes back in parts, and
   * the remaining parts are offered as buttons rather than silently dropped.
   */
  async function fetchPart(endpoint: string, name: string, part: number) {
    const sep = endpoint.includes("?") ? "&" : "?";
    const res = await fetch(`${endpoint}${sep}part=${part}`);
    // Show the server's own reason — "could not be generated, try again"
    // told Andrew nothing when the real cause was, say, a failed data read.
    if (!res.ok) throw new Error((await res.text()) || "The report could not be generated.");
    const parts = Number(res.headers.get("X-Report-Parts") ?? "1") || 1;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = parts > 1 ? `${name}-part-${part}.pdf` : `${name}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return parts;
  }

  async function download() {
    setDownloading(true);
    setPartsLeft(null);
    const endpoint =
      type === "billback"
        ? `/api/reports/billback?month=${month}`
        : outstanding
          ? `/api/reports/generate?type=reimbursable&scope=outstanding`
          : `/api/reports/generate?month=${month}&type=${type}&scope=month`;
    const name = outstanding
      ? `reimbursable-outstanding-${new Date().toISOString().slice(0, 10)}`
      : `${type}-report-${month}`;
    try {
      const parts = await fetchPart(endpoint, name, 1);
      if (parts > 1) {
        setPartsLeft({ endpoint, name, parts });
        toast(`This report is in ${parts} parts. Part 1 is downloading — get the rest below.`, "info");
      }
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setDownloading(false);
    }
  }

  async function downloadPart(part: number) {
    if (!partsLeft) return;
    setDownloading(true);
    try {
      await fetchPart(partsLeft.endpoint, partsLeft.name, part);
    } catch (e) {
      toast((e as Error).message, "error");
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

      {/* A big report comes in parts so that every receipt can be included.
          Each is a separate PDF; part 1 has the summary and tables. */}
      {partsLeft && (
        <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
          <p className="text-sm font-medium text-sky-900">
            This report is in {partsLeft.parts} parts so every receipt fits. Part 1 has
            downloaded. Get the rest:
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {Array.from({ length: partsLeft.parts - 1 }, (_, i) => i + 2).map((part) => (
              <button
                key={part}
                type="button"
                disabled={downloading}
                onClick={() => downloadPart(part)}
                className="min-h-11 rounded-lg border border-sky-300 bg-white px-4 py-2 text-sm font-semibold text-sky-900 hover:bg-sky-100 disabled:opacity-60"
              >
                Part {part} of {partsLeft.parts}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
