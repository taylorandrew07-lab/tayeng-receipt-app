"use client";

import Image from "next/image";
import { useActionState } from "react";
import { updatePassword, type AuthState } from "@/lib/auth/actions";

export default function ResetPasswordPage() {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    updatePassword,
    undefined
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Image src="/logo.png" alt="Tayeng Receipts" width={72} height={72} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-900">Choose a new password</h1>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <form action={action} className="space-y-4">
            <Field label="New password" name="password" />
            <Field label="Confirm new password" name="confirm_password" />

            {state?.error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? "Saving…" : "Set new password"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

function Field({ label, name }: { label: string; name: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        name={name}
        type="password"
        required
        placeholder="••••••••"
        autoComplete="new-password"
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
      />
    </label>
  );
}
