import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import type { UserSettings } from "@/lib/types";
import { SettingsForm } from "@/components/settings/settings-form";
import { ChangePasswordForm } from "@/components/settings/change-password-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: profile }, settingsRes] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user!.id).single(),
    supabase
      .from("user_settings")
      .select(
        "usd_to_ttd_rate, date_tolerance_days, amount_tolerance_pct, " +
          "reconcile_statement_count, receipt_window_days_before, " +
          "receipt_window_days_after, charge_match_days, auto_confirm_enabled"
      )
      .eq("user_id", user!.id)
      .single(),
  ]);
  // No generated DB types, so PostgREST cannot infer a row shape from a select
  // string. Same reason lib/reconciliation/paginate.ts exists.
  const settings = settingsRes.data as Pick<
    UserSettings,
    | "usd_to_ttd_rate"
    | "date_tolerance_days"
    | "amount_tolerance_pct"
    | "reconcile_statement_count"
    | "receipt_window_days_before"
    | "receipt_window_days_after"
    | "charge_match_days"
    | "auto_confirm_enabled"
  > | null;

  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <SettingsForm
        profile={profile ?? { full_name: "", company_name: "" }}
        settings={
          settings ?? {
            usd_to_ttd_rate: 6.8,
            date_tolerance_days: 3,
            amount_tolerance_pct: 5,
            // Mirrors the column defaults in 0014.
            reconcile_statement_count: 4,
            receipt_window_days_before: 60,
            receipt_window_days_after: 15,
            charge_match_days: 4,
            auto_confirm_enabled: false,
          }
        }
      />

      <div className="mt-6">
        <ChangePasswordForm />
      </div>
    </div>
  );
}
