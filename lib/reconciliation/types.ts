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

/** A statement plus its coverage and control-total verdict (0014 + 0022). */
export type StatementCoverageRow = {
  id: string;
  file_name: string;
  effective_start: string;
  effective_end: string;
  /** false = the period was inferred from the transactions, not read. */
  period_read: boolean;
  txn_count: number;
  /** Every currency this statement's lines are in (0026). */
  currencies: string[];
  /** Sum of the transaction amounts currently held for this statement. */
  line_total: number | null;
  previous_balance: number | null;
  /** Total purchases/debits as PRINTED on the statement. The control total. */
  total_purchases: number | null;
  total_payments: number | null;
  closing_balance: number | null;
  credits_excluded: number;
  /**
   * null = the statement's own total was never read, so completeness is
   * UNKNOWN. true = our extracted lines match it to the cent. false = they do
   * not, and a line is missing or wrong.
   */
  totals_reconciled: boolean | null;
  totals_difference: number | null;
  /** previous + purchases - payments == closing (0026). null = not all read. */
  balance_consistent: boolean | null;
  balance_difference: number | null;
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
  /** Bank fees, interest, payments — recognised by the machine, nothing to chase. */
  bankCharges: ChargeRow[];
  /**
   * Real purchases a PERSON decided to close without a receipt. Same
   * no_receipt_expected flag as bankCharges, completely different meaning —
   * internal housekeeping that must never be reported as a bank fee.
   */
  clearedByHand: ChargeRow[];
  /** Company-card receipts with no statement line, not yet sent — real work. */
  orphansOpen: OrphanRow[];
  /** Company-card receipts with no statement line, already sent. */
  orphansSent: OrphanRow[];
  /** Cash/personal-card receipts: never on a card statement. Not close-out work. */
  reimbursables: OrphanRow[];
  /** Unmatched receipts available to attach to a charge. */
  attachable: { id: string; vendor_name: string | null; ttd_amount: number | null; receipt_date: string | null }[];
  statements: StatementCoverageRow[];
  totals: {
    openCount: number;
    openValue: number;
    closedCount: number;
    totalCount: number;
    spendTotal: number;
    rawLineTotal: number;
    bankChargesValue: number;
    clearedByHandValue: number;
    orphanOpenValue: number;
    reimbursableCount: number;
    reimbursableValue: number;
    /** Statements PROVEN complete (lib/reports/completeness). */
    statementsProven: number;
    /** Statements whose checks actively FAILED — not merely unread. */
    statementsFailing: number;
    failingNames: string[];
    /**
     * Charges in a currency other than TTD. Never added into any TTD total;
     * reported here, in their own currency, so they cannot go unseen.
     */
    foreignCharges: { currency: string; count: number; total: number }[];
  };
};
