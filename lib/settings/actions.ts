"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type SettingsState = { error?: string; ok?: boolean } | undefined;

export async function saveSettings(
  _prev: SettingsState,
  formData: FormData
): Promise<SettingsState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const full_name = String(formData.get("full_name") ?? "").trim();
  const company_name = String(formData.get("company_name") ?? "").trim();
  const rate = Number(formData.get("usd_to_ttd_rate"));
  const dateTol = parseInt(String(formData.get("date_tolerance_days") ?? "3"), 10);
  const amtTol = Number(formData.get("amount_tolerance_pct"));

  // Consolidated reconciliation scope (0014). These columns existed since July
  // but nothing read or wrote them, so the scope Andrew decided on could not be
  // seen or changed from inside the app.
  const intIn = (name: string, fallback: number, min: number, max: number) => {
    const n = parseInt(String(formData.get(name) ?? ""), 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  };
  const stmtCount = intIn("reconcile_statement_count", 4, 0, 100);
  const windowBefore = intIn("receipt_window_days_before", 60, 0, 365);
  const windowAfter = intIn("receipt_window_days_after", 15, 0, 365);
  const chargeDays = intIn("charge_match_days", 4, 0, 31);
  const autoConfirm = String(formData.get("auto_confirm_enabled") ?? "") === "on";

  if (!Number.isFinite(rate) || rate <= 0) {
    return { error: "Exchange rate must be a positive number." };
  }

  const { error: pErr } = await supabase
    .from("profiles")
    .update({ full_name: full_name || null, company_name: company_name || null })
    .eq("id", user.id);
  if (pErr) return { error: pErr.message };

  const { error: sErr } = await supabase
    .from("user_settings")
    .update({
      usd_to_ttd_rate: rate,
      date_tolerance_days: Number.isFinite(dateTol) ? dateTol : 3,
      amount_tolerance_pct: Number.isFinite(amtTol) ? amtTol : 5,
      reconcile_statement_count: stmtCount,
      receipt_window_days_before: windowBefore,
      receipt_window_days_after: windowAfter,
      charge_match_days: chargeDays,
      auto_confirm_enabled: autoConfirm,
    })
    .eq("user_id", user.id);
  if (sErr) return { error: sErr.message };

  revalidatePath("/settings");
  revalidatePath("/reconcile");
  return { ok: true };
}
