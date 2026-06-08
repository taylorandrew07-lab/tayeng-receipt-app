-- ============================================================================
-- "Paid" flag for reimbursable receipts. Once a reimbursement has been paid out,
-- mark the receipts paid so they drop off the dashboard's outstanding total.
-- ============================================================================
alter table receipts add column if not exists paid boolean not null default false;
alter table receipts add column if not exists paid_at timestamptz;

create index if not exists receipts_user_paid_idx on receipts (user_id, paid);
