-- ============================================================================
-- 0026_statement_balance_check.sql
--
-- The SECOND, independent completeness check -- promised in 0022's header and
-- never built.
--
-- 0022 checks our extracted lines against the statement's printed purchases
-- total. That catches a line we MISSED, but it trusts the printed total we
-- read. This checks the statement against ITSELF, using four figures from its
-- own summary box:
--
--     previous_balance + total_purchases - total_payments == closing_balance
--
-- If that fails, one of the four summary figures was misread -- most often
-- total_purchases, which is exactly the number the line check relies on. So a
-- "lines add up" verdict is only trustworthy when this one passes as well.
--
-- Also exposes, so no reader has to re-derive them:
--   * period_read   -- were the period dates READ from the statement, or
--                      inferred from its transactions? The close-out PDF
--                      claimed "dates inferred" for every statement, always.
--   * currencies    -- every currency its lines are in. More than one means
--                      the lines cannot be summed into a single total, and no
--                      screen may present such a sum as TTD.
--
-- READ-ONLY: rebuilds one view. No table or row is changed. statement_coverage
-- is `select s.*`, so it is dropped and rebuilt rather than replaced (see 0019
-- for why `create or replace` cannot reorder columns). Nothing in the database
-- depends on it.
-- ============================================================================

drop view if exists statement_coverage;

create view statement_coverage with (security_invoker = on) as
with lines as (
  select
    t.statement_id,
    count(*)::int                                  as txn_count,
    coalesce(sum(t.amount), 0)::numeric(14, 2)     as line_total,
    min(t.txn_date)                                as first_date,
    max(t.txn_date)                                as last_date,
    array_agg(distinct upper(coalesce(t.currency, 'TTD'))) as currencies
  from statement_transactions t
  group by t.statement_id
)
select
  s.*,
  coalesce(s.period_start, l.first_date, s.created_at::date) as effective_start,
  coalesce(s.period_end,   l.last_date,  s.created_at::date) as effective_end,
  (s.period_start is not null and s.period_end is not null)  as period_read,
  coalesce(l.txn_count, 0)                                   as txn_count,
  coalesce(l.line_total, 0)::numeric(14, 2)                  as line_total,
  coalesce(l.currencies, array['TTD'])                       as currencies,

  -- CHECK 1 (0022): do our extracted lines add up to the printed purchases?
  -- NULL = the printed total was never read. Unknown is not the same as wrong.
  case when s.total_purchases is null then null
       else abs(coalesce(l.line_total, 0) - s.total_purchases) <= 0.01
  end                                                        as totals_reconciled,
  case when s.total_purchases is null then null
       else (coalesce(l.line_total, 0) - s.total_purchases)::numeric(14, 2)
  end                                                        as totals_difference,

  -- CHECK 2 (0026): is the statement's own summary internally consistent?
  -- NULL unless all four figures were read.
  case when s.previous_balance is null or s.total_purchases is null
         or s.total_payments is null or s.closing_balance is null then null
       else abs(s.previous_balance + s.total_purchases - s.total_payments
                - s.closing_balance) <= 0.01
  end                                                        as balance_consistent,
  case when s.previous_balance is null or s.total_purchases is null
         or s.total_payments is null or s.closing_balance is null then null
       else (s.previous_balance + s.total_purchases - s.total_payments
             - s.closing_balance)::numeric(14, 2)
  end                                                        as balance_difference
from statements s
left join lines l on l.statement_id = s.id;

grant select on statement_coverage to authenticated, service_role;

comment on view statement_coverage is
  'Statements with effective period and two independent completeness checks. totals_reconciled: extracted lines vs the printed purchases total (0022). balance_consistent: previous + purchases - payments = closing, from the statement''s own summary (0026). Each is NULL when a figure it needs was not read -- unknown, not wrong.';
