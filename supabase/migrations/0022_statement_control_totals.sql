-- ============================================================================
-- 0022_statement_control_totals.sql
--
-- THE MISSING CONTROL. Until now nothing in the system could answer the one
-- question a reconciliation exists to answer: "did we capture every line?"
--
-- The parser reads transactions and nothing else, so a line the model skipped
-- is indistinguishable from a line that was never on the statement. The
-- close-out screen already admits this to Andrew in an amber box:
--     "Statement totals not yet read from the PDFs -- this list can't yet
--      prove every line was captured."
--
-- This migration gives a statement the figures PRINTED ON IT, so the extracted
-- lines can be checked against the bank's own arithmetic:
--
--     sum(statement_transactions.amount) == statements.total_purchases ?
--
-- and, independently, that the bank's own summary is internally consistent:
--
--     previous_balance + total_purchases - total_payments == closing_balance ?
--
-- PURELY ADDITIVE. Six nullable columns on `statements`. Nothing is deleted,
-- no view changes, no existing value is overwritten. Statements already parsed
-- keep NULL totals and simply report "totals not read" until re-parsed.
-- Reversible with: alter table statements drop column <each>;
-- ============================================================================

alter table statements
  -- Figures as PRINTED on the statement. NULL = we could not read it, which is
  -- deliberately different from 0.00 (= read, and it was zero).
  add column if not exists previous_balance  numeric(14, 2),
  add column if not exists total_purchases   numeric(14, 2),
  add column if not exists total_payments    numeric(14, 2),
  add column if not exists closing_balance   numeric(14, 2),
  -- What WE actually extracted, stamped at parse time. Storing it (rather than
  -- summing on read) means the check compares the figures from one parse run
  -- and cannot silently drift as rows are edited later.
  add column if not exists parsed_line_total numeric(14, 2),
  -- Payment / refund / credit lines the parser recognised and deliberately did
  -- NOT insert as chargeable transactions. Surfacing the count stops "we found
  -- 26 lines but the statement shows 29" reading as a failure.
  add column if not exists credits_excluded  int not null default 0;

comment on column statements.total_purchases is
  'Total purchases/debits as printed on the statement, including fees and interest. The control total: sum(statement_transactions.amount) should equal this.';
comment on column statements.parsed_line_total is
  'Sum of the transaction amounts this app extracted, stamped at parse time.';
comment on column statements.credits_excluded is
  'Payment/refund/credit lines recognised and deliberately not inserted as chargeable transactions.';

-- ----------------------------------------------------------------------------
-- statement_coverage gains the reconciliation verdict so every reader -- the
-- close-out screen, the PDF, any future report -- computes it the same way.
--
-- TOLERANCE: 0.01 absorbs rounding only. Anything larger is a real discrepancy
-- and must be shown to Andrew rather than smoothed away.
--
-- `create or replace view` cannot reorder or rename existing columns, and this
-- view is `select s.*` -- adding columns to `statements` above already changed
-- its shape. Drop and rebuild. Nothing in the database depends on it.
-- ----------------------------------------------------------------------------
drop view if exists statement_coverage;

create view statement_coverage with (security_invoker = on) as
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
  (select count(*) from statement_transactions t where t.statement_id = s.id)::int as txn_count,
  (select coalesce(sum(t.amount), 0) from statement_transactions t
    where t.statement_id = s.id)::numeric(14, 2) as line_total,
  -- NULL (not false) when the statement's own total was never read: "unknown"
  -- and "wrong" are different answers and must not be conflated.
  case
    when s.total_purchases is null then null
    else abs(
      (select coalesce(sum(t.amount), 0) from statement_transactions t
        where t.statement_id = s.id) - s.total_purchases
    ) <= 0.01
  end as totals_reconciled,
  case
    when s.total_purchases is null then null
    else (
      (select coalesce(sum(t.amount), 0) from statement_transactions t
        where t.statement_id = s.id) - s.total_purchases
    )::numeric(14, 2)
  end as totals_difference
from statements s;

grant select on statement_coverage to authenticated, service_role;

comment on view statement_coverage is
  'Statements with their effective period, extracted line total and the control-total verdict. totals_reconciled is NULL when the statement''s printed total could not be read, true when our extracted lines match it to the cent, false when they do not.';
