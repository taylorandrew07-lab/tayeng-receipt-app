# IMPLEMENTATION PLAN — Consolidated Cross-Statement Reconciliation

Root: `c:\Users\Andrew\OneDrive\Documents\Tayeng Receipt App\tayeng-app`
All migrations are new files in `supabase/migrations/`. Every step leaves the app working.

---

## STEP 0 — Pre-flight (read-only, run in Supabase SQL editor first)

These tell you whether any later step will have to change data. **Run and keep the output.**

```sql
-- 0a. Baseline counts to verify against later.
select
  (select count(*) from statements)                                  as statements,
  (select count(*) from statement_transactions)                      as txns,
  (select count(*) from statement_transactions where txn_date is null) as txns_no_date,
  (select count(*) from receipt_statement_matches)                   as matches,
  (select count(*) from receipt_statement_matches where confirmed)   as confirmed_matches,
  (select count(*) from receipts where sent)                         as sent_receipts,
  (select count(*) from statement_transactions where is_matched)     as flagged_matched;

-- 0b. Statements with no usable period (drives the "latest 4" rule).
select id, file_name, period_start, period_end, created_at,
       (select min(txn_date) from statement_transactions t where t.statement_id = s.id) as min_txn,
       (select max(txn_date) from statement_transactions t where t.statement_id = s.id) as max_txn
from statements s
where period_start is null or period_end is null;

-- 0c. THE ONE THAT CAN BLOCK STEP 2: two DIFFERENT receipts confirmed against
--     what will become the same charge. If this returns rows, read Step 2's warning.
select btrim(regexp_replace(lower(coalesce(t.description,'')),'[^a-z0-9]+',' ','g')) as norm_desc,
       round(t.amount,2) as amount, count(*) as confirmed_copies,
       array_agg(distinct m.receipt_id) as receipts, array_agg(t.txn_date) as dates
from receipt_statement_matches m
join statement_transactions t on t.id = m.statement_transaction_id
where m.confirmed
group by 1,2
having count(distinct m.receipt_id) > 1
   and max(t.txn_date) - min(t.txn_date) <= 4;

-- 0d. Duplicate (receipt_id, txn) pairs — blocks the unique pair index in Step 2.
select receipt_id, statement_transaction_id, count(*)
from receipt_statement_matches
group by 1,2 having count(*) > 1;
```

**Verify:** 0c and 0d should both return 0 rows on a small dataset. If they do, Steps 1–2 are 100 % additive and non-destructive.

---

## STEP 1 — Migration `0014_charge_identity.sql` (charge identity)

### Design decision and justification

The prompt offers three options. **None of the three alone works**, and here is why:

- **Computed grouping at query time** — impossible to do correctly. Identity needs a *date tolerance* (a provider re-posting a carried-over line can shift the date by a day or two). Tolerance-based grouping is **not transitive** (a 1 Nov row groups with 4 Nov, 4 Nov groups with 7 Nov, but 1 Nov must not group with 7 Nov). Query-time grouping would therefore give a different answer depending on which rows the query happens to see — the same non-determinism class as the bug being fixed.
- **Stored generated column** — a generated column expression must be `IMMUTABLE`, so it cannot contain a *tolerant* date at all, and the normalisation rule gets frozen into the table DDL: improving it later forces a table rewrite. Rejected.
- **Plain `charge_key text` column + index** — right idea, wrong table. Put on `statement_transactions` it dies whenever a statement is deleted or re-parsed, which is exactly when the "already sent" evidence must survive.

**Chosen: a `charges` registry table** holding the indexed `charge_key`, with `statement_transactions.charge_id` as an FK assigned by a `BEFORE INSERT` trigger. This is the "charge_key text column with an index", hoisted one level up so it outlives statements.

Why this is right for free-tier Supabase with a small dataset:
- One extra tiny table (one row per real-world charge, ~hundreds/yr). Every lookup is a single index hit on `(user_id, charge_key, anchor_date)`.
- It **survives statement delete and re-parse** — the re-inserted row re-finds the same `charges` row by key, so the confirmed match and the "already sent" fact reattach automatically. That single property is what makes the whole four-state model durable.
- The normalisation rule lives in a plain function; improving it is one `UPDATE`, not a table rewrite.

### The key

`charge_key = normalized_description | amount(2dp) | currency | card_last4`

- **Description**: lowercase, every non-alphanumeric run → single space, trimmed. Identical to `normalizeVendor` (`lib/classification/classify.ts:11-16`) so TS and SQL agree.
- **Amount**: `round(amount, 2)::text` — must match **exactly**. A carried-over line is byte-identical in amount.
- **Currency** and **card_last4** included; a `NULL` last4 collapses to `''`.
- **Date is NOT in the key.** Dates match **within N days (default 4)**, `charge_match_days` in `user_settings` (Step 3).

Why ±4 and not exact: the model at `lib/extraction/parse-statement.ts:36` is told "if only a transaction date and a posting date exist, use the transaction date" — two different statement layouts routinely surface different one of the two, a 1–3 day gap. ±4 absorbs that.

**Precision over recall, deliberately.** A wrong merge silently hides a real charge; a missed merge just leaves the current (already-known) behaviour. Two hard guards:

1. **Two rows on the SAME statement never merge.** A genuine repeat charge (same shop, same amount, same week) is two real charges. Grouping is only ever across *different* `statement_id`s.
2. Both dates non-null, or both null. Never group a dated row with an undated one.

### SQL

```sql
-- ============================================================================
-- 0014_charge_identity.sql
-- Cross-statement identity for a real-world charge. Purely ADDITIVE.
-- ============================================================================

create or replace function charge_key_of(
  p_description text, p_amount numeric, p_currency text, p_card_last4 text
) returns text language sql immutable as $$
  select btrim(regexp_replace(lower(coalesce(p_description,'')), '[^a-z0-9]+', ' ', 'g'))
      || '|' || round(coalesce(p_amount, 0), 2)::text
      || '|' || upper(coalesce(nullif(btrim(p_currency), ''), 'TTD'))
      || '|' || coalesce(p_card_last4, '');
$$;

create table if not exists charges (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  charge_key  text not null,
  anchor_date date,                       -- earliest txn_date seen for this charge
  description text,
  amount      numeric(14, 2),
  currency    text not null default 'TTD',
  card_last4  text,
  created_at  timestamptz not null default now()
);
create index if not exists charges_lookup_idx on charges (user_id, charge_key, anchor_date);

alter table charges enable row level security;
create policy "charges_all_own" on charges
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table statement_transactions
  add column if not exists charge_id uuid references charges (id) on delete set null;
create index if not exists statement_txn_charge_idx on statement_transactions (charge_id);
-- Missing today (0001:209-210): required for cross-statement date-ordered reads.
create index if not exists statement_txn_user_date_idx
  on statement_transactions (user_id, txn_date, id);

create or replace function assign_charge() returns trigger language plpgsql as $$
declare k text; tol int; cid uuid;
begin
  k := charge_key_of(new.description, new.amount, new.currency, new.card_last4);
  select coalesce(s.charge_match_days, 4) into tol
    from user_settings s where s.user_id = new.user_id;
  tol := coalesce(tol, 4);

  select c.id into cid
  from charges c
  where c.user_id = new.user_id
    and c.charge_key = k
    and ( (new.txn_date is null and c.anchor_date is null)
       or (new.txn_date is not null and c.anchor_date is not null
           and abs(new.txn_date - c.anchor_date) <= tol) )
    -- GUARD 1: a charge takes at most one line per statement.
    and not exists (
      select 1 from statement_transactions t
      where t.charge_id = c.id and t.statement_id = new.statement_id and t.id <> new.id)
  order by c.anchor_date nulls last, c.created_at, c.id
  limit 1;

  if cid is null then
    insert into charges (user_id, charge_key, anchor_date, description, amount, currency, card_last4)
    values (new.user_id, k, new.txn_date, new.description, new.amount,
            upper(coalesce(nullif(btrim(new.currency),''),'TTD')), new.card_last4)
    returning id into cid;
  else
    update charges set anchor_date = least(anchor_date, new.txn_date)
    where id = cid and new.txn_date is not null;
  end if;

  new.charge_id := cid;
  return new;
end $$;

create trigger statement_txn_assign_charge
  before insert on statement_transactions
  for each row when (new.charge_id is null)
  execute function assign_charge();

-- BACKFILL: oldest-first so the earliest statement anchors each charge.
-- Additive only — writes charge_id on rows where it is null. Re-runnable.
do $$
declare r record;
begin
  for r in select id from statement_transactions where charge_id is null
           order by txn_date asc nulls last, created_at asc, id asc
  loop
    update statement_transactions set charge_id = null where id = r.id;  -- no-op, fires nothing
  end loop;
end $$;
```

