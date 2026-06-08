"use client";

import Image from "next/image";
import { useActionState } from "react";
import { requestPasswordReset, type AuthState } from "@/lib/auth/actions";

export default function ForgotPasswordPage() {
  const [state, action, pending] = useActionState<AuthState, FormData>(
    requestPasswordReset,
    undefined
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <Image src="/logo.png" alt="Tayeng Receipts" width={72} height={72} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-900">Reset your password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your email and we&apos;ll send you a reset link.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <form action={action} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">Email</span>
              <input
                name="email"
                type="email"
                required
                placeholder="you@company.com"
                autoComplete="email"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
              />
            </label>

            {state?.error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>
            )}
            {state?.message && (
              <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">{state.message}</p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-slate-900 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? "Sending…" : "Send reset link"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm">
          <a href="/login" className="font-medium text-slate-600 hover:text-slate-900">
            ← Back to sign in
          </a>
        </p>
      </div>
    </main>
  );
}
