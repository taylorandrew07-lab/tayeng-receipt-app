"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { runConsolidatedMatching, type MatchRunSummary } from "@/lib/matching/actions";

/**
 * The consolidated close-out run: every statement in scope at once.
 *
 * Always reports what it did. A run that finds nothing looks identical to a run
 * that failed, so the result line is not optional.
 */
export function RunMatchingButton() {
  const router = useRouter();
  const [state, action, pending] = useActionState<MatchRunSummary | null, FormData>(
    runConsolidatedMatching,
    null
  );

  // Pull the freshly-written suggestions onto the page.
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-60"
        >
          {pending ? "Looking…" : "Find matches"}
        </button>
      </form>
      {state && (
        <p
          className={`max-w-xs text-right text-xs ${
            state.ok ? "text-slate-500" : "text-red-600"
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
