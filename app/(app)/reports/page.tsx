import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ReportLauncher } from "@/components/reports/report-launcher";
import { currentMonthKey } from "@/lib/month";

export default function ReportsPage() {
  return <ReportsContent />;
}

async function ReportsContent() {
  const supabase = await createClient();
  const { data: monthRows } = await supabase
    .from("receipts")
    .select("month_key")
    .not("month_key", "is", null);

  const monthSet = new Set<string>([currentMonthKey()]);
  (monthRows ?? []).forEach((r) => r.month_key && monthSet.add(r.month_key));
  const months = Array.from(monthSet).sort().reverse();

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Monthly Report"
        subtitle="Generate a professional PDF for the month: summary totals, a detailed table, and receipt images."
      />
      <ReportLauncher months={months} />
    </div>
  );
}
