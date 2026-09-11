// Month bucket helpers. A "month_key" is a 'YYYY-MM' string used to group
// receipts into the monthly workspace.

// Business timezone — the monthly workspace is bucketed in local Trinidad time,
// not the UTC server clock, so late-evening month-end uploads land correctly.
const TZ = "America/Port_of_Spain";

export function monthKeyOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${y}-${m}`;
}

export function currentMonthKey(): string {
  return monthKeyOf(new Date());
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function formatMonthKey(key: string): string {
  const [y, m] = key.split("-").map(Number);
  if (!y || !m) return key;
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

export function formatTTD(amount: number | null | undefined): string {
  const n = Number(amount ?? 0);
  return new Intl.NumberFormat("en-TT", {
    style: "currency",
    currency: "TTD",
    minimumFractionDigits: 2,
  }).format(n);
}

/**
 * Format an amount in ITS OWN currency.
 *
 * formatTTD labels whatever it is given as TTD. Handing it a statement line
 * that is really in USD prints the raw USD figure as if it were TTD — a
 * silent 6.8x understatement. Anything whose currency is not certain to be
 * TTD goes through here.
 */
export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  const cur = (currency ?? "TTD").toUpperCase();
  if (cur === "TTD") return formatTTD(amount);
  return `${cur} ${Number(amount ?? 0).toFixed(2)}`;
}
