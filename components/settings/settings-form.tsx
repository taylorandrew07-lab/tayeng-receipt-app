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
    "usd_to_ttd_rate" | "date_tolerance_days" | "amount_tolerance_pct"
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

      {state?.error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</p>
      )}
      {state?.ok && (
        <p className="rounded-md bg-green-50 px-3 py-2 text-sm text-green-700">Saved.</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}

const cls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      {children}
    </label>
  );
}
