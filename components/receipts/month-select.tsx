"use client";

import { useRouter } from "next/navigation";
import { formatMonthKey } from "@/lib/month";

export function MonthSelect({
  months,
  current,
}: {
  months: string[];
  current: string;
}) {
  const router = useRouter();
  return (
    <select
      value={current}
      onChange={(e) => router.push(`/receipts?month=${e.target.value}`)}
      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
    >
      {months.map((m) => (
        <option key={m} value={m}>
          {formatMonthKey(m)}
        </option>
      ))}
    </select>
  );
}
