import type {
  Card,
  Category,
  ExtractionResult,
  LearningRule,
  PaymentMethod,
} from "@/lib/types";
import { monthKeyOf } from "@/lib/month";

// Normalises a vendor name for matching/learning (lowercase, alnum + spaces).
export function normalizeVendor(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CARD_TYPE_TO_PAYMENT: Record<Card["card_type"], PaymentMethod> = {
  personal: "personal_card",
  company: "company_card",
  cash: "cash",
  other: "other",
};

export type ClassifyInput = {
  extraction: ExtractionResult;
  cards: Card[];
  categories: Category[];
  rules: LearningRule[];
  usdToTtdRate: number;
  uploadedAt?: Date;
};

export type ClassifyResult = {
  doc_type: ExtractionResult["doc_type"];
  receipt_date: string | null;
  month_key: string;
  vendor_name: string | null;
  amount: number | null;
  currency: string;
  ttd_amount: number | null;
  tax_amount: number | null;
  payment_method: PaymentMethod;
  card_id: string | null;
  card_last4: string | null;
  category_id: string | null;
  reimbursable: boolean | null;
  status: "needs_review" | "confirmed";
  confidence: number;
  review_reasons: string[];
};

/**
 * Deterministic, app-owned classification. Takes the model's raw extraction
 * plus the user's cards / categories / learned rules and decides payment type,
 * reimbursability, category, and whether the item needs manual review.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const { extraction, cards, categories, rules, usdToTtdRate } = input;
  const reasons: string[] = [];

  // --- Card match (by last 4) -------------------------------------------
  let card_id: string | null = null;
  let payment_method: PaymentMethod = extraction.payment_method;
  const last4 = extraction.card_last4?.match(/^\d{4}$/)
    ? extraction.card_last4
    : null;

  if (last4) {
    // First check a learned last4 -> card rule, then the user's cards list.
    const rule = rules.find(
      (r) => r.rule_type === "last4_card" && r.pattern === last4
    );
    const ruleCardId =
      rule && typeof rule.action?.card_id === "string"
        ? (rule.action.card_id as string)
        : null;

    const matchedCard =
      cards.find((c) => c.id === ruleCardId) ??
      cards.find((c) => c.last4 === last4);

    if (matchedCard) {
      card_id = matchedCard.id;
      payment_method = CARD_TYPE_TO_PAYMENT[matchedCard.card_type];
    } else {
      reasons.push(`Card ending ${last4} is not set up yet`);
    }
  }

  if (payment_method === "unknown") {
    reasons.push("Payment method is unclear");
  }

  // --- Reimbursable -----------------------------------------------------
  // Rule: only company-card spend is NOT reimbursable. Everything else
  // (personal card, cash, online, other, unknown) IS reimbursable.
  const reimbursable = payment_method !== "company_card";

  // --- Category ---------------------------------------------------------
  const normVendor = normalizeVendor(extraction.vendor_name);
  let category_id: string | null = null;

  const vendorRule = rules.find(
    (r) => r.rule_type === "vendor_category" && r.pattern === normVendor
  );
  if (vendorRule && typeof vendorRule.action?.category_id === "string") {
    category_id = vendorRule.action.category_id as string;
  }
  if (!category_id && extraction.category_guess) {
    const guess = extraction.category_guess.toLowerCase().trim();
    category_id =
      categories.find((c) => c.name.toLowerCase() === guess)?.id ?? null;
  }
  if (!category_id) {
    reasons.push("Category needs to be chosen");
  }

  // --- Currency / TTD equivalent ---------------------------------------
  const currency = (extraction.currency ?? "TTD").toUpperCase();
  const amount = extraction.amount;
  let ttd_amount: number | null = null;
  if (amount != null) {
    if (currency === "TTD") ttd_amount = round2(amount);
    else if (currency === "USD") ttd_amount = round2(amount * usdToTtdRate);
    else if (extraction.usd_equivalent != null) {
      // Regional invoices (GYD, BBD, XCD ...) routinely print a USD figure for
      // the same total. Valuing via that stated figure is far better than
      // leaving the receipt with no TTD amount, which makes it invisible to
      // matching and to every report.
      ttd_amount = round2(extraction.usd_equivalent * usdToTtdRate);
      reasons.push(
        `Valued from the USD figure printed on the document (USD ${extraction.usd_equivalent}) — check it`
      );
    } else {
      // No local rate and no USD figure: guessing would distort every total.
      ttd_amount = null;
      reasons.push(`Currency ${currency} has no USD figure on the document — set the TTD amount manually`);
    }
  } else {
    reasons.push("Amount could not be read");
  }

  // --- Month bucket -----------------------------------------------------
  // The monthly workspace is organised by UPLOAD date, not the receipt's own
  // date — so everything you upload this month lands in this month's workspace.
  const month_key = monthKeyOf(input.uploadedAt ?? new Date());
  if (!extraction.receipt_date) reasons.push("Date could not be read");

  if (extraction.doc_type === "unknown") reasons.push("Document type unclear");
  if (extraction.confidence < 60)
    reasons.push("Low overall extraction confidence");

  const status = reasons.length === 0 ? "confirmed" : "needs_review";

  return {
    doc_type: extraction.doc_type,
    receipt_date: extraction.receipt_date,
    month_key,
    vendor_name: extraction.vendor_name,
    amount,
    currency,
    ttd_amount,
    tax_amount: extraction.tax_amount,
    payment_method,
    card_id,
    card_last4: last4,
    category_id,
    reimbursable,
    status,
    confidence: extraction.confidence,
    review_reasons: reasons,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
