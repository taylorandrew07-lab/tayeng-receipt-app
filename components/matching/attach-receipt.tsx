"use client";

import { useActionState, useMemo, useState } from "react";
import { attachReceiptToCharge, type AttachResult } from "@/lib/matching/actions";
import { formatTTD } from "@/lib/month";

export type PickableReceipt = {
  id: string;
  vendor_name: string | null;
  ttd_amount: number | null;
  receipt_date: string | null;
};

/**
 * Lets the user pick a receipt for a statement line the matcher could not
 * place. Sorted by how close each receipt is to the line's amount, because
 * that is overwhelmingly the strongest signal when a person is scanning.
 */
export function AttachReceipt({
  txnId,
  txnAmount,
  receipts,
}: {
  txnId: string;
  txnAmount: number | null;
  receipts: PickableReceipt[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState("");
  const [state, action, pending] = useActionState<AttachResult, FormData>(
    attachReceiptToCharge,
    null
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? receipts.filter(
          (r) =>
            (r.vendor_name ?? "").toLowerCase().includes(q) ||
            String(r.ttd_amount ?? "").includes(q) ||
            (r.receipt_date ?? "").includes(q)
        )
      : receipts;
    if (txnAmount == null) return filtered.slice(0, 40);
    return [...filtered]
      .sort(
        (a, b) =>
          Math.abs(Number(a.ttd_amount ?? 0) - txnAmount) -
          Math.abs(Number(b.ttd_amount ?? 0) - txnAmount)
      )
      .slice(0, 40);
  }, [query, receipts, txnAmount]);

  if (state?.ok) {
    return <span className="text-xs font-medium text-green-700">✓ {state.message}</span>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
      >
        Attach a receipt
      </button>
    );
  }

  return (
    <form action={action} className="mt-3 w-full rounded-lg border border-slate-200 bg-slate-50 p-3">
      <input type="hidden" name="txn_id" value={txnId} />
      <input type="hidden" name="receipt_id" value={picked} />

      <div className="mb-2 flex items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by shop, amount or date…"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
        />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-slate-500 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>

      {receipts.length === 0 ? (
        <p className="px-1 py-2 text-xs text-slate-500">
          Every receipt you have is already attached to a charge. Upload the missing receipt first,
          then come back here.
        </p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {results.map((r) => {
            const exact =
              txnAmount != null && Math.abs(Number(r.ttd_amount ?? 0) - txnAmount) < 0.005;
            return (
              <li key={r.id}>
                <label
                  className={`flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-sm ${
                    picked === r.id
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-transparent hover:bg-white"
                  }`}
                >
                  <input
                    type="radio"
                    name="pick"
                    checked={picked === r.id}
                    onChange={() => setPicked(r.id)}
                    className="accent-emerald-600"
                  />
                  <span className="min-w-0 flex-1 truncate text-slate-900">
                    {r.vendor_name ?? "Unknown"}
                  </span>
                  <span className="whitespace-nowrap text-xs text-slate-500">
                    {r.receipt_date ?? "—"}
                  </span>
                  <span
                    className={`whitespace-nowrap text-xs ${
                      exact ? "font-semibold text-green-700" : "text-slate-500"
                    }`}
                  >
                    {r.ttd_amount != null ? formatTTD(Number(r.ttd_amount)) : "—"}
                    {exact ? " ·  exact" : ""}
                  </span>
                </label>
              </li>
            );
          })}
          {results.length === 0 && (
            <li className="px-2 py-2 text-xs text-slate-500">No receipt matches that search.</li>
          )}
        </ul>
      )}

      {state && !state.ok && (
        <p className="mt-2 text-xs font-medium text-red-700">{state.message}</p>
      )}

      <button
        type="submit"
        disabled={!picked || pending}
        className="mt-2 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending ? "Attaching…" : "Attach this receipt"}
      </button>
    </form>
  );
}
