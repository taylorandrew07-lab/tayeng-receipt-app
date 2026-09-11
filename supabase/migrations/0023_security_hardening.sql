-- ============================================================================
-- 0023_security_hardening.sql
--
-- Four row-level security defects, each reproduced by a failing test in
-- supabase/tests/security.test.ts against a real Postgres before this was
-- written. ADDITIVE: no data is changed or deleted, no applied migration is
-- edited, and every section is safe to re-run.
--
-- MIGRATION DEFECT vs PRODUCTION EXPOSURE -- these are different and are
-- labelled separately below. Production was inspected read-only on 2026-09-11.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. rsm_backup_pre_0016 -- a table with no RLS.
--
-- 0016 created it with CREATE TABLE AS and never enabled row level security.
-- Supabase's default privileges grant anon and authenticated SELECT on every
-- new public table, so on any database built from these migrations the anon
-- key -- shipped in every browser -- reads every user's match history.
--
-- MIGRATION DEFECT: yes, reproduced on a fresh install.
-- PRODUCTION EXPOSURE: NO. Inspected with the anon key: 0 rows visible, while
-- the service role sees 62. RLS had already been enabled there out-of-band, so
-- in production this section is a no-op.
--
-- The backup is KEPT. It remains readable by the service role only, which is
-- all a backup needs. Drop it only after a full close-out cycle, as 0016 says.
-- ----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.rsm_backup_pre_0016') is not null then
    alter table public.rsm_backup_pre_0016 enable row level security;
    revoke all on public.rsm_backup_pre_0016 from anon, authenticated;
    comment on table public.rsm_backup_pre_0016 is
      'Undo snapshot taken by 0016. Service role only (RLS on, no policies, anon/authenticated revoked by 0023). Drop after a full close-out cycle.';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 2. charges -- the one data table that skipped the approval gate.
--
-- 0008 added `and public.is_approved()` to every user-data policy. 0015 created
-- charges later with only `auth.uid() = user_id`, so an account an admin had
-- NOT approved could read and write charges directly through the API.
--
-- MIGRATION DEFECT: yes. PRODUCTION EXPOSURE: requires a signed-up but
-- unapproved account to exist and to call the API by hand. There is no screen
-- that does it. Closed either way.
-- ----------------------------------------------------------------------------
alter policy "charges_all_own" on charges
  using      (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());


-- ----------------------------------------------------------------------------
-- 3. Ownership across related rows.
--
-- Every policy checks that the NEW row's user_id is the caller. None checked
-- that the rows it POINTS AT belong to the same user. So a user could insert a
-- match whose receipt_id is someone else's receipt, a statement line on
-- someone else's statement, a file row on someone else's receipt.
--
-- That is not merely untidy. The confirmed-match unique indexes
-- (rsm_unique_confirmed_receipt, 0013; rsm_unique_confirmed_charge, 0016) are
-- GLOBAL, not per user -- so one user holding a confirmed match on another
-- user's receipt permanently prevents the real owner from ever confirming it.
-- UUIDs are hard to guess, but ownership must not rest on secrecy.
--
-- Enforced with a trigger rather than composite foreign keys: several of these
-- references are ON DELETE SET NULL, and a composite FK would null user_id as
-- well (NOT NULL), unless PG15+'s column-list syntax is relied upon.
--
-- SECURITY DEFINER so the check can see the referenced row even when RLS hides
-- it from the caller -- which is exactly the case being caught. A trigger
-- function cannot be invoked as an RPC, so this exposes nothing.
-- ----------------------------------------------------------------------------
create or replace function public.enforce_same_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  i         int := 0;
  col       text;
  ref_table text;
  ref_id    uuid;
  ref_owner uuid;
begin
  -- Arguments come in (column, referenced_table) pairs, fixed in this file.
  while i < tg_nargs loop
    col       := tg_argv[i];
    ref_table := tg_argv[i + 1];
    ref_id    := (to_jsonb(new) ->> col)::uuid;

    if ref_id is not null then
      execute format('select user_id from public.%I where id = $1', ref_table)
        into ref_owner using ref_id;
      -- A missing row is left for the foreign key to report in its own words.
      if ref_owner is not null and ref_owner <> new.user_id then
        raise exception 'permission denied: %.% refers to a % row owned by another user',
          tg_table_name, col, ref_table
          using errcode = '42501';
      end if;
    end if;

    i := i + 2;
  end loop;
  return new;
end $$;

