"use client";

import { useActionState, useRef, useEffect } from "react";
import { createCard, type CardFormState } from "@/lib/cards/actions";

export function CardForm() {
  const [state, action, pending] = useActionState<CardFormState, FormData>(
    createCard,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);

  // Clear the form after a successful add (no error returned).
  useEffect(() => {
    if (!pending && state === undefined) formRef.current?.reset();
  }, [pending, state]);

  return (
    <form
      ref={formRef}
      action={action}
      className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="mb-4 font-semibold text-slate-900">Add a card / payment</h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Nickname
          </span>
          <input
            name="nickname"
            placeholder="e.g. Republic Visa"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Last 4 digits{" "}
            <span className="font-normal text-slate-400">(optional)</span>
          </span>
          <input
            name="last4"
            inputMode="numeric"
            maxLength={4}
            placeholder="1234"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Type
          </span>
          <select
            name="card_type"
            defaultValue="personal"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          >
            <option value="personal">Personal card (reimbursable)</option>
            <option value="company">Company card (accounting only)</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700">
            Notes{" "}
            <span className="font-normal text-slate-400">(optional)</span>
          </span>
          <input
            name="notes"
            placeholder="Anything to remember"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </label>
      </div>

      {state?.error && (
        <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-4 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {pending ? "Adding…" : "Add card"}
      </button>
    </form>
  );
}
