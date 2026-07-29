export type ChargeState =
  | "no_receipt_expected"
  | "already_sent"
  | "already_matched"
  | "needs_confirmation"
  | "genuinely_new";

/** One real-world charge, merged across every statement that carried it. */
export type ChargeRow = {
  charge_id: string;
  txn_date: string | null;
  description: string | null;
  amount: number | null;
  currency: string;
  card_last4: string | null;
  canonical_txn_id: string;
  statement_ids: string[];
  statement_names: string[];
  copies: number;
  is_duplicate: boolean;
  no_receipt_expected: boolean;
  fee_auto_flagged: boolean;
  match_id: string | null;
  receipt_id: string | null;
  receipt_vendor: string | null;
  receipt_date: string | null;
  receipt_amount: number | null;
  receipt_currency: string | null;
  receipt_sent: boolean;
  receipt_sent_at: string | null;
  pending_count: number;
  best_confidence: number | null;
  state: ChargeState;
};

/** A receipt with no statement line at all. */
export type OrphanRow = {
  receipt_id: string;
  receipt_date: string | null;
  vendor_name: string | null;
  ttd_amount: number | null;
  amount: number | null;
  currency: string;
  sent: boolean;
  sent_at: string | null;
  paid: boolean;
  reimbursable: boolean | null;
  payment_method: string;
  /** False when paid by cash/personal card — settled via the reimbursable report. */
  expected_on_statement: boolean;
  pending_count: number;
  possible_duplicate_upload: boolean;
};

export type CloseOutData = {
  /** Charges still needing a receipt — the work list. */
  needsReceipt: ChargeRow[];
  /** Charges with a suggested but unconfirmed receipt. */
  needsConfirmation: ChargeRow[];
  /** Matched but not yet sent to the accountant. */
  readyToSend: ChargeRow[];
  /** Done — matched and sent. */
  alreadySent: ChargeRow[];
  /** Bank fees, interest, payments — real money, nothing to chase. */
  bankCharges: ChargeRow[];
  /** Company-card receipts with no statement line, not yet sent — real work. */
  orphansOpen: OrphanRow[];
  /** Company-card receipts with no statement line, already sent. */
  orphansSent: OrphanRow[];
  /** Cash/personal-card receipts: never on a card statement. Not close-out work. */
  reimbursables: OrphanRow[];
  /** Unmatched receipts available to attach to a charge. */
  attachable: { id: string; vendor_name: string | null; ttd_amount: number | null; receipt_date: string | null }[];
  statements: { id: string; file_name: string; effective_start: string; effective_end: string; txn_count: number }[];
  totals: {
    openCount: number;
    openValue: number;
    closedCount: number;
    totalCount: number;
    spendTotal: number;
    rawLineTotal: number;
    bankChargesValue: number;
    orphanOpenValue: number;
    reimbursableCount: number;
    reimbursableValue: number;
  };
};
