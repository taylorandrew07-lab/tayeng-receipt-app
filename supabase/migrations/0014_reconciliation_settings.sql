-- ============================================================================
-- 0014_reconciliation_settings.sql
--
-- Settings that drive consolidated cross-statement reconciliation, plus a
-- single unambiguous definition of "latest statement".
--
-- PURELY ADDITIVE. Adds columns with defaults, fills NULL statement periods
-- from the statements' own transactions, and creates one view.
-- Nothing is deleted; no existing non-NULL value is overwritten.
-- ============================================================================

alter table user_settings
  -- How many statements the consolidated run covers. 0 = all.
  add column if not exists reconcile_statement_count  int     not null default 4,
  -- Candidate receipts must be no older than N days before a statement's start.
  add column if not exists receipt_window_days_before int     not null default 60,
  -- ...and no newer than N days after its end. Wrong far-gap matches in live
  -- data were receipts dated AFTER the period being pulled backwards.
  add column if not exists receipt_window_days_after  int     not null default 15,
  -- Date tolerance when deciding two statement lines are the same real charge.
  add column if not exists charge_match_days          int     not null default 4,
  -- Off by design: the consolidated run produces suggestions, not confirmations.
  add column if not exists auto_confirm_enabled       boolean not null default false;

comment on column user_settings.receipt_window_days_before is
  'Candidate window only. Receipts already confirmed or already sent are ALWAYS considered regardless of age.';

-- ----------------------------------------------------------------------------
-- Period backfill. Only fills NULLs, using the statement's own transactions.
-- Live data has statements whose period never parsed, which would otherwise
-- make "latest by period" fall back to upload order -- the original bug.
-- ----------------------------------------------------------------------------
update statements s set
  period_start = coalesce(
    s.period_start,
    (select min(t.txn_date) from statement_transactions t where t.statement_id = s.id)),
  period_end = coalesce(
    s.period_end,
    (select max(t.txn_date) from statement_transactions t where t.statement_id = s.id))
where s.period_start is null or s.period_end is null;

-- Defensive: a parse that swapped the two would corrupt every ordering below.
update statements
set period_start = period_end, period_end = period_start
where period_start is not null and period_end is not null and period_start > period_end;

-- ----------------------------------------------------------------------------
-- "Latest" is defined here, ONCE, by real coverage -- never by upload order.
-- security_invoker keeps the caller's RLS in force.
-- ----------------------------------------------------------------------------
create or replace view statement_coverage with (security_invoker = on) as
select
  s.*,
  coalesce(
    s.period_start,
    (select min(t.txn_date) from statement_transactions t where t.statement_id = s.id),
    s.created_at::date
  ) as effective_start,
  coalesce(
    s.period_end,
    (select max(t.txn_date) from statement_transactions t where t.statement_id = s.id),
    s.created_at::date
  ) as effective_end,
  (select count(*) from statement_transactions t where t.statement_id = s.id)::int as txn_count
from statements s;

grant select on statement_coverage to authenticated, service_role;
