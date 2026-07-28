-- ============================================================================
-- 0016_match_durability.sql
--
-- Moves a match's anchor from a per-statement row to the CHARGE, so a receipt
-- satisfies a real-world charge rather than one statement's copy of it. Also
-- makes matches survive statement deletion and makes is_matched derived.
--
-- *** THIS IS THE ONLY MIGRATION THAT CAN CHANGE EXISTING DATA. ***
-- It takes a full backup first (rsm_backup_pre_0016) and it DEMOTES rather
-- than deletes. Read the DEMOTION section before applying.
-- ============================================================================

-- Undo snapshot. Keep until a full cycle has been used, then drop.
create table if not exists rsm_backup_pre_0016 as
  select * from receipt_statement_matches;

alter table receipt_statement_matches
  add column if not exists charge_id         uuid references charges (id) on delete cascade,
  add column if not exists rejected_at       timestamptz,
  -- Provenance snapshot: survives the statement being deleted or re-parsed.
  add column if not exists snap_statement_id uuid,
  add column if not exists snap_txn_date     date,
  add column if not exists snap_amount       numeric(14, 2),
  add column if not exists snap_description  text;

comment on column receipt_statement_matches.rejected_at is
  'Set by rejectMatch instead of deleting, so a rejected pairing is never resurrected by a later run.';

-- statement_transaction_id becomes non-authoritative provenance: deleting a
-- statement must no longer cascade away the evidence that a receipt was found.
alter table receipt_statement_matches
  drop constraint if exists receipt_statement_matches_statement_transaction_id_fkey;
alter table receipt_statement_matches
  add constraint receipt_statement_matches_statement_transaction_id_fkey
  foreign key (statement_transaction_id)
  references statement_transactions (id) on delete set null;

-- Backfill charge_id + snapshot from the linked transaction. Additive.
update receipt_statement_matches m
set charge_id         = t.charge_id,
    snap_statement_id = t.statement_id,
    snap_txn_date     = t.txn_date,
    snap_amount       = t.amount,
    snap_description  = t.description
from statement_transactions t
where t.id = m.statement_transaction_id
  and m.charge_id is null;

create index if not exists rsm_charge_idx on receipt_statement_matches (charge_id);

-- Keep charge_id + snapshot fresh on every write.
create or replace function sync_match_charge() returns trigger language plpgsql as $$
begin
  if new.statement_transaction_id is not null then
    select t.charge_id, t.statement_id, t.txn_date, t.amount, t.description
      into new.charge_id, new.snap_statement_id, new.snap_txn_date,
           new.snap_amount, new.snap_description
    from statement_transactions t
    where t.id = new.statement_transaction_id;
  end if;
  return new;
end $$;

drop trigger if exists rsm_sync_charge on receipt_statement_matches;
create trigger rsm_sync_charge
  before insert or update of statement_transaction_id
  on receipt_statement_matches
  for each row execute function sync_match_charge();

-- ----------------------------------------------------------------------------
-- is_matched becomes DERIVED. It currently drifts three ways: set on a failed
-- confirm, never cleared when a receipt is deleted, never cleared on unmatch.
-- ----------------------------------------------------------------------------
create or replace function sync_txn_is_matched() returns trigger language plpgsql as $$
declare tid uuid;
begin
  foreach tid in array array_remove(array[
      case when tg_op <> 'INSERT' then old.statement_transaction_id end,
      case when tg_op <> 'DELETE' then new.statement_transaction_id end], null)
  loop
    update statement_transactions t
    set is_matched = exists (
      select 1 from receipt_statement_matches m
      where m.statement_transaction_id = t.id and m.confirmed)
    where t.id = tid;
  end loop;
  return null;
end $$;

drop trigger if exists rsm_sync_is_matched on receipt_statement_matches;
create trigger rsm_sync_is_matched
  after insert or update or delete on receipt_statement_matches
  for each row execute function sync_txn_is_matched();

-- One-time correction of already-drifted values.
update statement_transactions t
set is_matched = exists (
  select 1 from receipt_statement_matches m
  where m.statement_transaction_id = t.id and m.confirmed)
where t.is_matched <> exists (
  select 1 from receipt_statement_matches m
  where m.statement_transaction_id = t.id and m.confirmed);

-- ----------------------------------------------------------------------------
-- CLEANUP 1 -- duplicate (receipt, charge) suggestion rows.
-- Deletes only UNCONFIRMED rows. Pre-flight found 0 of these in live data.
-- ----------------------------------------------------------------------------
delete from receipt_statement_matches a
using receipt_statement_matches b
where a.receipt_id = b.receipt_id
  and a.charge_id = b.charge_id
  and a.charge_id is not null
  and a.id > b.id
  and not a.confirmed;

-- ----------------------------------------------------------------------------
-- CLEANUP 2 -- DEMOTION.  *** THIS CHANGES EXISTING DATA ***
--
-- Some charges have two DIFFERENT receipts confirmed against them, because the
-- same charge appeared on two statements and each copy was matched separately.
-- Live data has 4 such charges, and in every case one receipt is exactly right
-- and the other is wrong (e.g. charge 199.94 held both a 199.94 receipt 2 days
-- away and a 194.60 receipt 41 days away).
--
-- The BEST receipt is kept confirmed, ranked by:
--     1. closest amount   2. closest date   3. highest confidence   4. oldest
-- The rest are DEMOTED to suggestions -- nothing is deleted, nothing is
-- re-pointed, and receipts.sent is never touched. They reappear under
-- "Needs your confirmation" for the user to re-decide.
-- ----------------------------------------------------------------------------
with ranked as (
  select m.id,
         row_number() over (
           partition by m.charge_id
           order by
             abs(coalesce(r.ttd_amount, 0) - coalesce(c.amount, 0)) asc,
             abs(coalesce(r.receipt_date, c.anchor_date) - c.anchor_date) asc,
             coalesce(m.confidence, 0) desc,
             m.id asc
         ) as rn
  from receipt_statement_matches m
  join charges  c on c.id = m.charge_id
  join receipts r on r.id = m.receipt_id
  where m.confirmed and m.charge_id is not null
)
update receipt_statement_matches m
set confirmed = false,
    status    = 'needs_review'
from ranked
where ranked.id = m.id and ranked.rn > 1;

-- ----------------------------------------------------------------------------
-- The constraint the schema was missing. 0013's UNIQUE(receipt_id) WHERE
-- confirmed stays: one receipt still covers one charge. This adds the other
-- half -- one charge holds at most one confirmed receipt.
-- ----------------------------------------------------------------------------
create unique index if not exists rsm_unique_confirmed_charge
  on receipt_statement_matches (charge_id) where confirmed;

create unique index if not exists rsm_unique_pair
  on receipt_statement_matches (receipt_id, charge_id);
