-- ============================================================================
-- 0020_late_payment_fee.sql
--
-- GAPS FOUND IN LIVE DATA (statements "andrew 5.pdf" and "andrew statement
-- 5.pdf", 14 Jul - 17 Aug 2026).
--
-- Those statements carry four bank charges:
--     OVERLIMIT FEE            45.00   -> caught by is_fee_description
--     LATE PAYMENT FEE         50.00   -> NOT caught
--     PURCHASE FINANCE CHARGE  13.87   -> NOT caught
--
-- 0018 word-bounds every term, and the terms are `late fee` and `interest
-- charge`. "LATE PAYMENT FEE" normalises to `late payment fee` and
-- "PURCHASE FINANCE CHARGE" to `purchase finance charge`; neither contains an
-- existing term as a whole token sequence. So each charge is created with
-- no_receipt_expected = false and lands in the close-out work list as a
-- receipt Andrew must go and find -- for a bank charge that can never have one.
--
-- Terms added are unambiguous bank noise only. Every one stays word-bounded,
-- per 0018's rule: widening this regex can HIDE a real chaseable charge, which
-- is the worst failure this system has. In particular `finance charge` is
-- bounded rather than a bare `finance`, which would swallow a real invoice
-- from any company with "Finance" in its name.
--
-- ADDITIVE + a re-flag pass restricted to charges no human has touched.
-- ============================================================================

create or replace function is_fee_description(p_description text)
returns boolean language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p_description, '')), '[^a-z0-9]+', ' ', 'g'))
         ~ ('(^| )('
            || 'overlimit fee|over limit fee|annual fee|late fee'
            || '|late payment fee|late payment charge'
            || '|overdraft fee|returned payment fee|nsf fee'
            || '|interest charge|interest'
            || '|purchase finance charge|finance charge'
            || '|service charge|cash advance fee'
            || '|fx fee|foreign transaction fee'
            || '|payment thank you|payment received|payment cr'
            || ')( |$)');
$$;

-- ----------------------------------------------------------------------------
-- Unlike 0018 (which could only ever UNSET), widening can SET the flag, so the
-- backfill is narrow on purpose:
--   * only charges the machine has never flagged (fee_auto_flagged = false)
--     AND that are not currently marked no-receipt-expected -- so a decision a
--     person made by hand is never overwritten;
--   * only charges with NO confirmed receipt. If a receipt was already found
--     and sent for a line, that line is settled work and must not be silently
--     reclassified as "no receipt needed".
-- Reversible: update charges set no_receipt_expected = false,
--             fee_auto_flagged = false where id in (<ids raised below>);
-- ----------------------------------------------------------------------------
do $$
declare flagged int;
begin
  with newly as (
    update charges c
    set no_receipt_expected = true,
        fee_auto_flagged    = true
    where not c.fee_auto_flagged
      and not c.no_receipt_expected
      and is_fee_description(c.description)
      and not exists (
        select 1 from receipt_statement_matches m
        where m.charge_id = c.id and m.confirmed)
    returning c.id, c.description, c.amount
  )
  select count(*) into flagged from newly;

  raise notice '0020: % charge(s) newly recognised as bank charges and taken off the chase list', flagged;
end $$;
