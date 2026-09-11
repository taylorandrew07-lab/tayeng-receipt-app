"use client";

import { useActionState } from "react";
import { saveSettings, type SettingsState } from "@/lib/settings/actions";
import type { Profile, UserSettings } from "@/lib/types";

export function SettingsForm({
  profile,
  settings,
}: {
  profile: Pick<Profile, "full_name" | "company_name">;
  settings: Pick<
    UserSettings,
    | "usd_to_ttd_rate"
    | "date_tolerance_days"
    | "amount_tolerance_pct"
    | "reconcile_statement_count"
    | "receipt_window_days_before"
    | "receipt_window_days_after"
    | "charge_match_days"
    | "auto_confirm_enabled"
  >;
}) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(
    saveSettings,
    undefined
  );

  return (
    <form action={action} className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-4 font-semibold text-slate-900">Your details</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your name">
            <input name="full_name" defaultValue={profile.full_name ?? ""} className={cls} />
          </Field>
          <Field label="Company name (shown on reports)">
            <input
              name="company_name"
              defaultValue={profile.company_name ?? ""}
              className={cls}
            />
          </Field>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-1 font-semibold text-slate-900">Currency & matching</h2>
        <p className="mb-4 text-sm text-slate-500">
          USD invoices (e.g. Amazon) are converted to TTD using this rate.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="USD → TTD rate">
            <input
              name="usd_to_ttd_rate"
              inputMode="decimal"
              defaultValue={String(settings.usd_to_ttd_rate)}
              className={cls}
            />
          </Field>
          <Field label="Date tolerance (days)">
            <input
              name="date_tolerance_days"
              inputMode="numeric"
              defaultValue={String(settings.date_tolerance_days)}
              className={cls}
            />
          </Field>
          <Field label="Amount tolerance (%)">
            <input
              name="amount_tolerance_pct"
              inputMode="decimal"
              defaultValue={String(settings.amount_tolerance_pct)}
              className={cls}
            />
          </Field>
        </div>
      </section>

      {/* The scope of a close-out run. These columns have existed since July
          but nothing read or wrote them, so the rules could not be seen or
          changed from inside the app. Worded as questions, not column names. */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold text-slate-900">Closing out statements</h2>
        <p className="mb-4 mt-1 text-sm text-slate-500">
          How far the app looks when it goes hunting for receipts.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How many statements to check at once (0 = all of them)">
            <input
              name="reconcile_statement_count"
              inputMode="numeric"
              defaultValue={String(settings.reconcile_statement_count)}
              className={cls}
            />
          </Field>
          <Field label="Treat statement lines this many days apart as the same charge">
            <input
              name="charge_match_days"
              inputMode="numeric"
              defaultValue={String(settings.charge_match_days)}
              className={cls}
            />
          </Field>
          <Field label="Look for receipts up to this many days BEFORE the statement starts">
            <input
              name="receipt_window_days_before"
              inputMode="numeric"
              defaultValue={String(settings.receipt_window_days_before)}
              className={cls}
            />
          </Field>
          <Field label="...and up to this many days AFTER it ends">
            <input
              name="receipt_window_days_after"
              inputMode="numeric"
              defaultValue={String(settings.receipt_window_days_after)}
              className={cls}
            />
          </Field>
        </div>

        <label className="mt-4 flex items-start gap-3 rounded-lg bg-slate-50 p-3">
          <input
            type="checkbox"
            name="auto_confirm_enabled"
            defaultChecked={settings.auto_confirm_enabled}
            className="mt-0.5 h-4 w-4 accent-emerald-600"
          />
          <span className="text-sm text-slate-700">
            <strong>Let a run tick things off by itself when it is certain.</strong>
            <span className="mt-0.5 block text-xs text-slate-500">
              Off is safer, and is how it is meant to run. With this on, a confident match
              is confirmed without asking you — which once closed a real open charge using
              a receipt from 77 days away.
            </span>
          </span>
        </label>
      </section>

      {state?.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Saved.</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}

const cls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
