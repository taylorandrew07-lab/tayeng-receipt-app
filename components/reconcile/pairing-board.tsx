"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attachReceiptToCharge } from "@/lib/matching/actions";
import { formatTTD } from "@/lib/month";

export type BoardCharge = {
  charge_id: string;
  canonical_txn_id: string;
  txn_date: string | null;
  description: string | null;
  amount: number | null;
  currency: string;
  copies: number;
};

export type BoardReceipt = {
  receipt_id: string;
  receipt_date: string | null;
  vendor_name: string | null;
  ttd_amount: number | null;
  currency: string;
  sent: boolean;
};

const dayGap = (a: string | null, b: string | null) => {
  if (!a || !b) return null;
  const d = (Date.parse(a) - Date.parse(b)) / 86_400_000;
  return Number.isNaN(d) ? null : Math.round(Math.abs(d));
};

/**
 * How well a receipt fits the selected charge.
 *
 * Exactness is CURRENCY-AWARE: receipts.ttd_amount for a USD receipt is
 * converted at a single stored rate while the bank used its own on the day,
 * which leaves a consistent sub-1% gap. An absolute "to the cent" test would
 * mean no USD receipt could ever be marked exact.
 */
function fit(charge: BoardCharge, r: BoardReceipt) {
  const a = Number(charge.amount ?? 0);
  const b = Number(r.ttd_amount ?? 0);
  const diff = Math.abs(a - b);
  const sameCurrency = (r.currency ?? "TTD").toUpperCase() === (charge.currency ?? "TTD").toUpperCase();
  const pct = a === 0 ? 1 : diff / Math.abs(a);
  const exact = sameCurrency ? diff < 0.01 : pct <= 0.0075;
  const gap = dayGap(charge.txn_date, r.receipt_date);
  return { diff, pct, exact, gap, sameCurrency };
}