The `do` block above is a placeholder — a `BEFORE INSERT` trigger will not fire on update. Use this instead:

```sql
-- BACKFILL (real). Replays assign_charge() logic in deterministic date order.
do $$
declare r record; k text; tol int; cid uuid;
begin
  for r in select t.* from statement_transactions t where t.charge_id is null
           order by t.txn_date asc nulls last, t.created_at asc, t.id asc
  loop
    k := charge_key_of(r.description, r.amount, r.currency, r.card_last4);
    select coalesce(s.charge_match_days, 4) into tol from user_settings s where s.user_id = r.user_id;
    tol := coalesce(tol, 4);

    select c.id into cid from charges c
    where c.user_id = r.user_id and c.charge_key = k
      and ( (r.txn_date is null and c.anchor_date is null)
         or (r.txn_date is not null and c.anchor_date is not null
             and abs(r.txn_date - c.anchor_date) <= tol) )
      and not exists (select 1 from statement_transactions t2
                      where t2.charge_id = c.id and t2.statement_id = r.statement_id and t2.id <> r.id)
    order by c.anchor_date nulls last, c.created_at, c.id limit 1;

    if cid is null then
      insert into charges (user_id, charge_key, anchor_date, description, amount, currency, card_last4)
      values (r.user_id, k, r.txn_date, r.description, r.amount,
              upper(coalesce(nullif(btrim(r.currency),''),'TTD')), r.card_last4)
      returning id into cid;
    elsif r.txn_date is not null then
      update charges set anchor_date = least(anchor_date, r.txn_date) where id = cid;
    end if;

    update statement_transactions set charge_id = cid where id = r.id;
  end loop;
end $$;
```

**Flag:** this writes `statement_transactions.charge_id` (previously NULL) and inserts `charges` rows. It touches **nothing else** — no match, no receipt, no confirmed flag. Fully reversible: `update statement_transactions set charge_id = null; truncate charges cascade;`

**Verify:**
```sql
select count(*) from statement_transactions where charge_id is null;          -- expect 0
select count(*) as charge_count, (select count(*) from statement_transactions) as txn_count from charges;
-- The duplicates it found — eyeball these, they are the carried-over lines:
select c.id, c.description, c.amount, c.anchor_date, count(t.id) as copies,
       array_agg(s.file_name) as on_statements
from charges c join statement_transactions t on t.charge_id = c.id
join statements s on s.id = t.statement_id
group by c.id having count(t.id) > 1 order by c.anchor_date;
```
That last query is the money shot: it is the list of charges that were being double-reported.

**App after Step 1:** unchanged, still works. Nothing reads `charge_id` yet.

---

## STEP 2 — Migration `0015_match_durability.sql` (matches anchor to charges)

Moves the match's anchor from a per-statement row to the charge, makes it survive statement deletion, and fixes `is_matched` drift.

### The 0013 constraint question — answered

`rsm_unique_confirmed_receipt` (`0013:14-16`, `UNIQUE(receipt_id) WHERE confirmed`) is **correct and stays**. One receipt covers one real-world charge; that was never the problem. The problem was the *missing* complementary rule. Add:

```
UNIQUE (charge_id) WHERE confirmed
```

i.e. **the constraint moves onto the charge key** in the sense the prompt intends: a receipt now satisfies a CHARGE, and confirmation is recorded against `charge_id`, not against a per-statement row. `statement_transaction_id` becomes provenance only, and is allowed to go NULL.

```sql
-- ============================================================================
-- 0015_match_durability.sql
-- ============================================================================

-- SAFETY NET — reversible snapshot before any write to this table.
create table if not exists rsm_backup_pre_0015 as select * from receipt_statement_matches;

alter table receipt_statement_matches
  add column if not exists charge_id       uuid references charges (id) on delete cascade,
  add column if not exists rejected_at     timestamptz,
  -- provenance snapshot: survives statement deletion / re-parse
  add column if not exists snap_statement_id uuid,
  add column if not exists snap_txn_date     date,
  add column if not exists snap_amount       numeric(14,2),
  add column if not exists snap_description  text;

-- statement_transaction_id becomes non-authoritative provenance.
alter table receipt_statement_matches
  drop constraint if exists receipt_statement_matches_statement_transaction_id_fkey;
alter table receipt_statement_matches
  add constraint receipt_statement_matches_statement_transaction_id_fkey
  foreign key (statement_transaction_id)
  references statement_transactions (id) on delete set null;

-- Backfill charge_id + snapshot from the linked transaction. Additive.
update receipt_statement_matches m
set charge_id        = t.charge_id,
    snap_statement_id = t.statement_id,
    snap_txn_date     = t.txn_date,
    snap_amount       = t.amount,
    snap_description  = t.description
from statement_transactions t
where t.id = m.statement_transaction_id and m.charge_id is null;

create index if not exists rsm_charge_idx on receipt_statement_matches (charge_id);

-- Keep charge_id + snapshot fresh on every write.
create or replace function sync_match_charge() returns trigger language plpgsql as $$
begin
  if new.statement_transaction_id is not null then
    select t.charge_id, t.statement_id, t.txn_date, t.amount, t.description
      into new.charge_id, new.snap_statement_id, new.snap_txn_date, new.snap_amount, new.snap_description
    from statement_transactions t where t.id = new.statement_transaction_id;
  end if;
  return new;
end $$;
create trigger rsm_sync_charge before insert or update of statement_transaction_id
  on receipt_statement_matches for each row execute function sync_match_charge();

-- is_matched becomes DERIVED (fixes the three drift paths).
create or replace function sync_txn_is_matched() returns trigger language plpgsql as $$
declare tid uuid;
begin
  foreach tid in array array_remove(array[
      case when tg_op <> 'INSERT' then old.statement_transaction_id end,
      case when tg_op <> 'DELETE' then new.statement_transaction_id end], null)
  loop
    update statement_transactions t
      set is_matched = exists (select 1 from receipt_statement_matches m
                               where m.statement_transaction_id = t.id and m.confirmed)
    where t.id = tid;
  end loop;
  return null;
end $$;
create trigger rsm_sync_is_matched after insert or update or delete
  on receipt_statement_matches for each row execute function sync_txn_is_matched();

-- One-time recompute of the drifted flag.
update statement_transactions t
set is_matched = exists (select 1 from receipt_statement_matches m
                         where m.statement_transaction_id = t.id and m.confirmed)
where t.is_matched <> exists (select 1 from receipt_statement_matches m
                              where m.statement_transaction_id = t.id and m.confirmed);
```

