-- ============================================================================
-- 0015_charge_identity.sql
--
-- Cross-statement identity for a real-world charge.
--
-- THE PROBLEM THIS SOLVES: the card provider sends OVERLAPPING statements, so
-- the same charge is re-listed on a later statement as an independent row. The
-- receipt is locked to the first row by rsm_unique_confirmed_receipt (0013) and
-- filtered out of the candidate pool, so the second copy can NEVER be matched
-- and is reported "missing" forever. Live data: 90 statement lines are only 64
-- real charges; 15 lines were falsely reported missing, 12 already sent.
--
-- A charge lives in its own table, not as a column on statement_transactions,
-- so it SURVIVES a statement being deleted or re-parsed -- which is exactly
-- when the "already sent" evidence must not be lost.
--
-- PURELY ADDITIVE. Creates one table, adds one nullable column, backfills it.
-- Reversible with:  update statement_transactions set charge_id = null;
--                   truncate charges cascade;
-- ============================================================================

-- Normalisation must agree with normalizeVendor() in lib/classification/classify.ts.
create or replace function charge_key_of(
  p_description text, p_amount numeric, p_currency text, p_card_last4 text
) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p_description, '')), '[^a-z0-9]+', ' ', 'g'))
      || '|' || round(coalesce(p_amount, 0), 2)::text
      || '|' || upper(coalesce(nullif(btrim(p_currency), ''), 'TTD'))
      || '|' || coalesce(p_card_last4, '');
$$;

-- Charges that can never have a receipt: bank fees, interest, payments.
-- Without this they sit in the work list permanently and train the user to
-- ignore it -- the same failure mode as the phantom-missing bug.
create or replace function is_fee_description(p_description text)
returns boolean language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p_description, '')), '[^a-z0-9]+', ' ', 'g'))
         ~ '(overlimit fee|over limit fee|annual fee|late fee|interest charge|interest|service charge|cash advance fee|fx fee|foreign transaction fee|payment thank you|payment received|payment cr)';
$$;

create table if not exists charges (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  charge_key          text not null,
  anchor_date         date,                      -- earliest txn_date seen for this charge
  description         text,
  amount              numeric(14, 2),
  currency            text not null default 'TTD',
  card_last4          text,
  no_receipt_expected boolean not null default false,
  fee_auto_flagged    boolean not null default false,  -- so a wrong auto-flag stays visible
  created_at          timestamptz not null default now()
);

create index if not exists charges_lookup_idx on charges (user_id, charge_key, anchor_date);
create index if not exists charges_user_date_idx on charges (user_id, anchor_date);

alter table charges enable row level security;

drop policy if exists "charges_all_own" on charges;
create policy "charges_all_own" on charges
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table statement_transactions
  add column if not exists charge_id uuid references charges (id) on delete set null;

create index if not exists statement_txn_charge_idx on statement_transactions (charge_id);
-- Absent in 0001; required for cross-statement date-ordered reads.
create index if not exists statement_txn_user_date_idx
  on statement_transactions (user_id, txn_date, id);

-- ----------------------------------------------------------------------------
-- Assignment. Deliberately favours PRECISION over recall: a wrong merge hides a
-- real charge, whereas a missed merge only leaves today's known behaviour.
--
--   GUARD 1  two rows on the SAME statement never merge -- a genuine repeat
--            purchase (same shop, same amount, same week) is two real charges.
--   GUARD 2  a dated row never merges with an undated one.
--
-- Dates are NOT in the key; they match within charge_match_days (default 4),
-- because a carried-over line can post on a slightly different date.
-- ----------------------------------------------------------------------------
create or replace function assign_charge() returns trigger language plpgsql as $$
declare
  k   text;
  tol int;
  cid uuid;
begin
  k := charge_key_of(new.description, new.amount, new.currency, new.card_last4);

  select s.charge_match_days into tol from user_settings s where s.user_id = new.user_id;
  tol := coalesce(tol, 4);

  select c.id into cid
  from charges c
  where c.user_id = new.user_id
    and c.charge_key = k
    and (
      (new.txn_date is null and c.anchor_date is null)                      -- GUARD 2
      or (new.txn_date is not null and c.anchor_date is not null
          and abs(new.txn_date - c.anchor_date) <= tol)
    )
    and not exists (                                                        -- GUARD 1
      select 1 from statement_transactions t
      where t.charge_id = c.id
        and t.statement_id = new.statement_id
        and t.id <> new.id
    )
  order by c.anchor_date nulls last, c.created_at, c.id
  limit 1;

  if cid is null then
    insert into charges (
      user_id, charge_key, anchor_date, description, amount, currency, card_last4,
      no_receipt_expected, fee_auto_flagged
    )
    values (
      new.user_id, k, new.txn_date, new.description, new.amount,
      upper(coalesce(nullif(btrim(new.currency), ''), 'TTD')), new.card_last4,
      is_fee_description(new.description), is_fee_description(new.description)
    )
    returning id into cid;
  elsif new.txn_date is not null then
    update charges set anchor_date = least(anchor_date, new.txn_date) where id = cid;
  end if;

  new.charge_id := cid;
  return new;
end $$;

drop trigger if exists statement_txn_assign_charge on statement_transactions;
create trigger statement_txn_assign_charge
  before insert on statement_transactions
  for each row when (new.charge_id is null)
  execute function assign_charge();

-- ----------------------------------------------------------------------------
-- BACKFILL. Replays the same logic in oldest-first order so the EARLIEST
-- statement anchors each charge. A BEFORE INSERT trigger cannot do this, so the
-- logic is repeated here deliberately. Re-runnable: only touches NULL charge_id.
-- ----------------------------------------------------------------------------
do $$
declare
  r   record;
  k   text;
  tol int;
  cid uuid;
begin
  for r in
    select t.* from statement_transactions t
    where t.charge_id is null
    order by t.txn_date asc nulls last, t.created_at asc, t.id asc
  loop
    k := charge_key_of(r.description, r.amount, r.currency, r.card_last4);

    select s.charge_match_days into tol from user_settings s where s.user_id = r.user_id;
    tol := coalesce(tol, 4);

    select c.id into cid
    from charges c
    where c.user_id = r.user_id
      and c.charge_key = k
      and (
        (r.txn_date is null and c.anchor_date is null)
        or (r.txn_date is not null and c.anchor_date is not null
            and abs(r.txn_date - c.anchor_date) <= tol)
      )
      and not exists (
        select 1 from statement_transactions t2
        where t2.charge_id = c.id
          and t2.statement_id = r.statement_id
          and t2.id <> r.id
      )
    order by c.anchor_date nulls last, c.created_at, c.id
    limit 1;

    if cid is null then
      insert into charges (
        user_id, charge_key, anchor_date, description, amount, currency, card_last4,
        no_receipt_expected, fee_auto_flagged
      )
      values (
        r.user_id, k, r.txn_date, r.description, r.amount,
        upper(coalesce(nullif(btrim(r.currency), ''), 'TTD')), r.card_last4,
        is_fee_description(r.description), is_fee_description(r.description)
      )
      returning id into cid;
    elsif r.txn_date is not null then
      update charges set anchor_date = least(anchor_date, r.txn_date) where id = cid;
    end if;

    update statement_transactions set charge_id = cid where id = r.id;
  end loop;
end $$;
