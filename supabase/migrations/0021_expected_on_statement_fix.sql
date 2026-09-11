-- ============================================================================
-- 0021_expected_on_statement_fix.sql
--
-- BUG FIX for orphan_receipts.expected_on_statement (0019:36-39).
--
-- 0019 states the intent plainly:
--   "'unknown' is deliberately treated as EXPECTED: a mis-classified receipt
--    should surface as work rather than vanish into the reimbursable pile."
--
-- The implementation does the opposite. It reads:
--     payment_method not in ('cash','personal_card') AND reimbursable = false
-- but classify.ts:98 derives reimbursable as `payment_method !== 'company_card'`,
-- so an 'unknown' receipt ALWAYS has reimbursable = true and the second half of
-- the AND deletes it from the close-out list. The same applies to 'online' and
-- 'other'.
--
-- Those receipts are then excluded from the pairing board too
-- (reconcile/board/page.tsx builds its right-hand column from orphansOpen /
-- orphansSent only), so there is NO screen in the app on which they can be
-- found and corrected. That is the exact failure mode 0018 calls "the worst
-- failure this system has".
--
-- Live data at the time of writing — 3 receipts silently dropped:
--     Supabase Pte. Ltd.  2026-07-21  TTD 298.79  online
--     Web Source          2026-07-24  TTD 214.60  unknown
--     Supabase Pte. Ltd.  2026-08-21  TTD 306.00  online
--
-- THE FIX: decide from payment_method alone, which is the field that actually
-- carries the meaning. `reimbursable` is a DERIVED convenience column and must
-- not gate visibility.
--
--   expected  : company_card, unknown, online, other
--   reimbursed: cash, personal_card
--
-- 'online' and 'other' join 'unknown' on the expected side for the same stated
-- reason: the app cannot tell which card paid, so it must surface the receipt
-- as work rather than hide it. Only cash and personal_card are things Andrew
-- KNOWS he paid himself.
--
-- READ-ONLY: replaces one view definition. No data is touched.
--
-- EXPECTED EFFECT ON THE LIVE BOARD: none to the open count. All three
-- receipts above are already sent = true, so they move from "reimbursables"
-- to the already-closed orphan side. openCount stays at 0.
-- ============================================================================

drop view if exists orphan_receipts;

create view orphan_receipts with (security_invoker = on) as
select
  r.id as receipt_id, r.user_id, r.receipt_date, r.vendor_name,
  r.ttd_amount, r.amount, r.currency, r.card_last4,
  r.sent, r.sent_at, r.paid, r.reimbursable, r.category_id, r.notes,
  r.payment_method,
  -- Decided by payment_method ALONE. See the header for why `reimbursable`
  -- must not appear in this expression.
  (r.payment_method not in ('cash', 'personal_card')) as expected_on_statement,
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
  'Receipts with no confirmed statement line. expected_on_statement = false means it was paid by cash or a personal card and is settled through the reimbursable report instead. Decided from payment_method alone — never from the derived reimbursable column (see 0021).';
