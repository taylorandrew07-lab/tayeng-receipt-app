import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings/settings-form";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase.from("profiles").select("full_name, company_name").eq("id", user!.id).single(),
    supabase
      .from("user_settings")
      .select("usd_to_ttd_rate, date_tolerance_days, amount_tolerance_pct")
      .eq("user_id", user!.id)
      .single(),
  ]);

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
          }
        }
      />
    </div>
  );
}
