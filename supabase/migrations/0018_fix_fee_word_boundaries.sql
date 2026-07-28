-- ============================================================================
-- 0018_fix_fee_word_boundaries.sql
--
-- BUG FIX for is_fee_description() introduced in 0015_charge_identity.sql:38.
--
-- The alternation contained a bare, unanchored `interest`, so ANY description
-- merely CONTAINING that substring matched -- "PINTEREST" being the realistic
-- case. A matching charge is created with no_receipt_expected = true
-- (0015:120), which removes it from the list of things to chase. Silently
-- dropping a real chaseable charge is the worst failure this system has, so
-- every term is now matched on whole-token boundaries.
--
-- Descriptions are normalised to lowercase alphanumeric tokens separated by
-- single spaces first, so `(^| )term( |$)` is an exact token-sequence match.
-- Plurals still work: "INTEREST CHARGES" -> "interest charges" matches the
-- `interest` term as a whole token.
--
-- ADDITIVE + a corrective re-evaluation of AUTO-flagged charges only. A flag
-- the user set by hand (fee_auto_flagged = false) is never touched.
-- ============================================================================

create or replace function is_fee_description(p_description text)
returns boolean language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p_description, '')), '[^a-z0-9]+', ' ', 'g'))
         ~ ('(^| )('
            || 'overlimit fee|over limit fee|annual fee|late fee'
            || '|interest charge|interest'
            || '|service charge|cash advance fee'
            || '|fx fee|foreign transaction fee'
            || '|payment thank you|payment received|payment cr'
            || ')( |$)');
$$;

-- Re-evaluate only machine-set flags. The stricter regex can only ever UNSET,
-- never set, so this cannot hide anything new.
do $$
declare unflagged int;
begin
  with fixed as (
    update charges c
    set no_receipt_expected = false,
        fee_auto_flagged    = false
    where c.fee_auto_flagged
      and not is_fee_description(c.description)
    returning 1
  )
  select count(*) into unflagged from fixed;

  raise notice '0018: % charge(s) were wrongly auto-flagged as fees and are back on the list', unflagged;
end $$;
