// Month bucket helpers. A "month_key" is a 'YYYY-MM' string used to group
// receipts into the monthly workspace.

export function monthKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
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
