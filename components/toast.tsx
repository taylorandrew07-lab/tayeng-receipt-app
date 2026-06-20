"use client";

import { useEffect, useRef, useState } from "react";

type Variant = "info" | "success" | "error";
type ToastMsg = { id: number; message: string; variant: Variant };

const EVENT = "app-toast";

/**
 * Show a transient toast from any client component — no provider wiring needed.
 * A single <Toaster /> (mounted in the app shell) listens and renders them.
 */
export function toast(message: string, variant: Variant = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { message, variant } }));
}

const STYLES: Record<Variant, string> = {
  info: "border-slate-200 bg-white text-slate-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
};

const ICON: Record<Variant, string> = { info: "ℹ️", success: "✅", error: "⚠️" };

export function Toaster() {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    function onToast(e: Event) {
      const { message, variant } = (e as CustomEvent).detail as {
        message: string;
        variant: Variant;
      };
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant }]);
      // Errors linger a little longer; everything auto-dismisses.
      const ttl = variant === "error" ? 7000 : 4500;
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, ttl);
    }
    window.addEventListener(EVENT, onToast);
    return () => window.removeEventListener(EVENT, onToast);
  }, []);

  const dismiss = (id: number) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${STYLES[t.variant]}`}
        >
          <span aria-hidden>{ICON[t.variant]}</span>
          <span className="flex-1 leading-relaxed">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="shrink-0 text-slate-400 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
