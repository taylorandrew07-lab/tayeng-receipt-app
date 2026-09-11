-- ============================================================================
-- 0027_receipt_content_hash.sql
--
-- Duplicate detection by what a document CONTAINS, not what it is CALLED.
--
-- THE DEFECT: lib/receipts/duplicates.ts treated two receipts as the same if
-- they merely shared a FILE NAME. Phones and suppliers reuse names endlessly --
-- "IMG_0001.jpg", "invoice.pdf", "receipt.pdf" -- so a genuine, different
-- receipt was flagged duplicate_of an unrelated one. A flagged duplicate is
-- left out of every report and out of the close-out list, so a real receipt
-- disappeared because of its name.
--
-- The fix: a SHA-256 of the file's bytes, computed server-side when the
-- receipt is read (app/api/receipts/extract). Identical bytes are the same
-- document whatever they are called; different bytes are never flagged by the
-- file alone.
--
-- PURELY ADDITIVE. One nullable column and an index. Existing rows keep NULL
-- and are simply not compared by content until re-read -- they still match on
-- vendor + amount + date and on amount + card + date, as before. NOTHING is
-- backfilled here and no existing duplicate flag is changed: historical
-- decisions stand.
-- ============================================================================

alter table receipt_files
  add column if not exists content_sha256 text
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

create index if not exists receipt_files_user_hash_idx
  on receipt_files (user_id, content_sha256)
  where content_sha256 is not null;

comment on column receipt_files.content_sha256 is
  'SHA-256 (hex) of the stored file bytes, set when the receipt is read. Duplicate detection compares this, never the file name (0027).';