### ⚠️ THE ONE POTENTIALLY DESTRUCTIVE PART — read before running

The two new unique indexes can fail on existing data. **Run Step 0c and 0d first.** If they returned rows:

```sql
-- ONLY IF 0d returned rows. Deletes duplicate suggestion rows (keeps earliest).
-- DATA-CHANGING. rsm_backup_pre_0015 is your undo.
delete from receipt_statement_matches a using receipt_statement_matches b
where a.receipt_id = b.receipt_id and a.charge_id = b.charge_id
  and a.charge_id is not null and a.id > b.id
  and not a.confirmed;

-- ONLY IF 0c returned rows: two different receipts confirmed to one charge.
-- NON-DESTRUCTIVE demotion — nothing is deleted, the later one becomes a
-- suggestion you re-decide in the UI.
update receipt_statement_matches m
set confirmed = false, status = 'needs_review'
where m.confirmed and exists (
  select 1 from receipt_statement_matches b
  where b.confirmed and b.charge_id = m.charge_id and b.id < m.id);
```

Then:

```sql
create unique index if not exists rsm_unique_confirmed_charge
  on receipt_statement_matches (charge_id) where confirmed;
create unique index if not exists rsm_unique_pair
  on receipt_statement_matches (receipt_id, charge_id);
```

`rsm_unique_confirmed_receipt` from 0013 is **left in place unchanged**.

**Can an existing confirmed match be invalidated or re-pointed?** Only in the 0c case, and only by *demotion to a suggestion* (never deletion), and only when two different receipts were already double-covering one charge — which is a real data error you want surfaced. `receipts.sent` is never touched.

**Verify:**
```sql
select count(*) from receipt_statement_matches where charge_id is null and statement_transaction_id is not null; -- 0
select (select count(*) from receipt_statement_matches where confirmed) as now_confirmed,
       (select count(*) from rsm_backup_pre_0015 where confirmed)       as before_confirmed;  -- equal, unless 0c demoted
select count(*) from receipts where sent;  -- unchanged vs Step 0a
```
Keep `rsm_backup_pre_0015` until you have used the app for a full cycle, then drop it.

**App after Step 2:** unchanged, still works. `is_matched` is now correct everywhere, which already fixes `app/(app)/statements/[id]/page.tsx:94` lying.

---

## STEP 3 — Migration `0016_reconciliation_settings.sql` (his scope rules, as settings)

```sql
alter table user_settings
  add column if not exists reconcile_statement_count  int not null default 4,
  add column if not exists receipt_window_days_before int not null default 60,
  add column if not exists charge_match_days          int not null default 4,
  add column if not exists auto_confirm_enabled       boolean not null default false;

-- Period backfill: makes "latest by period_end" meaningful for statements whose
-- parse failed to detect a period. Additive, only fills NULLs.
update statements s set
  period_start = coalesce(s.period_start,
                          (select min(t.txn_date) from statement_transactions t where t.statement_id = s.id)),
  period_end   = coalesce(s.period_end,
                          (select max(t.txn_date) from statement_transactions t where t.statement_id = s.id))
where s.period_start is null or s.period_end is null;

-- "Latest" is defined here, once, unambiguously. NOT created_at.
create or replace view statement_coverage with (security_invoker = on) as
select s.*,
  coalesce(s.period_start,
    (select min(t.txn_date) from statement_transactions t where t.statement_id = s.id),
    s.created_at::date) as effective_start,
  coalesce(s.period_end,
    (select max(t.txn_date) from statement_transactions t where t.statement_id = s.id),
    s.created_at::date) as effective_end,
  (select count(*) from statement_transactions t where t.statement_id = s.id) as txn_count
from statements s;

grant select on statement_coverage to authenticated, service_role;
```

**"Latest N" definition (6a):** order by `effective_end DESC, effective_start DESC, created_at DESC`, take `reconcile_statement_count`.
- `effective_end` = `period_end` → else `max(txn_date)` of its own rows → else `created_at::date`. A statement whose period never parsed is therefore still ordered by its **real content**, never by upload order.
- **Fewer than 4 statements:** `.limit(n)` simply returns all of them. No special case, no error, no empty screen.
- `reconcile_statement_count = 0` is treated by the app as "all statements".

**Verify:** `select id, file_name, effective_start, effective_end, txn_count from statement_coverage order by effective_end desc;` — confirm the newest-by-coverage statement is on top, not the last one uploaded.

---

## STEP 4 — Migration `0017_charge_reconciliation_view.sql` (the four states, one pass)

This is requirement 2. **One view, one query, one round trip.** Server-side reduction, `security_invoker` so RLS still applies, readable by PostgREST exactly like a table — no RPC, matching the existing code style (`grep rpc(` over `lib/` and `app/` returns nothing today).

```sql
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
    c.id as charge_id, c.user_id,
    min(t.txn_date) as txn_date,                       -- earliest real date = sort key
    (array_agg(t.description order by t.txn_date nulls last, t.created_at, t.id))[1] as description,
    (array_agg(t.amount      order by t.txn_date nulls last, t.created_at, t.id))[1] as amount,
    (array_agg(t.currency    order by t.txn_date nulls last, t.created_at, t.id))[1] as currency,
    (array_agg(t.card_last4  order by t.txn_date nulls last, t.created_at, t.id))[1] as card_last4,
    (array_agg(t.id          order by t.txn_date nulls last, t.created_at, t.id))[1] as canonical_txn_id,
    array_agg(distinct t.statement_id) as statement_ids,
    array_agg(distinct t.file_name)    as statement_names,
    count(*)::int as copies
  from charges c join tx t on t.charge_id = c.id
  group by c.id, c.user_id
),
cm as (   -- at most one row per charge (rsm_unique_confirmed_charge guarantees it)
  select m.charge_id, m.id as match_id, m.receipt_id, m.confidence,
         r.vendor_name, r.receipt_date, r.ttd_amount, r.sent, r.sent_at, r.paid
  from receipt_statement_matches m join receipts r on r.id = m.receipt_id
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
  (a.copies > 1)                       as is_duplicate,
  cm.match_id, cm.receipt_id,
  cm.vendor_name  as receipt_vendor,
  cm.receipt_date as receipt_date,
  cm.ttd_amount   as receipt_amount,
  coalesce(cm.sent, false) as receipt_sent,
  cm.sent_at      as receipt_sent_at,
  coalesce(pm.pending_count, 0) as pending_count,
  pm.best_confidence,
  case
    when cm.receipt_id is not null and cm.sent then 'already_sent'
    when cm.receipt_id is not null             then 'already_matched'
    when coalesce(pm.pending_count,0) > 0      then 'needs_confirmation'
    else                                            'genuinely_new'
  end as state
from agg a
left join cm on cm.charge_id = a.charge_id
left join pm on pm.charge_id = a.charge_id;

grant select on charge_reconciliation to authenticated, service_role;
```

