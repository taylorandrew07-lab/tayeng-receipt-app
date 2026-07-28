-- ============================================================================
-- 0017_reconciliation_views.sql
--
-- The reconciliation read model. Three views, all security_invoker so RLS
-- still applies and PostgREST can read them exactly like tables.
--
-- READ-ONLY. Creates no tables, changes no data.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- charge_reconciliation -- one row per REAL-WORLD CHARGE, with its state.
--
-- A charge carried on three statements is ONE row here, counted ONCE in any
-- sum, listing every statement it appeared on. This is what fixes the inflated
-- totals (live data: 42,920.49 raw vs 30,583.05 real).
-- ----------------------------------------------------------------------------
create or replace view charge_reconciliation with (security_invoker = on) as
with tx as (
  select t.id, t.charge_id, t.user_id, t.statement_id, t.txn_date, t.description,
         t.amount, t.currency, t.card_last4, t.created_at, s.file_name
  from statement_transactions t
  join statements s on s.id = t.statement_id
  where t.charge_id is not null
),
agg as (
  select
    c.id      as charge_id,
    c.user_id,
    c.no_receipt_expected,
    c.fee_auto_flagged,
    min(t.txn_date) as txn_date,                    -- earliest real date = sort key
    (array_agg(t.description order by t.txn_date nulls last, t.created_at, t.id))[1] as description,
    (array_agg(t.amount      order by t.txn_date nulls last, t.created_at, t.id))[1] as amount,
    (array_agg(t.currency    order by t.txn_date nulls last, t.created_at, t.id))[1] as currency,
    (array_agg(t.card_last4  order by t.txn_date nulls last, t.created_at, t.id))[1] as card_last4,
    (array_agg(t.id          order by t.txn_date nulls last, t.created_at, t.id))[1] as canonical_txn_id,
    array_agg(distinct t.statement_id) as statement_ids,
    array_agg(distinct t.file_name)    as statement_names,
    count(*)::int as copies
  from charges c
  join tx t on t.charge_id = c.id
  group by c.id, c.user_id, c.no_receipt_expected, c.fee_auto_flagged
),
cm as (   -- at most one row per charge: rsm_unique_confirmed_charge guarantees it
  select m.charge_id, m.id as match_id, m.receipt_id, m.confidence,
         r.vendor_name, r.receipt_date, r.ttd_amount, r.amount as receipt_original_amount,
         r.currency as receipt_currency, r.sent, r.sent_at, r.paid
  from receipt_statement_matches m
  join receipts r on r.id = m.receipt_id
  where m.confirmed
),
pm as (
  select m.charge_id, count(*)::int as pending_count, max(m.confidence) as best_confidence
  from receipt_statement_matches m
  where not m.confirmed and m.rejected_at is null and m.charge_id is not null
  group by m.charge_id
)
select
  a.charge_id, a.user_id, a.txn_date, a.description, a.amount, a.currency, a.card_last4,
  a.canonical_txn_id, a.statement_ids, a.statement_names, a.copies,
  (a.copies > 1) as is_duplicate,
  a.no_receipt_expected, a.fee_auto_flagged,
  cm.match_id, cm.receipt_id,
  cm.vendor_name             as receipt_vendor,
  cm.receipt_date            as receipt_date,
  cm.ttd_amount              as receipt_amount,
  cm.receipt_original_amount as receipt_original_amount,
  cm.receipt_currency        as receipt_currency,
  coalesce(cm.sent, false)   as receipt_sent,
  cm.sent_at                 as receipt_sent_at,
  coalesce(pm.pending_count, 0) as pending_count,
  pm.best_confidence,
  case
    when a.no_receipt_expected                 then 'no_receipt_expected'
    when cm.receipt_id is not null and cm.sent then 'already_sent'
    when cm.receipt_id is not null             then 'already_matched'
    when coalesce(pm.pending_count, 0) > 0     then 'needs_confirmation'
    else                                            'genuinely_new'
  end as state
from agg a
left join cm on cm.charge_id = a.charge_id
left join pm on pm.charge_id = a.charge_id;

grant select on charge_reconciliation to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- orphan_receipts -- receipts with NO statement line.
--
-- "If I put in a receipt that you're not seeing on this statement, that also
--  needs to be added to the reconciliation and noted, so I don't have to send
--  it later -- they can just deal with it."
--
-- These can never appear in charge_reconciliation, which is built from
-- statement lines. Live data: 39 of 81 receipts, 24 unsent, TTD 10,772.75.
-- ----------------------------------------------------------------------------
create or replace view orphan_receipts with (security_invoker = on) as
select
  r.id as receipt_id, r.user_id, r.receipt_date, r.vendor_name,
  r.ttd_amount, r.amount, r.currency, r.card_last4,
  r.sent, r.sent_at, r.paid, r.reimbursable, r.category_id, r.notes,
  (select count(*) from receipt_statement_matches m
    where m.receipt_id = r.id and not m.confirmed and m.rejected_at is null)::int as pending_count,
  -- Two or more identical uploads on the same day: likely a duplicate upload.
  (count(*) over (partition by r.user_id, lower(coalesce(r.vendor_name, '')),
                               r.ttd_amount, r.receipt_date) > 1) as possible_duplicate_upload
from receipts r
where r.duplicate_of is null
  and r.status = 'confirmed'
  and not exists (
    select 1 from receipt_statement_matches m
    where m.receipt_id = r.id and m.confirmed);

grant select on orphan_receipts to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- reconciliation_months -- populates the month picker.
--
-- Counts LINES, not deduplicated charges: for labels and rough counts only.
-- Totals must always come from charge_reconciliation.
--
-- NOTE: months here are the REAL date on the document. This is deliberately
-- NOT receipts.month_key, which migration 0004 re-buckets to the UPLOAD month
-- -- all four statements were uploaded on one day, so month_key would file
-- every May charge under July.
-- ----------------------------------------------------------------------------
create or replace view reconciliation_months with (security_invoker = on) as
select user_id, month, sum(charges)::int as charges, sum(orphans)::int as orphans
from (
  select t.user_id, to_char(t.txn_date, 'YYYY-MM') as month, count(*) as charges, 0 as orphans
  from statement_transactions t
  where t.txn_date is not null
  group by 1, 2
  union all
  select r.user_id, to_char(r.receipt_date, 'YYYY-MM'), 0, count(*)
  from receipts r
  where r.receipt_date is not null
    and r.duplicate_of is null
    and r.status = 'confirmed'
    and not exists (
      select 1 from receipt_statement_matches m
      where m.receipt_id = r.id and m.confirmed)
  group by 1, 2
) x
group by user_id, month;

grant select on reconciliation_months to authenticated, service_role;
