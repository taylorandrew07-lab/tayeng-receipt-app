-- ============================================================================
-- Let users dismiss a false-positive duplicate. Once marked "not a duplicate",
-- the receipt is never auto-flagged as a duplicate again.
-- ============================================================================
alter table receipts add column if not exists not_duplicate boolean not null default false;
