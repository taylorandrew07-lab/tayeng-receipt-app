import Link from "next/link";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:mb-7 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-[1.75rem]">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-slate-500">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "good" | "warn";
  href?: string;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
        ? "text-amber-600"
        : "text-slate-900";

  const inner = (
    <>
      <p className="text-[0.8rem] font-medium text-slate-500">{label}</p>
      <p className={`mt-2 text-3xl font-bold tracking-tight tabular-nums ${toneClass}`}>
        {value}
      </p>
      {hint && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-slate-400">
          {hint}
          {href && (
            <span className="text-slate-300 transition-transform group-hover:translate-x-0.5">
              →
            </span>
          )}
        </p>
      )}
    </>
  );

  const base =
    "rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]";

  if (href) {
    return (
      <Link
        href={href}
        className={`group block ${base} transition duration-200 ease-out hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_28px_rgba(15,23,42,0.08)]`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={base}>{inner}</div>;
}

export function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <PageHeader title={title} />
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
        <p className="text-sm text-slate-500">{note}</p>
        <Link
          href="/dashboard"
          className="mt-4 inline-block text-sm font-medium text-slate-900 underline-offset-4 hover:underline"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