### How the four states read

| State | Means | Action |
|---|---|---|
| `already_sent` (A) | confirmed match, `receipts.sent = true` | **none.** Never re-send. |
| `already_matched` (B) | confirmed match, not yet sent | **send it.** Do not re-hunt. |
| `needs_confirmation` | pending suggestion, unconfirmed | approve or reject |
| `genuinely_new` (D) | no confirmed match, no live suggestion | **this is his work list** |

**Duplicate (C) is a property, not a fifth state** — `is_duplicate` / `copies` / `statement_names`. This is deliberate and it is exactly what he asked for: the carried-over PriceSmart line no longer appears twice with one green and one amber. It appears **once**, with state `already_sent` and a chip "also on estatement-dec.pdf". A duplicate with no receipt appears **once** as `genuinely_new`, not twice.

**Counted once in all totals** by construction — the view emits one row per charge, so `sum(amount)` over the view cannot double-count. That directly fixes the inflated Statement total.

**One query pass**, from the app:
```ts
supabase.from("charge_reconciliation")
  .select("*")
  .overlaps("statement_ids", scopeStatementIds)
  .order("txn_date", { ascending: true, nullsFirst: true })
  .order("charge_id", { ascending: true })
  .range(from, from + 999);
```
`nullsFirst: true` pins undated charges at the **top** as a visible "Undated — needs your eye" group rather than burying them (the current `route.ts:53` buries them). Secondary sort on `charge_id` makes same-date order stable across renders, which the PDF row numbering depends on.

**Verify:**
```sql
select state, count(*), sum(amount) from charge_reconciliation group by state order by 1;
select * from charge_reconciliation where is_duplicate order by txn_date;
```
The second query is his proof: every one of those rows was previously reported as MISSING at least once.

---

## STEP 4b — Orphan receipts: receipts with NO statement line (ADDED after pre-flight)

**Requirement (Andrew, 2026-07-28):** *"if I put in a receipt that you're not seeing on this statement,
that also needs to be added to the reconciliation and noted, so that I don't have to send it later on —
they can just deal with it."*

**Why this is not optional:** pre-flight found **39 of 81 receipts have no confirmed statement line**;
24 of those are not yet sent, worth **TTD 10,772.75**. Today they appear only in a `slice(0, 50)`
sidebar on `/matching` and appear in **no report at all**, so they are invisible to the accountant.

`charge_reconciliation` is built from `charges`, which derive from `statement_transactions` — a receipt
with no statement line can never appear in it. A companion view is required.

```sql
create or replace view orphan_receipts with (security_invoker = on) as
select r.id as receipt_id, r.user_id, r.receipt_date, r.vendor_name,
       r.ttd_amount, r.amount, r.currency, r.card_last4,
       r.sent, r.sent_at, r.paid, r.reimbursable, r.category_id,
       (select count(*) from receipt_statement_matches m
         where m.receipt_id = r.id and not m.confirmed and m.rejected_at is null) as pending_count
from receipts r
where r.duplicate_of is null
  and r.status = 'confirmed'
  and not exists (select 1 from receipt_statement_matches m
                  where m.receipt_id = r.id and m.confirmed);

grant select on orphan_receipts to authenticated, service_role;
```

**State model gains a fifth value**, `no_statement_line`, carried on its own list rather than merged
into `charge_reconciliation` (the two have different primary keys — charge vs receipt — and merging
them into one view would make both harder to page and sort). The app layer interleaves them by date.

- `lib/reconciliation/charges.ts` gains `loadOrphanReceipts(supabase, scope)`.
- **Sort key is `receipt_date`**, so orphans interleave into the same date-ordered work-down list.
- **Scope:** orphans are NOT limited to the selected statements (they have no statement). Show orphans
  whose `receipt_date` falls within the scope window (`windowStart` → latest `effective_end` + 31 days),
  with an "outside this period" toggle to reveal the rest. Never silently hide them — show a count.

**UI (Step 6) gains a section**, placed directly after "NEEDS A RECEIPT":
> **⬜ RECEIPTS WITH NO STATEMENT LINE — send anyway** — *"These have no matching charge on the
> statements. They still go to the accountant."* Each row: date, vendor, amount, currency, a
> **"Mark sent"** action, and a **"Find a match"** link opening a manual attach against any open charge.

**PDF (Step 9) gains §2a — RECEIPTS WITH NO STATEMENT LINE**, immediately after §1, listed in date
order with their documents appended to the appendix like any other. This is the piece that closes his
"so I don't have to send it later" requirement: they ship in the same PDF, marked, in one pass.

**Also flag on these rows** (pre-flight surfaced all three in his real data):
- `receipt_date` later than every statement's `effective_end` → chip **"after statement period — likely on next statement"** (e.g. Hyatt 2026-08-07).
- `currency <> 'TTD'` → show original amount + converted, since FX drift explains near-miss amounts.
- Two or more orphans with identical `vendor_name` + `ttd_amount` + `receipt_date` → chip **"possible duplicate upload"** (his data has 4× Caribbean Airlines TTD 77.00 on 2026-04-22).

**Verify:** `select count(*) from orphan_receipts where not sent;` must equal the count in the new UI
section, and the PDF §2a row count must match it.

---

## STEP 4c — Month scope (ADDED after pre-flight)

**Requirement (Andrew, 2026-07-28):** *"when it's doing the reconciliation for the month, just give me
all the statements and all the receipts for that one month, by order of date."*

This falls out almost free from the charge model: because a charge is date-anchored and independent of
which statement carried it, a month is just a date range over the merged set. **No new view needed.**

### ⚠️ Do NOT use `receipts.month_key`

Migration `0004` re-buckets `month_key` to the **UPLOAD** month (`to_char(created_at,'YYYY-MM')`), not
the date on the document. Andrew uploaded all four statements on 2026-07-17, so every receipt around
them shares an upload month regardless of when the charge happened. Using `month_key` here would put a
May charge in the July workspace. **Reconciliation months are computed from `txn_date` /
`receipt_date` only.** The existing receipts workspace keeps its upload-month behaviour; these are two
different notions of "month" and must not be conflated.

### Definition

`?month=YYYY-MM` scopes to **calendar month of the real date**:
- charges where `txn_date` falls in the month — **from whatever statement(s) carried them**, which is
  exactly "all the statements for that month"; his statements run 16th-to-15th, so a calendar month is
  routinely served by two statements, and that is the point;
