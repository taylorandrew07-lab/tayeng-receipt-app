"use client";

import { useActionState, useRef, useEffect } from "react";
import { changePassword, type AuthState } from "@/lib/auth/actions";

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    changePassword,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.message) formRef.current?.reset();
  }, [state]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 font-semibold text-slate-900">Change password</h2>
      <p className="mb-4 text-sm text-slate-500">
        Enter your current password, then your new password twice.
      </p>
      <form ref={formRef} action={action} className="space-y-4">
        <Field label="Current password" name="current_password" autoComplete="current-password" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New password" name="password" autoComplete="new-password" />
          <Field label="Confirm new password" name="confirm_password" autoComplete="new-password" />
        </div>

        {state?.error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>
        )}
        {state?.message && (
          <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{state.message}</p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Updating…" : "Update password"}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  name,
  autoComplete,
}: {
  label: string;
  name: string;
  autoComplete: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type="password"
        required
        autoComplete={autoComplete}
        placeholder="••••••••"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
      />
    </label>
  );
}
