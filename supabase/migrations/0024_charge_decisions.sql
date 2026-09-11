-- ============================================================================
-- 0024_charge_decisions.sql
--
-- Records WHEN a person closed or reopened a charge, so a human decision is
-- distinguishable from a machine one and is never silently overridden.
--
-- WHY THIS IS NEEDED: `no_receipt_expected` is set two ways -- automatically
-- by is_fee_description() for bank noise, and by hand for a real purchase
-- Andrew decided to close without a receipt. Until now a charge could not be
-- REOPENED from the app at all; the close-out page literally said "tell me and
-- I'll add a one-tap way to put it back".
--
-- Reopening needs a record, because the auto-flag backfill in 0020 re-flags any
-- charge that is `not fee_auto_flagged and not no_receipt_expected` and whose
-- description looks like a fee. A fee Andrew reopened would match that
-- condition exactly, and the next such backfill would close it again behind
-- his back. `reopened_at` is the marker every future backfill must respect.
--
-- PURELY ADDITIVE. Two nullable columns. No existing row is changed: the nine
-- charges closed by hand on 2026-09-09 keep their flags exactly as they are.
-- ============================================================================

alter table charges
  add column if not exists closed_by_user_at timestamptz,
  add column if not exists reopened_at       timestamptz;

comment on column charges.closed_by_user_at is
  'When a person closed this charge as needing no receipt. NULL for machine-flagged fees and for charges closed before 0024.';
comment on column charges.reopened_at is
  'When a person reopened this charge. ANY future auto-flag backfill MUST skip rows where this is not null -- a human decision outranks the fee regex.';