- orphan receipts (Step 4b) where `receipt_date` falls in the month;
- statements listed in the header = every statement contributing at least one charge, so he can see
  which documents the month was assembled from.

`resolveScope` gains `{ month?: string }`: `statementIds` = statements overlapping the month (for the
header and the statement filter), and a `dateFrom`/`dateTo` pair applied to the charge and orphan
queries. The candidate window for matching still comes from the statements, not the month, so a receipt
just outside the month can still match a charge inside it.

**Month picker** in the page header, listing months descending, derived once:
```sql
create or replace view reconciliation_months with (security_invoker = on) as
select user_id, month, sum(charges)::int as charges, sum(orphans)::int as orphans from (
  select user_id, to_char(txn_date,'YYYY-MM') as month, count(*) as charges, 0 as orphans
    from statement_transactions where txn_date is not null group by 1,2
  union all
  select r.user_id, to_char(r.receipt_date,'YYYY-MM'), 0, count(*)
    from receipts r where r.receipt_date is not null and r.duplicate_of is null
     and not exists (select 1 from receipt_statement_matches m where m.receipt_id=r.id and m.confirmed)
   group by 1,2
) x group by user_id, month;
grant select on reconciliation_months to authenticated, service_role;
```
Note this counts **lines**, not deduped charges — it is only for populating the picker with month labels
and rough counts, never for totals. Totals always come from `charge_reconciliation`.

`?month=` composes with the existing scopes: no param ⇒ latest N statements; `?month=2026-05` ⇒ that
calendar month; `?statement=<id>` ⇒ one statement; `?all=1` ⇒ everything.

### Charges that will never have a receipt

Simulating May on real data put **`OVERLIMIT FEE  45.00`** in "NEEDS A RECEIPT". Bank fees, interest,
annual fees, FX levies and card payments have no receipt and never will, so without handling they sit
in the work list permanently and train him to ignore it — the same failure the phantom-missing bug
caused.

Add a sixth state `no_receipt_expected`, driven by:
- `charges.no_receipt_expected boolean not null default false`, set from a **"No receipt needed"**
  action on any row (one click, reversible), which persists on the charge so it stays suppressed when
  the same fee reappears on the next overlapping statement;
- a seed list of description patterns auto-flagging on insert — `overlimit fee`, `interest`,
  `annual fee`, `late fee`, `service charge`, `payment thank you`, `payment received`, `fx fee`,
  `cash advance fee` — applied case-insensitively in `assign_charge()`.

These render in their own collapsed **"No receipt needed"** section, are excluded from the "needs a
receipt" count and from §1 of the PDF, but are still counted in the month total (they are real money).
Auto-flagged ones show a "why" chip so a wrongly-suppressed charge is visible and one-click restorable.

### Ordering — "in order of what's outstanding"

Already in Step 6 and unchanged: sections run **needs a receipt → no statement line → needs
confirmation → ready to send → already sent**, outstanding first, already-sent collapsed at the bottom.
Within every section, date ascending. Add a **"Sort: by status / by date"** toggle in the header so he
can flip to one flat strict-date list when he wants to read the month straight through, since he has
asked for both orderings at different times. Default stays status-first.

**Verify:** `/matching?month=2026-05` header must name every statement covering May (his data:
`Andrew 1`, `Andrew 2`, `Andrew 3`), each May charge appears exactly once regardless of how many of
those carried it, and the total equals
`select sum(amount) from charge_reconciliation where txn_date >= '2026-05-01' and txn_date < '2026-06-01'`.

---

## STEP 5 — Data layer (`lib/reconciliation/`) — new files, nothing breaks

**`lib/reconciliation/types.ts`**
```ts
export type ChargeState = "already_sent" | "already_matched" | "needs_confirmation" | "genuinely_new";
export type ChargeRow = { charge_id: string; txn_date: string | null; description: string | null;
  amount: number | null; currency: string; card_last4: string | null; canonical_txn_id: string;
  statement_ids: string[]; statement_names: string[]; copies: number; is_duplicate: boolean;
  match_id: string | null; receipt_id: string | null; receipt_vendor: string | null;
  receipt_date: string | null; receipt_amount: number | null; receipt_sent: boolean;
  receipt_sent_at: string | null; pending_count: number; best_confidence: number | null;
  state: ChargeState };
export type ReconScope = { statementIds: string[]; windowStart: string | null;
  label: string; statements: { id: string; file_name: string; effective_start: string;
  effective_end: string; txn_count: number }[] };
```

**`lib/reconciliation/paginate.ts`** — kills every row cap in the audit (`config.toml:18`, hosted default 1000).
```ts
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{data: T[]|null; error: {message:string}|null}>) {
  const out: T[] = []; const SIZE = 1000;
  for (let from = 0; ; from += SIZE) {
    const { data, error } = await page(from, from + SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? []; out.push(...rows);
    if (rows.length < SIZE) return out;
  }
}
```
Every unbounded query in the audit (`actions.ts:22,30,43`; `page.tsx:39,48,66,73`; `reports/statement/route.ts:52,63`; `append-receipts.ts:65`) is rewritten through this.

**`lib/reconciliation/scope.ts`**
```ts
export async function resolveScope(supabase, opts: { statementId?: string; all?: boolean }): Promise<ReconScope>
```
1. Read `user_settings` (`reconcile_statement_count`, `receipt_window_days_before`).
2. `from("statement_coverage").select("id,file_name,effective_start,effective_end,txn_count").order("effective_end",{ascending:false}).order("created_at",{ascending:false})` — `.limit(count)` unless `all` or `statementId`.
3. `statementIds` = those ids (`[statementId]` if filtering).
4. `windowStart = min(effective_start over the selected statements) − receipt_window_days_before` days.

**`lib/reconciliation/charges.ts`** — `loadCharges(supabase, scope)` returning `ChargeRow[]` via `fetchAll` + the view query above.

**Verify:** temporary `/api/debug/scope` route, or just build the page in Step 6 and read it.

---

## STEP 6 — Consolidated view as the default (`app/(app)/matching/page.tsx` rewrite)

Requirement 3. Signature becomes:
```ts
searchParams: Promise<{ statement?: string; all?: string; state?: ChargeState }>
```

- **No param ⇒ consolidated over the latest N statements.** `page.tsx:29`'s `return <StatementPicker/>` is deleted. The picker becomes a **filter dropdown** in the header, ordered `effective_end DESC` and labelled `period · N txns` so identical `estatement.pdf` filenames are distinguishable.
- `?statement=<id>` ⇒ same page, scope narrowed to one statement. `?all=1` ⇒ every statement.
- Rows come from `loadCharges`, already sorted `txn_date ASC NULLS FIRST` — **a statement uploaded later covering earlier dates interleaves correctly**, because the sort key is the real transaction date on the charge, not the statement.
- Layout, top to bottom:
  1. **Undated** (pinned, `txn_date is null`) — "these have no date, check them".
  2. **⬜ NEEDS A RECEIPT — `genuinely_new`** — his actual work list, expanded by default.
  3. **NEEDS YOUR CONFIRMATION — `needs_confirmation`** with Confirm / Not a match.
  4. **READY TO SEND — `already_matched`** with a "Mark sent" bulk action.
  5. **ALREADY SENT — `already_sent`**, collapsed by default, with `sent_at`.
