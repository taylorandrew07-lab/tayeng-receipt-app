-- ============================================================================
-- 0019_orphan_receipts_scope.sql
--
-- orphan_receipts (0017:100-120) listed EVERY receipt with no statement line,
-- which swept in receipts that can never have one.
--
-- Andrew's statements are CREDIT CARD statements. A receipt he paid for with
-- cash or a personal card is a REIMBURSABLE — it is settled through the
-- reimbursable report (app/api/reports/generate/route.ts, scope=outstanding),
-- and by definition never appears on the company card statement. Listing those
-- as "receipts with no statement line" put 20 of 33 items on a close-out list
-- that is supposed to reach zero, and they could never be cleared.
--
-- Live data: 11 cash + 8 personal_card + 1 online, all reimbursable = true.
-- The 66 company_card receipts are the ones genuinely expected on a statement.
--
-- The view now EXPOSES the distinction rather than hiding rows, so the app can
-- show reimbursables separately instead of silently dropping them.
--
-- READ-ONLY: replaces one view definition. No data is touched.
-- ============================================================================

-- NOTE: `create or replace view` can only APPEND columns — it cannot insert one
-- in the middle ("cannot change name of view column ..."). The new columns
-- belong next to the fields they qualify, so the view is dropped and rebuilt.
-- Safe: nothing in the database depends on it, only app queries.
drop view if exists orphan_receipts;

create view orphan_receipts with (security_invoker = on) as
select
  r.id as receipt_id, r.user_id, r.receipt_date, r.vendor_name,
  r.ttd_amount, r.amount, r.currency, r.card_last4,
  r.sent, r.sent_at, r.paid, r.reimbursable, r.category_id, r.notes,
  r.payment_method,
  -- Only a company-card purchase is expected to turn up on a card statement.
  -- 'unknown' is deliberately treated as EXPECTED: a mis-classified receipt
  -- should surface as work rather than vanish into the reimbursable pile.
  (r.payment_method not in ('cash', 'personal_card')
   and coalesce(r.reimbursable, false) = false) as expected_on_statement,
  (select count(*) from receipt_statement_matches m
    where m.receipt_id = r.id and not m.confirmed and m.rejected_at is null)::int as pending_count,
  (count(*) over (partition by r.user_id, lower(coalesce(r.vendor_name, '')),
                               r.ttd_amount, r.receipt_date) > 1) as possible_duplicate_upload
from receipts r
where r.duplicate_of is null
  and r.status = 'confirmed'
  and not exists (
    select 1 from receipt_statement_matches m
    where m.receipt_id = r.id and m.confirmed);

grant select on orphan_receipts to authenticated, service_role;

comment on view orphan_receipts is
  'Receipts with no confirmed statement line. expected_on_statement = false means it was paid by cash or personal card and is settled through the reimbursable report instead — it must not count toward the close-out list.';