export function PairingBoard({
  charges,
  receipts,
}: {
  charges: BoardCharge[];
  receipts: BoardReceipt[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const [done, setDone] = useState<{ charges: Set<string>; receipts: Set<string> }>({
    charges: new Set(),
    receipts: new Set(),
  });
  const [error, setError] = useState<string | null>(null);
  const [matched, setMatched] = useState(0);

  const openCharges = useMemo(
    () => charges.filter((c) => !done.charges.has(c.charge_id)),
    [charges, done.charges]
  );
  const openReceipts = useMemo(
    () => receipts.filter((r) => !done.receipts.has(r.receipt_id)),
    [receipts, done.receipts]
  );
  const charge = useMemo(
    () => openCharges.find((c) => c.charge_id === selected) ?? null,
    [openCharges, selected]
  );

  // With a charge selected the right-hand list leads with the best fit.
  const rankedReceipts = useMemo(() => {
    if (!charge) return openReceipts;
    return [...openReceipts].sort((x, y) => {
      const fx = fit(charge, x);
      const fy = fit(charge, y);
      if (fx.exact !== fy.exact) return fx.exact ? -1 : 1;
      if (fx.pct !== fy.pct) return fx.pct - fy.pct;
      return (fx.gap ?? 9999) - (fy.gap ?? 9999);
    });
  }, [charge, openReceipts]);

  function pair(c: BoardCharge, r: BoardReceipt) {
    setError(null);
    const fd = new FormData();
    fd.set("txn_id", c.canonical_txn_id);
    fd.set("receipt_id", r.receipt_id);
    startTransition(async () => {
      const res = await attachReceiptToCharge(null, fd);
      if (res?.ok) {
        setDone((d) => ({
          charges: new Set(d.charges).add(c.charge_id),
          receipts: new Set(d.receipts).add(r.receipt_id),
        }));
        setSelected(null);
        setMatched((n) => n + 1);
        router.refresh();
      } else {
        setError(res?.message ?? "Could not match those.");
      }
    });
  }

  const allDone = openCharges.length === 0 && openReceipts.length === 0;

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 mb-3 rounded-lg bg-white/95 px-1 py-2 backdrop-blur">
        <p className="text-sm text-slate-600">
          {charge ? (
            <>
              <span className="font-semibold text-slate-900">
                {charge.description ?? "Charge"}
              </span>{" "}
              selected — now tap the receipt that pays for it.
            </>
          ) : (
            "Tap a charge on the left, then tap its receipt on the right. On a computer you can drag instead."
          )}
        </p>
        {matched > 0 && (
          <p className="mt-1 text-xs font-medium text-green-700">
            {matched} matched this session.
          </p>
        )}
        {error && <p className="mt-1 text-xs font-medium text-red-700">{error}</p>}
      </div>

      {allDone ? (
        <div className="rounded-xl border border-dashed border-emerald-300 bg-emerald-50 p-10 text-center">
          <p className="text-lg font-semibold text-emerald-900">Both sides are clear.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:gap-4">
          {/* LEFT — charges with no receipt */}
          <Panel
            title="On the statements"
            subtitle="no receipt yet"
            count={openCharges.length}
            tone="amber"
          >
            {openCharges.map((c) => {
              const isSel = c.charge_id === selected;
              return (
                <li key={c.charge_id}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/charge", c.charge_id);
                      setSelected(c.charge_id);
                    }}
                    onClick={() => setSelected(isSel ? null : c.charge_id)}
                    disabled={pending}
                    className={`w-full cursor-pointer rounded-lg border px-2 py-2 text-left transition sm:px-3 ${
                      isSel
                        ? "border-slate-900 bg-slate-900 text-white shadow-md"
                        : "border-slate-200 bg-white hover:border-slate-400"
                    }`}
                  >
                    <p className="truncate text-xs font-medium sm:text-sm">
                      {c.description ?? "—"}
                    </p>
                    <p
                      className={`mt-0.5 text-xs ${isSel ? "text-slate-300" : "text-slate-500"}`}
                    >
                      {c.txn_date ?? "no date"}
                    </p>
                    <p className="mt-1 text-sm font-bold sm:text-base">
                      {formatTTD(Number(c.amount ?? 0))}
                    </p>
                    {c.copies > 1 && (
                      <p
                        className={`mt-0.5 text-[10px] ${
                          isSel ? "text-slate-300" : "text-slate-400"
                        }`}
                      >
                        on {c.copies} statements
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </Panel>

          {/* RIGHT — receipts with no charge */}
          <Panel
            title="Your receipts"
            subtitle="not on any statement"
            count={openReceipts.length}
            tone="sky"
          >
            {rankedReceipts.map((r) => {
              const f = charge ? fit(charge, r) : null;
              return (
                <li key={r.receipt_id}>
                  <button
                    type="button"
                    onDragOver={(e) => charge && e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData("text/charge");
                      const c = openCharges.find((x) => x.charge_id === id);
                      if (c) pair(c, r);
                    }}
                    onClick={() => charge && pair(charge, r)}
                    disabled={pending || !charge}
                    className={`w-full rounded-lg border px-2 py-2 text-left transition sm:px-3 ${
                      !charge
                        ? "border-slate-200 bg-white opacity-70"
                        : f?.exact
                          ? "cursor-pointer border-green-500 bg-green-50 hover:bg-green-100"
                          : "cursor-pointer border-slate-200 bg-white hover:border-slate-400"
                    }`}
                  >
                    <p className="truncate text-xs font-medium text-slate-900 sm:text-sm">
                      {r.vendor_name ?? "Unknown"}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {r.receipt_date ?? "no date"}
                      {f?.gap != null && <span> · {f.gap}d away</span>}
                    </p>
                    <p className="mt-1 text-sm font-bold text-slate-900 sm:text-base">
                      {r.ttd_amount != null ? formatTTD(Number(r.ttd_amount)) : "—"}
                    </p>
                    {r.currency !== "TTD" && (
                      <p className="mt-0.5 text-[10px] text-slate-400">
                        {r.currency} original
                      </p>
                    )}
                    {f?.exact && (
                      <p className="mt-0.5 text-[10px] font-semibold text-green-700">
                        {f.sameCurrency ? "exact amount" : "matches after conversion"}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </Panel>
        </div>
      )}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  count,
  tone,
  children,
  onDrop,
}: {
  title: string;
  subtitle: string;
  count: number;
  tone: "amber" | "sky";
  children: React.ReactNode;
  onDrop?: (e: React.DragEvent) => void;
}) {
  const head = tone === "amber" ? "text-amber-700" : "text-sky-700";
  return (
    <div onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="mb-2">
        <h2 className={`text-sm font-bold ${head}`}>
          {title} <span className="font-normal text-slate-400">({count})</span>
        </h2>
        <p className="text-xs text-slate-400">{subtitle}</p>
      </div>
      {count === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-2 py-6 text-center text-xs text-slate-400">
          All clear.
        </p>
      ) : (
        <ul className="space-y-2">{children}</ul>
      )}
    </div>
  );
}
