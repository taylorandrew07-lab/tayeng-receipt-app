-- ============================================================================
-- Bill-back tracking: company-card (or any) expenses that must be charged back
-- to a client or a vessel. Manual, optional, per receipt.
-- ============================================================================
alter table receipts
  add column if not exists bill_back boolean not null default false,
  add column if not exists bill_back_type text
    check (bill_back_type in ('client', 'vessel')),
  add column if not exists bill_back_name text,
  add column if not exists bill_back_normalized text;

-- Group/search bill-backs by the normalized name (e.g. "ABC Ltd" = "abc ltd").
create index if not exists receipts_user_billback_idx
  on receipts (user_id, bill_back_normalized);