-- Named zz_* so it fires AFTER the existing BEFORE triggers (Postgres fires
-- them alphabetically) -- in particular after rsm_sync_charge and
-- statement_txn_assign_charge have filled in charge_id, so the derived value is
-- checked too, not just what the caller sent.
drop trigger if exists zz_same_owner on receipts;
create trigger zz_same_owner before insert or update on receipts
  for each row execute function public.enforce_same_owner(
    'card_id', 'cards', 'category_id', 'categories',
    'vendor_id', 'vendors', 'duplicate_of', 'receipts');

drop trigger if exists zz_same_owner on receipt_files;
create trigger zz_same_owner before insert or update on receipt_files
  for each row execute function public.enforce_same_owner('receipt_id', 'receipts');

drop trigger if exists zz_same_owner on statements;
create trigger zz_same_owner before insert or update on statements
  for each row execute function public.enforce_same_owner('card_id', 'cards');

drop trigger if exists zz_same_owner on statement_transactions;
create trigger zz_same_owner before insert or update on statement_transactions
  for each row execute function public.enforce_same_owner(
    'statement_id', 'statements', 'charge_id', 'charges');

drop trigger if exists zz_same_owner on receipt_statement_matches;
create trigger zz_same_owner before insert or update on receipt_statement_matches
  for each row execute function public.enforce_same_owner(
    'receipt_id', 'receipts',
    'statement_transaction_id', 'statement_transactions',
    'charge_id', 'charges');

drop trigger if exists zz_same_owner on vendors;
create trigger zz_same_owner before insert or update on vendors
  for each row execute function public.enforce_same_owner('default_category_id', 'categories');

-- PRODUCTION INSPECTION. Triggers only guard FUTURE writes, so report -- do
-- not silently repair -- any existing row that already crosses owners.
-- Inspected read-only on 2026-09-11 across BOTH production accounts: 0 such
-- rows in every one of these five relationships. Any non-zero count here is a
-- finding for a person to look at, never something to rewrite automatically.
do $$
declare n int;
begin
  select
      (select count(*) from receipt_statement_matches m join receipts r on r.id = m.receipt_id
        where r.user_id <> m.user_id)
    + (select count(*) from receipt_statement_matches m join statement_transactions t
        on t.id = m.statement_transaction_id where t.user_id <> m.user_id)
    + (select count(*) from receipt_statement_matches m join charges c on c.id = m.charge_id
        where c.user_id <> m.user_id)
    + (select count(*) from statement_transactions t join statements s on s.id = t.statement_id
        where s.user_id <> t.user_id)
    + (select count(*) from receipt_files f join receipts r on r.id = f.receipt_id
        where r.user_id <> f.user_id)
  into n;
  if n > 0 then
    raise warning '0023: % existing row(s) reference data owned by another user -- INSPECT, do not ignore', n;
  else
    raise notice '0023: no existing cross-owner rows found';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 4. The admin hierarchy, enforced where it actually matters.
--
-- The documented rule, in two places:
--   lib/admin/actions.ts:47  "Only super_admins may change roles, and never
--                             their own / a super_admin's."
--   0012 header              "Only a super_admin can manage other admins."
-- But 0012's policy let a plain admin set ANY non-super user's role to 'user'
-- or 'admin'. The app refuses; the database did not. A plain admin calling the
-- API directly with their own session could promote anyone, and demote or
-- un-approve their peers.
--
-- The policy now says exactly what the app says:
--   super_admin  may edit any NON-super profile but their own, and may set a
--                role of 'user' or 'admin' -- never 'super_admin'.
--   plain admin  may edit PLAIN USERS only (approve them, fix their details),
--                and may not change anyone's role.
-- Granting super_admin is no longer possible through the API at all. It is a
-- database-level act, as the founding promotion in 0012 was.
--
-- MIGRATION DEFECT: yes. PRODUCTION EXPOSURE: LATENT. Inspected read-only on
-- 2026-09-11: production has two accounts -- the super_admin and one approved
-- PLAIN admin. Under 0012 that admin could never touch the super_admin, but
-- could promote any future sign-up to admin, or demote/un-approve any other
-- admin, by calling the API directly. No such change has been made (no other
-- accounts exist), so nothing needs repairing -- only preventing.
-- ----------------------------------------------------------------------------
alter policy "profiles_update_admin" on profiles
  using (
    id <> auth.uid()
    and (
      (public.is_super_admin() and role <> 'super_admin')
      or (public.is_admin() and not public.is_super_admin() and role = 'user')
    )
  )
  with check (
    id <> auth.uid()
    and (
      (public.is_super_admin() and role in ('user', 'admin'))
      or (public.is_admin() and not public.is_super_admin() and role = 'user')
    )
  );