- Every row shows source statements: `statement_names.join(" + ")`; when `copies > 1`, a chip **"appears on 2 statements — counted once"**.
- Stat tiles: one per state + **Total (charges, not lines)** + total value, all computed from the same array so tile and list can never disagree.
- `unmatchedReceipts.slice(0,50)` (`page.tsx:264`) is replaced by a paged `?rp=` list with "Showing 50 of 380 — show more" and a vendor/amount filter box.
- Add `components/app-shell/nav.ts` item **`{ href: "/matching", label: "Reconciliation", icon: "🔗" }`** replacing "Matching".

**Verify:** open `/matching` with no query string. You must see one date-ordered list spanning the latest 4 statements, with the previously-double-reported charges appearing exactly once, most of them green "Already sent".

---

## STEP 7 — One global matching pass (`lib/matching/actions.ts` rewrite)

Requirement 4 + 6b/6c/6d. New action `runConsolidatedMatching(prev, formData)` returning a result object consumed with `useActionState` (replaces the silent `void` action at `page.tsx:90`).

```
1. auth → typed error, not silent return
2. scope = resolveScope(supabase, { statementId?, all? })
3. charges = loadCharges(scope)
4. openCharges = charges.filter(c => c.state === "genuinely_new" || c.state === "needs_confirmation")
     -> MatchTxn[] { id: canonical_txn_id, chargeId, txn_date, description, amount, currency, card_last4 }
   ** Already-sent and already-matched charges are NEVER rescored. **
5. confirmedReceiptIds = fetchAll(from rsm select receipt_id eq confirmed true)   // paginated
6. candidate receipts (paginated, ordered, filtered):
     .from("receipts")
     .select("id,receipt_date,vendor_name,ttd_amount,currency,card_last4,sent,paid")
     .not("ttd_amount","is",null)
     .is("duplicate_of", null)              // flagged duplicates are not candidates
     .neq("status","processing")            // mid-extraction receipts are not candidates
     .neq("doc_type","statement")
     .or(`receipt_date.gte.${scope.windowStart},receipt_date.is.null,sent.is.true,paid.is.true`)   // ⬅ 6c EXEMPTION
     .order("receipt_date",{ascending:false}).order("id")
   then .filter(r => !confirmedReceiptIds.has(r.id))
7. rejected = fetchAll(rsm select receipt_id,charge_id where rejected_at not null) -> Set("rid|cid")
8. outcome = matchReceipts(openTxns, receipts, settings)   // ONE global assignment
9. write (see below)
10. return { statementsScanned, chargesOpen, receiptsConsidered, suggested, strong, stillMissing, errors[] }
```

### 6b — candidate window: **UNION, not per-statement**

`windowStart = min(effective_start across the selected statements) − receipt_window_days_before` (default 60), and there is **one** window for the whole run.

Justification: the entire point of Step 7 is a *single* assignment over the merged set. A per-statement window makes a receipt eligible for line A but not line B, which reintroduces order-dependence through the back door — the greedy assignment could be forced to hand a receipt to the only statement whose window admits it, even when a strictly better line exists on another. The union is also strictly more permissive, so nothing a per-statement window would have admitted is excluded. Precision is preserved by *scoring* (`dateScore` already collapses to 0 past `tolDays × 3`), not by a hard cutoff.

### 6c — the exemption, exactly where it lives

**Line 6 above, the `.or(...)`.** In prose: `receipt_date >= windowStart` **OR** `receipt_date IS NULL` **OR** `sent = true` **OR** `paid = true`.

And the more important half: **the window never touches state resolution at all.** `charge_reconciliation` (Step 4) has no date filter anywhere. A charge whose receipt was confirmed and sent eleven months ago resolves to `already_sent` regardless of how old that receipt is, because the resolution goes through `charges` → `receipt_statement_matches.charge_id` → `receipts.sent`, not through the candidate pool. That is the structural guarantee that the cutoff cannot re-create the original bug. The `.or(...)` is belt-and-braces for the case where a sent receipt somehow lost its match row.

### 6d — auto-confirm: **turn it off for the bulk run.** Recommended.

The run now considers ~4× the pairings, so a 75-scoring coincidence is ~4× more likely per run — and every one it writes is `confirmed: true` straight into a DB-enforced unique index, which makes it *effectively permanent* for a non-technical user. Compounding: `rejectMatch` today has no memory (`actions.ts:121`), so even noticing and unmatching does not stick — the next run recreates it. And `scorePair` reaches 75 on amount + date alone plus a 0.05 nudge, with a card **mismatch** costing only −0.15 (`match.ts:94`) — the audit documented four separate ways to hit 75 with zero merchant evidence.

Decision:
- **All bulk-run pairings are written `confirmed: false, status: 'possible_match'`.**
- The strong ones are **pre-ticked** in a "Approve all 14 high-confidence matches" control — one click, but *his* click, and he sees what he approved.
- `auto_confirm_enabled` (Step 3) defaults `false`. If he ever turns it on, it applies only to pairings passing the tightened conjunctive gate in Step 8, never to the plain ≥75 score.

### Write path — no silent loss

Replace the delete-then-insert (`actions.ts:65-81`) with an **upsert on the unique pair index**:

```ts
const CHUNK = 200; const errors: string[] = [];
for (let i = 0; i < rows.length; i += CHUNK) {
  const { error } = await supabase.from("receipt_statement_matches")
    .upsert(rows.slice(i, i + CHUNK),
            { onConflict: "receipt_id,charge_id", ignoreDuplicates: true });
  if (error) {                                    // fall back so ONE bad row ≠ whole batch lost
    for (const r of rows.slice(i, i + CHUNK)) {
      const { error: e1 } = await supabase.from("receipt_statement_matches")
        .upsert(r, { onConflict: "receipt_id,charge_id", ignoreDuplicates: true });
      if (e1) errors.push(`${r.receipt_id}: ${e1.message}`);
    }
  }
}
```
`ignoreDuplicates: true` on `rsm_unique_pair` means a confirmed row is never clobbered and a **rejected row is never resurrected** — rejection memory, for free. The destructive `delete()` is replaced by a narrow cleanup that only removes stale, unconfirmed, un-rejected rows for charges in scope whose pair is no longer suggested. If the delete is skipped due to error, nothing is lost.

Also rewrite:
- **`confirmMatch`** — destructure `{ error }`; on `23505` return `"That receipt is already confirmed against <charge> on <statement>."` and **do not** touch `statement_transactions` (which is now trigger-derived anyway). Confirm targets the charge; the `unique(charge_id) where confirmed` index enforces one receipt per charge.
- **`rejectMatch`** — `update { rejected_at: now(), confirmed: false, status: 'unmatched_receipt' }` instead of `delete`. The pair is excluded from future runs at step 7 above.
- New **`approveSuggestions(ids[])`** and **`markChargesSent(chargeIds[])`** (sets `receipts.sent/sent_at`, and `revalidatePath("/matching")` — which `lib/receipts/actions.ts:259-268` currently omits).
- Add a shared `components/ui/submit-button.tsx` using `useFormStatus`, applied to every reconciliation form, so a click visibly does something.

