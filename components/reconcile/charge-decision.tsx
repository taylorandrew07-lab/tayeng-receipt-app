"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { setChargeClosed, type ChargeDecisionResult } from "@/lib/matching/actions";

/**
 * Close a charge as needing no receipt, or reopen a closed one — both
 * recorded as a person's decision (0024), and both reversible from the same
 * screen, so neither is a one-way door.
 */
export function ChargeDecision({
  chargeId,
  close,
  label,
  confirmText,
}: {
  chargeId: string;
  close: boolean;
  label: string;
  /** Asked before a close, which takes the charge off the work list. */
  confirmText?: string;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ChargeDecisionResult, FormData>(
    setChargeClosed,
    null
  );

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (confirmText && !window.confirm(confirmText)) e.preventDefault();
      }}
      className="flex flex-col items-end gap-1"
    >
      <input type="hidden" name="charge_id" value={chargeId} />
      <input type="hidden" name="close" value={close ? "1" : "0"} />
      <button
        type="submit"
        disabled={pending}
        className="min-h-11 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-60"
      >
        {pending ? "Saving…" : label}
      </button>
      {state && !state.ok && (
        <p role="alert" className="max-w-xs text-right text-xs text-red-700">
          {state.message}
        </p>
      )}
    </form>
  );
}
