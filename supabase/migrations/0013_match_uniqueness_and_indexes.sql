-- ============================================================================
-- Integrity + performance indexes.
-- ============================================================================

-- A receipt must be confirmed against at most ONE statement transaction.
-- Defensively collapse any existing duplicates (keep the earliest) first.
delete from receipt_statement_matches a
using receipt_statement_matches b
where a.confirmed
  and b.confirmed
  and a.receipt_id = b.receipt_id
  and a.id > b.id;

create unique index if not exists rsm_unique_confirmed_receipt
  on receipt_statement_matches (receipt_id)
  where confirmed;

-- Hot filter: confirmed matches per user (dashboard, matching, reconciliation).
create index if not exists rsm_user_confirmed_idx
  on receipt_statement_matches (user_id, confirmed)
  where confirmed;

-- Supports amount/date duplicate-detection lookups.
create index if not exists receipts_user_date_ttd_idx
  on receipts (user_id, receipt_date, ttd_amount);