**Verify:** run it; the result banner must read e.g. *"Scanned 4 statements · 63 open charges · 412 receipts considered · 18 suggested (11 high-confidence) · 34 still need a receipt"*. Re-run it: identical numbers (determinism). Reject a suggestion, re-run: it does **not** come back.

---

## STEP 8 — Scoring hardening (`lib/matching/match.ts`)

- `MatchTxn` gains `currency` and `charge_id`; `MatchReceipt` gains `currency`, `sent`.
- **Currency**: if `txn.currency !== 'TTD'`, compare against `receipt.amount` when `receipt.currency === txn.currency`, else convert via `usd_to_ttd_rate`; if neither reconciles, return 0.
- **Card mismatch is disqualifying** when both sides have a last4 (was −0.15 at `:94`).
- **Null date → 0.25** and the pair can never earn the "strong" label (was 0.3 counting toward auto-confirm).
- **`vendorScore`**: stopword list (`ltd limited inc co the and trinidad tobago store stores ltda pos`) removed before scoring; require `overlap ≥ 1` on a non-stopword token.
- **Absolute amount floor**: "strong" additionally requires `|txn − receipt| ≤ max(1.00, tolPct% of amount)`, killing the TTD-200-gap auto-confirm.
- **`STRONG_CONFIDENCE = 82`** *and* a conjunctive gate: `aScore ≥ 0.95 && vScore ≥ 0.34 && dScore ≥ 0.6`. Used only to pre-tick the approve checkbox.
- **Deterministic sort** at `:124`: `confidence desc, txn_date asc, transaction_id asc, receipt_id asc`.
- **EXACT-AMOUNT PRE-PASS (added after pre-flight — this is a real, observed bug).** The pre-flight
  found the greedy matcher has **cross-matched pairs** in live data: statement lines TTD 224.70 (01 Jun)
  and TTD 222.32 (03 Jun) were matched to receipts of TTD **222.32** and TTD **224.70** respectively —
  swapped. Same again for PEAKE 225.56 (16 Jun) / 226.07 (19 Jun) against receipts 226.07 / 225.56.
  Cause: `dateScore` (gap 0) outweighs the amount difference, so a same-day near-miss beats an
  exact-amount pair two days out. Both pairings score >85, so both auto-confirmed.
  **Fix:** before the general greedy loop, run an assignment pass over pairs whose amounts are equal to
  the cent (`|txn − receipt| < 0.005`) and whose vendor overlaps, ordered by date gap ascending; lock
  those in first. Only then run the existing loop over what remains. Exact amount is far stronger
  evidence than same-day proximity and must not lose to it.
- **Forward bound.** Andrew's 60-day rule bounds receipts *before* a statement, but every wrong far-gap
  match in his data is a receipt dated **after** the statement period (43, 50, 71 days later) being
  pulled backwards. Add `receipt_window_days_after` (default 15) so a receipt more than N days past a
  statement's `effective_end` is not a candidate for it — subject to the same
  confirmed/sent exemption as the backward window.
- Blocking before the O(T×R) loop: bucket receipts by `round(ttd_amount)` ±tolerance so the cartesian scan does not grow quadratically across 4 statements.

**Verify:** add `lib/matching/match.test.ts` with the audit's exact failure cases — "PBS 5533 SAN JUAN" vs "Massy Stores" (must not be strong), "MASSY STORES" vs "MASSY MOTORS" (must not be strong), USD 100 line vs TTD 100 receipt (must score 0), wrong-card perfect pair (must score 0), TTD 5200 vs TTD 5000 (must not be strong).

---

## STEP 9 — Consolidated reconciliation PDF

**New:** `app/api/reports/reconciliation/route.ts`, `lib/reports/reconciliation-report-document.tsx`.
**Unchanged:** the existing single-statement route keeps working.

`GET /api/reports/reconciliation?statement=<id>|all=1&appendix=send|new|none`

**Document structure — ordered so he can work down it:**

1. Cover: company, name, statements covered (name · period · txn count each), generated date.
2. Summary: charges, total value, and a count + total per state. Explicit line: *"N charges appear on more than one statement — each is listed and counted once."*
3. **§1 ACTION REQUIRED — no receipt found** (`genuinely_new`), date ascending, with a `☐` glyph column, printed in bold + amber. **Undated first.**
4. **§2 NEEDS YOUR CONFIRMATION** (`needs_confirmation`) with the suggested receipt and its confidence.
5. **§3 READY TO SEND — matched, not yet sent** (`already_matched`). This is the send list.
6. **§4 ALREADY SENT — no action** (`already_sent`), struck-through/grey, with `sent_at`. Reference only.
7. Appendix: receipt documents.

Columns: `# | Date | Description | Amount | Statement(s) | Status | Receipt (vendor · date · amount)`. `COLS` re-budgeted from `{n:5,date:11,desc:34,amount:13,status:13,receipt:24}` to `{n:4,date:9,desc:28,amount:11,stmt:10,status:14,receipt:24}`. Row `key` becomes `charge_id`, not `n` (removes the globally-unique-`n` constraint at `statement-report-document.tsx:92`). `n` numbers **globally across the merged set** and is stable because the sort has a tiebreaker.

Add a `fixed` footer: `render={({pageNumber, totalPages}) => \`Page ${pageNumber} of ${totalPages}\`}`. Filename: `reconciliation-${earliestStart}-to-${latestEnd}-${today}.pdf`.

**60-second budget (`maxDuration = 60`) — how it stays inside:**

- Data: one paginated read of `charge_reconciliation` (~ms). No `.in()` id-list URLs at all — the view does the joins. This alone removes the 414/1000-row exposure at `route.ts:63` and `append-receipts.ts:65`.
- **`appendix=send` is the default and appends only §3 receipts** (matched-but-not-sent). Already-sent receipts are **listed, never embedded** — he already sent those files to his accountant, so re-embedding them is pure cost. This is what makes a whole-history report tractable: the appendix is bounded by "what I still owe", not "everything I ever matched".
- `appendix=none` → table only, always returns, never times out. Offer it as a visible second button "Work list only (fast)".
- Hard caps in `lib/reports/append-receipts.ts`: add `APPENDIX_MAX_RECEIPTS = 40` and a `deadline` param. Before each embed, `if (Date.now() > deadline) break;` with `deadline = t0 + 42_000`. Existing `MAX_EMBED_BYTES = 25MB` / `MAX_PAGES_PER_RECEIPT = 20` / `DOWNLOAD_CONCURRENCY = 5` stay.
- When capped, print a final page: *"38 further receipts were not embedded. Re-run with a statement filter to include them."* — partial output beats a 504.
- Appendix labels become `#12 · 2026-04-22 · PriceSmart · TTD 1,240.00` — unambiguous across statements (fixes `route.ts:121`).

**Verify:** generate with `all=1`. Check the §1 count equals the `genuinely_new` tile on `/matching`; check a known carried-over charge appears exactly once, in §4, with both statement names; check the grand total equals `select sum(amount) from charge_reconciliation`.

