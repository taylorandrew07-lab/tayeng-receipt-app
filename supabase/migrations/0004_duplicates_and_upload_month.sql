-- ============================================================================
-- Duplicate tracking + upload-based monthly workspace.
-- ============================================================================

-- A receipt detected as a duplicate of another one points to the original.
alter table receipts
  add column if not exists duplicate_of uuid references receipts (id) on delete set null;

create index if not exists receipts_duplicate_of_idx on receipts (duplicate_of);

-- The monthly workspace is organised by WHEN THE DOCUMENT WAS UPLOADED, not the
-- date printed on the receipt. Re-bucket existing rows to their upload month.
update receipts
set month_key = to_char(created_at, 'YYYY-MM')
where month_key is distinct from to_char(created_at, 'YYYY-MM');
