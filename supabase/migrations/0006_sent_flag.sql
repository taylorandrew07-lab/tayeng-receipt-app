-- ============================================================================
-- "Sent" archive flag: once receipts have been submitted, mark them sent so
-- they're visibly archived and separated from outstanding ones.
-- ============================================================================
alter table receipts add column if not exists sent boolean not null default false;
alter table receipts add column if not exists sent_at timestamptz;

create index if not exists receipts_user_sent_idx on receipts (user_id, sent);
