/**
 * Is a freshly parsed statement fit to REPLACE what we already hold?
 *
 * Decided BEFORE any existing row is touched. The previous flow deleted a
 * statement's lines first and asked questions afterwards, so a parse that read
 * nothing — a timeout, the wrong document, a model hiccup — wiped a statement
 * that had been correct.
 *
 * Pure: no I/O, so every rule is unit-tested.
 */

export type ParsedLine = {
  date: string | null;
  description: string | null;
  amount: number | null;
  direction: "debit" | "credit";
  currency: string | null;
  card_last4: string | null;
};

export type ParsedForValidation = {
  document_kind: "credit_card" | "bank_account" | "other";
  billing_currency?: string | null;
  total_purchases: number | null;
  transactions: ParsedLine[];
};

/** What we already hold for this statement, if anything. */
export type ExistingStatement = {
  lineCount: number;
  /** true = the lines we hold add up to the printed total. */
  reconciled: boolean | null;
};

export type Verdict =
  | {
      ok: true;
      debits: ParsedLine[];
      creditsExcluded: number;
      lineTotal: number;
      /** The single currency every stored amount is in. */
      currency: string;
    }
  | { ok: false; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

function realDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // Rejects 2026-02-30, which Date would otherwise roll over into March.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateParsedStatement(
  parsed: ParsedForValidation,
  existing: ExistingStatement,
  today: Date = new Date()
): Verdict {
  // 1. Only credit card statements. Everything downstream — the fee regex,
  //    "a PAYMENT line is a payment to the card" — assumes one. On a bank
  //    statement debits and credits run the other way.
  if (parsed.document_kind === "bank_account") {
    return {
      ok: false,
      reason:
        "This looks like a bank account statement, not a credit card statement. The app reads credit card statements only — on a bank statement every line would be read backwards. Nothing was changed.",
    };
  }
  if (parsed.document_kind !== "credit_card") {
    return {
      ok: false,
      reason:
        "This doesn't look like a credit card statement. Check you picked the right file. Nothing was changed.",
    };
  }

  const priced = parsed.transactions.filter((t) => t.amount != null);
  const debits = priced.filter((t) => t.direction !== "credit");
  const creditsExcluded = priced.length - debits.length;

  // 2. Reading nothing must never replace something.
  if (debits.length === 0) {
    return {
      ok: false,
      reason:
        existing.lineCount > 0
          ? `No charges could be read this time, so the ${existing.lineCount} lines already held for this statement were kept. Try again, or re-upload a clearer copy.`
          : "No charges could be read from this statement. Try again, or upload a clearer copy.",
    };
  }

  // 3. Every line must be something we can store truthfully.
  const latest = new Date(today.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
  const bad = debits.filter((t) => {
    const a = Number(t.amount);
    if (!Number.isFinite(a) || a <= 0 || a >= 10_000_000) return true;
    if (t.date != null && (!realDate(t.date) || t.date < "2000-01-01" || t.date > latest)) {
      return true;
    }
    return false;
  });
  if (bad.length > 0) {
    return {
      ok: false,
      reason: `${bad.length} line${bad.length === 1 ? "" : "s"} came back with an impossible date or amount, so this reading was not used. Nothing was changed. Try again.`,
    };
  }

  // 4. ONE currency. A total is only a total if every figure in it is in the
  //    same currency; summing TTD and USD lines produces a number that means
  //    nothing and would be printed as TTD. Refuse rather than store it.
  const currency = (parsed.billing_currency ?? debits[0].currency ?? "TTD").toUpperCase();
  const foreign = debits.filter((t) => (t.currency ?? currency).toUpperCase() !== currency);
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `${foreign.length} line${foreign.length === 1 ? " is" : "s are"} in a different currency from the rest of the statement (${currency}), so the lines can't be added up. Nothing was changed. Try again.`,
    };
  }

  const lineTotal = round2(debits.reduce((a, t) => a + Number(t.amount), 0));

  // 5. Never swap a reading that PROVABLY adds up for one that does not.
  const addsUp =
    parsed.total_purchases == null ? null : Math.abs(lineTotal - parsed.total_purchases) <= 0.01;
  if (existing.lineCount > 0 && existing.reconciled === true && addsUp === false) {
    return {
      ok: false,
      reason: `This new reading comes to ${lineTotal.toFixed(2)} but the statement says ${Number(
        parsed.total_purchases
      ).toFixed(2)}. The lines already held DO add up, so they were kept.`,
    };
  }

  return { ok: true, debits, creditsExcluded, lineTotal, currency };
}
