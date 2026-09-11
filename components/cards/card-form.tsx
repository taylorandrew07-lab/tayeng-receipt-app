"use client";

import { useActionState, useRef, useEffect } from "react";
import Link from "next/link";
import { createCard, updateCard, type CardFormState } from "@/lib/cards/actions";
import type { Card } from "@/lib/types";

const field =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

/**
 * Add a card, or edit one in place when `card` is given.
 *
 * One form for both so the validation rules and the field list cannot drift
 * apart between adding and editing.
 */
export function CardForm({ card }: { card?: Card }) {
  const editing = Boolean(card);
  const [state, action, pending] = useActionState<CardFormState, FormData>(
    editing ? updateCard : createCard,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the form after a successful ADD only. Resetting an edit form would
  // blank the values the user just saved. (updateCard redirects on success, so
  // this effect never fires for an edit anyway — the guard is the intent.)
  useEffect(() => {
    if (!editing && !pending && state === undefined) formRef.current?.reset();
  }, [editing, pending, state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="mb-4 font-semibold text-slate-900">
        {editing ? `Edit ${card!.nickname}` : "Add a card / payment"}
      </h2>

      {editing && <input type="hidden" name="id" value={card!.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Nickname</span>
          <input
            name="nickname"
            defaultValue={card?.nickname ?? ""}
            placeholder="e.g. Republic Visa"
            className={field}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Last 4 digits <span className="font-normal text-slate-400">(optional)</span>
          </span>
          <input
            name="last4"
            inputMode="numeric"
            maxLength={4}
            defaultValue={card?.last4 ?? ""}
            placeholder="1234"
            className={field}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">Type</span>
          <select
            name="card_type"
            defaultValue={card?.card_type ?? "personal"}
            className={`${field} bg-white`}
          >
            <option value="personal">Personal card (reimbursable)</option>
            <option value="company">Company card (accounting only)</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Notes <span className="font-normal text-slate-400">(optional)</span>
          </span>
          <input
            name="notes"
            defaultValue={card?.notes ?? ""}
            placeholder="Anything to remember"
            className={field}
          />
        </label>
      </div>

      {state?.error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      {/* Said plainly, because it is genuinely surprising: the app decides a
          receipt's payment type when the receipt is read, and never revisits
          it. Editing a card changes what happens NEXT, not what already
          happened. */}
      {editing && (
        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This changes how <strong>new</strong> receipts are read. Receipts already
          processed keep the payment type they were given — open one and save it again to
          change it.
        </p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending ? (editing ? "Saving…" : "Adding…") : editing ? "Save changes" : "Add card"}
        </button>
        {editing && (
          <Link href="/cards" className="text-sm font-medium text-slate-500 hover:text-slate-800">
            Cancel
          </Link>
        )}
      </div>
    </form>
  );
}
