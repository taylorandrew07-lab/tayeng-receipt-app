// Shared domain types mirroring the Supabase schema (supabase/migrations).
// Hand-maintained for clarity; can be regenerated with `supabase gen types`.

export type CardType = "personal" | "company" | "cash" | "other";

export type PaymentMethod =
  | "personal_card"
  | "company_card"
  | "cash"
  | "online"
  | "unknown"
  | "other";

export type DocType = "receipt" | "invoice" | "statement" | "unknown";

export type ReceiptStatus = "processing" | "needs_review" | "confirmed";

export type MatchStatus =
  | "matched"
  | "possible_match"
  | "unmatched_receipt"
  | "missing_receipt"
  | "needs_review";

export type RuleType = "vendor_category" | "last4_card" | "vendor_payment";

export type Profile = {
  id: string;
  full_name: string | null;
  company_name: string | null;
  role: "user" | "admin" | "super_admin";
  approved: boolean;
  created_at: string;
  updated_at: string;
};

export type UserSettings = {
  user_id: string;
  base_currency: string;
  usd_to_ttd_rate: number;
  date_tolerance_days: number;
  amount_tolerance_pct: number;
  created_at: string;
  updated_at: string;
};

export type Category = {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  created_at: string;
};

export type Card = {
  id: string;
  user_id: string;
  nickname: string;
  last4: string | null;
  card_type: CardType;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Vendor = {
  id: string;
  user_id: string;
  name: string;
  normalized_name: string;
  default_category_id: string | null;
  created_at: string;
  updated_at: string;
};

export type Receipt = {
  id: string;
  user_id: string;
  receipt_date: string | null;
  month_key: string | null;
  vendor_name: string | null;
  vendor_id: string | null;
  category_id: string | null;
  doc_type: DocType;
  amount: number | null;
  currency: string;
  ttd_amount: number | null;
  tax_amount: number | null;
  payment_method: PaymentMethod;
  card_id: string | null;
  card_last4: string | null;
  reimbursable: boolean | null;
  status: ReceiptStatus;
  confidence: number | null;
  raw_extraction: ExtractionResult | null;
  notes: string | null;
  duplicate_of: string | null;
  not_duplicate: boolean;
  sent: boolean;
  sent_at: string | null;
  paid: boolean;
  paid_at: string | null;
  bill_back: boolean;
  bill_back_type: "client" | "vessel" | null;
  bill_back_name: string | null;
  bill_back_normalized: string | null;
  created_at: string;
  updated_at: string;
};

export type ReceiptFile = {
  id: string;
  receipt_id: string | null;
  user_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
};

export type Statement = {
  id: string;
  user_id: string;
  card_id: string | null;
  period_start: string | null;
  period_end: string | null;
  storage_path: string;
  file_name: string;
  created_at: string;
};

export type StatementTransaction = {
  id: string;
  statement_id: string;
  user_id: string;
  txn_date: string | null;
  description: string | null;
  amount: number | null;
  currency: string;
  card_last4: string | null;
  is_matched: boolean;
  /** Cross-statement identity of the real-world charge (migration 0015). */
  charge_id: string | null;
  created_at: string;
};

export type ReceiptStatementMatch = {
  id: string;
  user_id: string;
  receipt_id: string | null;
  statement_transaction_id: string | null;
  status: MatchStatus;
  confidence: number | null;
  confirmed: boolean;
  created_at: string;
  updated_at: string;
};

export type MonthlyReport = {
  id: string;
  user_id: string;
  month_key: string;
  storage_path: string | null;
  totals: ReportTotals | null;
  generated_at: string;
};

export type LearningRule = {
  id: string;
  user_id: string;
  rule_type: RuleType;
  pattern: string;
  action: Record<string, unknown>;
  hit_count: number;
  created_at: string;
  updated_at: string;
};

// Shape returned by the Claude extraction step (stored in receipts.raw_extraction).
export type ExtractionResult = {
  doc_type: DocType;
  receipt_date: string | null;
  vendor_name: string | null;
  amount: number | null;
  currency: string | null;
  tax_amount: number | null;
  payment_method: PaymentMethod;
  card_last4: string | null;
  category_guess: string | null;
  confidence: number; // 0-100
  notes?: string | null;
};

export type ReportTotals = {
  reimbursable: number;
  personal_card: number;
  cash: number;
  company_card: number;
  needs_review_count: number;
  unmatched_count: number;
};
