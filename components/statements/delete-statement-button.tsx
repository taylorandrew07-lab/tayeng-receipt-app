"use client";

import { useActionState } from "react";
import { deleteStatement, type DeleteStatementResult } from "@/lib/statements/actions";

/**
 * Two-step delete. The first press asks the server what the delete will cost
 * (how many confirmed receipt matches hang off this statement) and shows it;
 * the second press goes ahead. Replaces a bare window.confirm() that could not
 * know the cost.
 */
export function DeleteStatementButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<DeleteStatementResult, FormData>(
    deleteStatement,
    null
  );

  const asking = state && !state.ok && state.needsConfirm;

  return (
    <div className="flex flex-col items-end gap-2">
      {asking && (
        <div className="max-w-sm rounded-lg border border-amber-300 bg-amber-50 p-3 text-left">
          <p className="text-sm text-amber-900">{state.message}</p>
          {state.matchCount > 0 && (
            <p className="mt-1 text-xs text-amber-800">
              The receipts themselves are not deleted.
            </p>
          )}
        </div>
      )}

      {state && !state.ok && !state.needsConfirm && (
        <p className="max-w-sm text-right text-sm font-medium text-red-700">{state.message}</p>
      )}

      <form action={action}>
        <input type="hidden" name="id" value={id} />
        {asking && <input type="hidden" name="confirm" value="1" />}
        <button
          type="submit"
          disabled={pending}
          className={
            asking
              ? "rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              : "rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-red-50 hover:text-red-700 disabled:opacity-60"
          }
        >
          {pending
            ? "Working…"
            : asking
              ? "Yes, delete it"
              : "Delete"}
        </button>
      </form>
    </div>
  );
}