---

## STEP 10 — Ingest hardening (`app/api/statements/parse/route.ts`, `lib/extraction/parse-statement.ts`)

Small but it protects everything above.

- **Validate dates before insert**: drop/flag any `t.date` failing `/^\d{4}-\d{2}-\d{2}$/` and `Date.parse`, so one bad string cannot fail the whole batch (`route.ts:121-128`) and leave a 0-transaction statement.
- **Insert in chunks of 200** with per-chunk error capture, and report partial success.
- **Derive the period** after insert: `period_start = coalesce(parsed.period_start, min(txn_date))`, `period_end = coalesce(parsed.period_end, max(txn_date))`; swap if start > end. Move the `statements.update` (currently at `:69-76`, *before* the confirmed-match guard at `:78-101`) to **after** the guard so period and rows can no longer diverge.
- `resolveMediaType(blob.type, statement.file_name)` instead of `resolveMediaType(null, ...)` at `:46`.
- Return `{ ok: false }` when `transactions.length === 0` so the uploader shows a real failure instead of a green "0 transactions" badge (`statement-uploader.tsx:152-156`).
- On parse failure, delete the orphan `statements` row + storage object.
- Normalise `parsed.card_last4` with the `/^\d{4}$/` guard **before** the `cards` lookup at `:59-67`, and scope it `.eq("user_id", user.id)`.

**Verify:** re-upload a statement you already reconciled. The parse guard keeps the transactions; the charges re-attach; `/matching` is unchanged; nothing goes back to MISSING.

---

## STEP 11 — `deleteStatement` guard (`lib/statements/actions.ts:21`)

With Step 2 the cascade damage is already mostly gone (`statement_transaction_id` is now `on delete set null`, and the match keeps `charge_id` + snapshot). Finish it:

- Before delete, count confirmed matches on that statement's transactions. If > 0, require an explicit confirmation naming the count: *"This will remove 42 transactions. 42 confirmed receipt matches will be kept but will no longer show a statement line."*
- Destructure `{ error }` on both the storage remove and the delete (currently discarded).
- Preferred: add `statements.archived_at` and soft-delete instead, excluding archived from `statement_coverage`. Fully reversible.

---

## SAFE ROLLOUT SUMMARY (requirement 7)

**What the backfill actually does:**
1. Inserts one `charges` row per distinct real-world charge, oldest-first (Step 1). Writes `statement_transactions.charge_id`. **Touches nothing else.**
2. Copies `charge_id` + a provenance snapshot onto existing `receipt_statement_matches` rows (Step 2). **Does not change `confirmed`, `receipt_id`, `status`, or any receipt.**
3. Recomputes `statement_transactions.is_matched` from the confirmed matches — this *corrects* existing drifted values, which is the point.
4. Fills `statements.period_start/period_end` where NULL from min/max `txn_date` (Step 3). Only fills NULLs.

**Can an existing confirmed match be invalidated or re-pointed?**
- **Re-pointed: never.** `receipt_id` and `statement_transaction_id` are never rewritten.
- **Invalidated: only in one case**, detected by pre-flight query 0c — two *different* receipts already confirmed against what is now one charge. `rsm_unique_confirmed_charge` cannot coexist with that. The remedy is a **demotion to `confirmed = false, status = 'needs_review'`** on the later row — it stays in the table, reappears in "Needs your confirmation", and he re-decides. **Nothing is deleted.**
- The only genuinely row-deleting statement in the whole plan is the 0d cleanup of duplicate *unconfirmed* suggestion rows, and it runs only if 0d returns rows.

**Loudly flagged as data-changing:**
- `rsm_unique_confirmed_charge` demotion (Step 2) — mitigated by `rsm_backup_pre_0015` and by demoting rather than deleting.
- 0d duplicate-suggestion cleanup (Step 2) — mitigated by the same backup.
- `is_matched` recompute (Step 2) — overwrites a stored column; it is derived from now on, so this is a correction, not a loss.
- Everything else is additive and reversible with `update statement_transactions set charge_id = null; truncate charges cascade;` plus dropping the new columns.

**How he verifies nothing was lost** — run after each of Steps 1, 2, 3:
```sql
select
  (select count(*) from receipt_statement_matches where confirmed)  as confirmed_now,
  (select count(*) from rsm_backup_pre_0015 where confirmed)        as confirmed_before,
  (select count(*) from receipts where sent)                        as sent_now,
  (select count(*) from statement_transactions)                     as txns_now,
  (select count(*) from statement_transactions where charge_id is null) as unassigned;
-- confirmed_now == confirmed_before (minus any 0c demotions, which you counted)
-- sent_now and txns_now identical to Step 0a. unassigned = 0.

-- End-to-end: the totals must reconcile.
select (select sum(amount) from charge_reconciliation)      as charges_total,
       (select sum(amount) from statement_transactions)     as raw_line_total;
-- raw_line_total >= charges_total. The difference is precisely the
-- double-counting that was inflating every report.
```

---

## STEP ORDER, AND WHY

| # | Deliverable | App state after |
|---|---|---|
| 0 | Pre-flight queries + backups | unchanged |
| 1 | `0014` charges + trigger + backfill | unchanged, works |
| 2 | `0015` match durability, unique-on-charge, derived `is_matched` | works, `is_matched` now truthful |
| 3 | `0016` settings + period backfill + `statement_coverage` | works |
| 4 | `0017` `charge_reconciliation` view | works, four states queryable |
| 5 | `lib/reconciliation/*` data layer | works, unused |
| 6 | consolidated `/matching` default + nav | **his primary ask lands here** |
| 7 | `runConsolidatedMatching`, upsert, rejection memory, no auto-confirm | one global pass |
| 8 | `match.ts` hardening | fewer false matches |
| 9 | consolidated PDF | printable work list |
| 10 | ingest hardening | future statements clean |
| 11 | delete guard | can't lose work |

Steps 1–5 are invisible to him; **Step 6 is the first one he sees**, and by then the data underneath is already correct. Steps 7–9 can each ship independently.

**Files created:** `supabase/migrations/0014_charge_identity.sql`, `0015_match_durability.sql`, `0016_reconciliation_settings.sql`, `0017_charge_reconciliation_view.sql`; `lib/reconciliation/{types,paginate,scope,charges}.ts`; `app/api/reports/reconciliation/route.ts`; `lib/reports/reconciliation-report-document.tsx`; `components/ui/submit-button.tsx`; `lib/matching/match.test.ts`.

**Files changed:** `app/(app)/matching/page.tsx`; `lib/matching/actions.ts`; `lib/matching/match.ts`; `lib/types.ts` (add `UserSettings` fields, `ChargeRow`); `components/settings/settings-form.tsx` + `lib/settings/actions.ts` + `app/(app)/settings/page.tsx` (four new settings); `components/app-shell/nav.ts`; `lib/reports/append-receipts.ts` (deadline + cap); `app/api/statements/parse/route.ts`; `lib/statements/actions.ts`; `lib/receipts/actions.ts` (`revalidatePath("/matching")` in `setReceiptsSent`).