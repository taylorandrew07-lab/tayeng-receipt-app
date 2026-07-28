import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { StatementUploader } from "@/components/statements/statement-uploader";
import { DeleteStatementButton } from "@/components/statements/delete-statement-button";

type StatementRow = {
  id: string;
  file_name: string;
  period_start: string | null;
  period_end: string | null;
  created_at: string;
  statement_transactions: { count: number }[];
};

export default async function StatementsPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("statements")
    .select("id, file_name, period_start, period_end, created_at, statement_transactions(count)")
    .order("created_at", { ascending: false });

  const statements = (data ?? []) as StatementRow[];

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Statements"
        subtitle="Upload credit card statement PDFs. The app reads the transactions so it can match them to your receipts."
      />

      <div className="mb-8">
        <StatementUploader />
      </div>

      <h2 className="mb-3 font-semibold text-slate-900">Your statements</h2>
      {statements.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No statements yet.
        </div>
      ) : (
        <ul className="space-y-3">
          {statements.map((st) => (
            <li
              key={st.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300 hover:shadow"
            >
              <Link href={`/statements/${st.id}`} className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-900">{st.file_name}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {st.period_start && st.period_end
                    ? `${st.period_start} → ${st.period_end}`
                    : "Period not detected"}
                </p>
              </Link>
              <span className="whitespace-nowrap text-sm text-slate-500">
                {st.statement_transactions?.[0]?.count ?? 0} transactions
              </span>
              <DeleteStatementButton id={st.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
