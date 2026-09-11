"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-read an EXISTING statement — never re-upload it.
 *
 * The retry for a failed read, and the way an already-uploaded statement picks
 * up its printed totals so it can be proven complete. Safe to press at any
 * time: the server validates the new reading before touching anything and
 * keeps the existing lines if the statement already has confirmed receipts
 * (see app/api/statements/parse/route.ts).
 */
export function RereadStatementButton({ statementId }: { statementId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function reread() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/statements/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementId }),
      });
      const json = await res.json().catch(() => ({}));
      setResult(
        res.ok
          ? { ok: json.reconciled !== false, text: json.message ?? "Read again." }
          : { ok: false, text: json.error ?? "Reading the statement failed. Nothing was changed." }
      );
      router.refresh();
    } catch {
      setResult({ ok: false, text: "Couldn't reach the server. Nothing was changed — try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={reread}
        disabled={busy}
        className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
      >
        {busy ? "Reading… (up to a minute)" : "Read this statement again"}
      </button>
      {result && (
        <p
          role="status"
          className={`max-w-xs text-right text-xs ${result.ok ? "text-slate-600" : "text-red-700"}`}
        >
          {result.text}
        </p>
      )}
    </div>
  );
}
