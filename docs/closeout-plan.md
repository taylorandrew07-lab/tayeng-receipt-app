# CLOSE-OUT PLAN — the revised reconciliation implementation plan

Written to `c:/Users/Andrew/OneDrive/Documents/Tayeng Receipt App/tayeng-app/docs/close-out-plan.md`.

**Supersedes `docs/reconciliation-plan.md` Steps 5–11 and cancels Step 4c.** Steps 1–4 (migrations `0014`–`0017`) are built and applied and are not redone. Note the old plan's migration names/numbers are wrong — it calls the backup table `rsm_backup_pre_0015`; the real table is `rsm_backup_pre_0016` (`0016_match_durability.sql:14-15`). Where the two disagree, this document wins.

---

# 1. THE MODEL

## 1.1 In plain language

**The app keeps one list of things that are not finished, and the job is to get that list to zero.**

Two kinds of thing are on the list:

1. **A charge with no receipt.** A real purchase on a statement we have no paperwork for.
2. **A receipt with no charge.** Paperwork that appears on no statement (cash, another card, or the statement isn't uploaded yet).

The screen shows one number — **"18 open · TTD 11,648.69"** — and it only goes down, and only for a stated reason.

An item leaves the list exactly four ways, all recorded, reversible and attributed:

| How it closes | Where that is stored |
|---|---|
| **Matched** — a receipt was attached to the charge | `receipt_statement_matches.confirmed`, anchored to `charge_id` (`0016_match_durability.sql:18`) |
| **Sent** — already given to the accountant | `receipts.sent` (`0006_sent_flag.sql`) |
| **No receipt needed** — bank fee, interest, payment to the card | `charges.no_receipt_expected` (`0015_charge_identity.sql:50`) + `closed_reason` |
| **No charge expected** — cash, personal, accountant handles it, written off | `receipts.no_charge_expected` (**new** — this column does not exist, which is why the count can never currently reach zero) |

**A charge is a real-world purchase, not a line on a statement.** Already true in the database: `charges` (`0015:41-53`) gives each real charge one identity across overlapping statements. Live data: 90 statement lines collapse to **64 real charges**; 24 appear on two or more statements; one on three. Raw line totals read TTD 42,920.49; the real figure is TTD 30,583.05 — inflated by TTD 12,337.44 (29%). Fifteen lines were reported "missing receipt" when the charge already had one, and twelve of those had already been sent to the accountant.

So: **upload as many statements as you like, in any order, overlapping as much as they like. They merge into one list. Anything already crossed off stays crossed off.**

## 1.2 The ruling on month scoping

**Month is removed as an organising axis. Step 4c is cancelled. `reconciliation_months` is dropped.**

- No `?month=YYYY-MM`. No month picker. No `dateFrom`/`dateTo` on the close-out surface.
- Migration `0019` issues `drop view if exists reconciliation_months;`. That view (`0017_reconciliation_views.sql:126-146`) is applied but **has zero consumers** — grep across `app/`, `lib/`, `components/` returns no query against it. Dropping it costs one line and breaks nothing. It is dropped rather than commented as deprecated because a `comment on view` is exactly as visible as nothing to someone grepping for `month` in six months.
- The `/reports` monthly report and `receipts.month_key` are **not touched**.

### Justifying this against *both* things Andrew said

He asked for a month view earlier. He now says *"take away this sort of monthly rules... make it more about closing out all the outstanding receipts from the statements."* These are not equal opinions to split, because the month axis fails on correctness, not taste:

1. **The month a receipt is filed under is the month it was uploaded, not the month it was spent.** `receipts.month_key` is set from upload time (migration `0004`; `app/api/receipts/extract/route.ts:132` passes `uploadedAt: new Date(receipt.created_at)`). **62 of 82 receipts are filed under a `month_key` that differs from their `receipt_date`.** All four statements were uploaded on one day. A "July" view would show every May charge.
2. **A month filter hides the receipt that closes the charge.** The candidate window is deliberately 60 days before and 15 days after (`0014_reconciliation_settings.sql:16-19`) because the receipt for a 30 May charge is routinely dated in April or June. Scoping a *matching* surface to a calendar month removes the correct answer from the screen. This is decisive.
3. **The app already committed to outstanding-first and it worked.** `app/api/reports/generate/route.ts:36-37` defaults the reimbursable report to `scope=outstanding` — `reimbursable = true AND paid = false`, **no month filter** — with the code comment explaining `month_key` is the upload month. Keeping a month lens on reconciliation would mean two competing definitions of "done".

**Dates do not disappear. They stop being a scope and become a sort and a label.** Oldest-open-first, age badges ("open 94 days"). The close-out PDF prints its real period from `statement_coverage.effective_start/effective_end` (`0014:51-65`) — the first ever consumer of that view — and says so where the period was inferred (two live statements parsed with `period_start IS NULL`).

---

# 2. SCHEMA CHANGES

Two migrations. `0018` exists solely because Postgres cannot *use* an enum value in the transaction that *adds* it, and the Supabase CLI wraps each file in one transaction.

## 2.1 `0018_rule_type_values.sql` — **ADDITIVE**

```sql
-- ============================================================================
-- 0018_rule_type_values.sql
--
-- Two new learning_rules kinds. ALONE IN THIS FILE ON PURPOSE: Postgres cannot
-- USE a newly added enum value in the same transaction that ADDS it, and the
-- Supabase CLI runs each migration file inside one transaction. Anything that
-- references these values must live in 0019 or later.
--
-- PURELY ADDITIVE. Adds two values to an existing enum. Changes no rows.
-- ============================================================================

alter type rule_type add value if not exists 'vendor_alias';
alter type rule_type add value if not exists 'line_kind';
```

`rule_type` today is `('vendor_category','last4_card','vendor_payment')` (`0001_initial_schema.sql:28-30`). `vendor_payment` exists and is never written or read — untouched.

**Verify:**
```sql
select unnest(enum_range(null::rule_type));
-- expect: vendor_category, last4_card, vendor_payment, vendor_alias, line_kind
```

## 2.2 `0019_close_out.sql` — **MIXED. Read every section header.**

Nine labelled sections. A–D and H–J additive. E, F, G **change existing rows**; each takes a backup or is scoped so no human decision can be overwritten.

### Section A — backups first (**ADDITIVE**)

```sql
-- Mirrors the 0016 precedent (0016_match_durability.sql:14-15). Keep both until
-- a full close-out cycle has been completed, then drop.
create table if not exists charges_backup_pre_0019 as select * from charges;
create table if not exists stmt_txn_backup_pre_0019 as select * from statement_transactions;
```

### Section B — receipt-side closure (**ADDITIVE**)

The missing half of the checklist. 43 receipts have no statement line; **27 are unsent, worth TTD 11,648.69**, and most will never have a statement line. Without a way to close a receipt the open count can never reach zero and the whole model fails.

```sql
alter table receipts
  add column if not exists no_charge_expected boolean not null default false,
  add column if not exists closed_at          timestamptz,
  add column if not exists closed_reason      text
    check (closed_reason is null or closed_reason in
      ('cash_no_receipt','personal','accountant_handles','written_off','duplicate','other'));

create index if not exists receipts_open_idx
  on receipts (user_id, no_charge_expected, sent) where duplicate_of is null;
```

### Section C — the match-relevant receipt fingerprint (**ADDITIVE**, rewrites the table)

Used for exactly one thing: invalidating a stale *rejection* (§4.4). It deliberately excludes `sent`, `paid`, `notes`, `category_id`, `status`, `duplicate_of` and `month_key` — none change any score, all change for unrelated reasons. `receipts.updated_at` cannot substitute: its trigger (`0001_initial_schema.sql:159-161`) fires on every UPDATE including `setReceiptsSent` (`lib/receipts/actions.ts:259-268`), so bulk-sending 27 orphans would bump 27 timestamps that have nothing to do with matching.

```sql
-- Vendor normalisation is byte-identical to charge_key_of (0015:26) and to
-- normalizeVendor() (lib/classification/classify.ts:11-16). Do not diverge.
-- (date - epoch)::text is used because date::text and to_char() are STABLE,
-- not IMMUTABLE, and a generated column requires IMMUTABLE.
create or replace function receipt_fingerprint_of(
  p_receipt_date date, p_vendor_name text, p_ttd_amount numeric,
  p_amount numeric, p_currency text, p_card_last4 text
) returns text language sql immutable as $$
  select coalesce((p_receipt_date - date '1970-01-01')::text, '')
      || '|' || coalesce(round(p_ttd_amount, 2)::text, '')
      || '|' || coalesce(round(p_amount, 2)::text, '')
      || '|' || upper(coalesce(nullif(btrim(p_currency), ''), 'TTD'))
      || '|' || coalesce(p_card_last4, '')
      || '|' || btrim(regexp_replace(lower(coalesce(p_vendor_name, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

alter table receipts
  add column if not exists match_fingerprint text
  generated always as (receipt_fingerprint_of(
    receipt_date, vendor_name, ttd_amount, amount, currency, card_last4)) stored;
```

> **No charge-side fingerprint is created.** A charge's `description`, `amount`, `currency` and `card_last4` *are* its `charge_key` and are immutable for a given charge by construction (`0015:23-30`); `anchor_date` is the only mutable field and can only move earlier (`0015:124`). A charge fingerprint would be a second source of truth with nothing to say.

### Section D — decision durability, sweep, attribution (**ADDITIVE**)

```sql
alter table receipt_statement_matches
  -- The receipt evidence a REJECTION was made against. If the receipt is later
  -- edited, the fingerprint goes stale and the rejection stops applying.
  add column if not exists rejected_fingerprint text,
  -- Stamped by every run that regenerated this suggestion. Lets a run sweep its
  -- own stale output without delete-then-insert, so created_at survives.
  add column if not exists last_seen_run_at     timestamptz,
  add column if not exists decided_via          text
    check (decided_via is null or decided_via in
      ('auto','user','attach','drag','tap','keyboard','suggestion'));

create index if not exists rsm_rejected_idx
  on receipt_statement_matches (user_id) where rejected_at is not null;
create index if not exists rsm_open_pair_idx
  on receipt_statement_matches (charge_id) where not confirmed and rejected_at is null;

-- Existing rejections: there are none, because rejectMatch has always DELETEd
-- (lib/matching/actions.ts:202). Written anyway so the migration is correct if
-- that ever changed. IS NOT DISTINCT FROM is used in the suppression predicate,
-- so a NULL fingerprint must never silently equal a real one.
update receipt_statement_matches m
set rejected_fingerprint = r.match_fingerprint
from receipts r
where r.id = m.receipt_id and m.rejected_at is not null and m.rejected_fingerprint is null;
```

### Section E — charge-side closure, the line taxonomy, and direction (**DATA-CHANGING**)

`text` + `check`, not enums — `0018` has already demonstrated what a new enum value costs.

```sql
alter table statement_transactions
  add column if not exists line_kind   text not null default 'purchase',
  add column if not exists direction   text not null default 'debit',
  add column if not exists kind_source text not null default 'default',
  add column if not exists model_kind  text,   -- what the parser said, kept even when overridden
  add column if not exists raw_line    text;   -- verbatim printed line, for audit

alter table charges
  add column if not exists line_kind     text not null default 'purchase',
  add column if not exists direction     text not null default 'debit',
  add column if not exists kind_source   text not null default 'default',
  add column if not exists kind_note     text,          -- Andrew's own words
  add column if not exists kind_set_at   timestamptz,
  add column if not exists closed_at     timestamptz,
  add column if not exists closed_by     text check (closed_by is null or closed_by in ('user','auto')),
  add column if not exists closed_reason text
    check (closed_reason is null or closed_reason in
      ('bank_noise','card_payment','not_a_transaction','cash_no_receipt',
       'personal','accountant_handles','written_off','duplicate','other'));

alter table statement_transactions
  add constraint stmt_txn_line_kind_ck check (line_kind in
    ('purchase','fee','interest','card_payment','refund','reversal',
     'adjustment','balance_summary','unknown')),
  add constraint stmt_txn_direction_ck check (direction in ('debit','credit')),
  add constraint stmt_txn_kind_source_ck check (kind_source in
    ('default','model','pattern','rule','user')),
  -- Magnitude lives in amount, sign lives in direction. Enforced, not hoped for:
  -- amount numeric(14,2) has never had a check (0001:203) and the insert filter
  -- at app/api/statements/parse/route.ts:110 only tests non-null.
  add constraint stmt_txn_amount_nonneg check (amount is null or amount >= 0);

alter table charges
  add constraint charges_line_kind_ck check (line_kind in
    ('purchase','fee','interest','card_payment','refund','reversal',
     'adjustment','balance_summary','unknown')),
  add constraint charges_direction_ck check (direction in ('debit','credit')),
  add constraint charges_kind_source_ck check (kind_source in
    ('default','model','pattern','rule','user'));
```

**Why `direction` and not a negative `amount`.** Three verified reasons: (1) `charge_key_of` rounds `amount` into the key (`0015:26-27`), so a signed refund keys differently but then smears its sign through every existing `sum()`; (2) `amountScore` computes `Math.abs(txn - receipt) / Math.max(...)` (`lib/matching/match.ts:47-53`), so −224.70 against a +224.70 receipt is a 200% difference → score 0 → `scorePair` returns 0 at `:81`, and the line would be permanently unmatchable and permanently on the chase list **with no error anywhere**; (3) a negative can already be stored today, so the invariant needs enforcing regardless.

**Why one boolean was never enough.** `no_receipt_expected` (`0015:50`) is asked to mean three incompatible things. A **fee** is real spend that counts in the accountant's total but can never have a receipt. A **payment to the card** is not spend at all and must be excluded. A **refund** is negative spend that must offset the total. `line_kind` carries that; `no_receipt_expected` stays as the user-facing "stop asking me" flag that `charge_reconciliation` already reads.

### Section F — classification: `norm_desc`, `noise_key_of`, `classify_line_kind` (**DATA-CHANGING**)

Full pattern lists in **§4.2**. The functions:

```sql
-- SPACE-PADDED so every pattern matches WHOLE TOKENS only. This is the fix for
-- 0015_charge_identity.sql:38, whose alternation contains a bare unanchored
-- 'interest': 'PINTEREST ADS' normalises to 'pinterest ads', contains the
-- substring 'interest', and is silently set no_receipt_expected AND
-- fee_auto_flagged at 0015:120. A real advertising spend disappears.
create or replace function norm_desc(p text) returns text language sql immutable as $$
  select ' ' || btrim(regexp_replace(lower(coalesce(p,'')), '[^a-z0-9]+', ' ', 'g')) || ' ';
$$;

-- The CORRECTION key. Strips pure-number tokens so ONE correction generalises:
--   'OVERLIMIT FEE 45.00' -> 'overlimit fee'
--   'OVERLIMIT FEE 60.00' -> 'overlimit fee'   (same rule now applies)
--
-- *** NEVER feed noise_key into charge_key_of(). *** charge_key_of (0015:23-30)
-- deliberately keeps the full description so STAR PETROL 112 ROBERTS S and
-- STAR PETROL 45 EASTERN M stay two DIFFERENT charges. Collapsing them there
-- would silently delete real work and defeat Guard 1 (0015:103-108).
create or replace function noise_key_of(p text) returns text language sql immutable as $$
  select btrim(regexp_replace(
           regexp_replace(btrim(regexp_replace(lower(coalesce(p,'')),'[^a-z0-9]+',' ','g')),
                          '\y[0-9]+\y', ' ', 'g'),
           '\s+', ' ', 'g'));
$$;

create or replace function classify_line_kind(p_description text, p_model_kind text)
returns text language sql immutable as $$ /* full body in §4.2.3 */ $$;

-- Backward compatibility. Nothing in app code reads this today (verified: zero
-- hits for is_fee_description across *.ts/*.tsx), but 0015's trigger did.
create or replace function is_fee_description(p_description text)
returns boolean language sql immutable as $$
  select classify_line_kind(p_description, null) not in ('purchase','unknown');
$$;

-- Queryable correction key. noise_key_of is IMMUTABLE so a STORED generated
-- column is legal, which lets the app do .eq("noise_key", key) from PostgREST.
-- The codebase has zero RPC usage; this avoids introducing the first one.
alter table charges
  add column if not exists noise_key text generated always as (noise_key_of(description)) stored;
create index if not exists charges_noise_key_idx on charges (user_id, noise_key);
```

**Backfill (DATA-CHANGING), with before/after reporting:**

```sql
do $$
declare before_flagged int; after_flagged int; unflagged int;
begin
  select count(*) into before_flagged from charges where no_receipt_expected;

  update statement_transactions
  set line_kind = classify_line_kind(description, null),
      direction = case when classify_line_kind(description, null)
                       in ('card_payment','refund','reversal') then 'credit' else 'debit' end,
      kind_source = 'pattern'
  where kind_source = 'default';

  update charges c
  set line_kind = classify_line_kind(c.description, null),
      direction = case when classify_line_kind(c.description, null)
                       in ('card_payment','refund','reversal') then 'credit' else 'debit' end,
      kind_source = 'pattern',
      -- This can UNSET a wrong flag (e.g. a description containing 'interest'
      -- as a substring). That is the point.
      no_receipt_expected = classify_line_kind(c.description, null) not in ('purchase','unknown'),
      fee_auto_flagged    = classify_line_kind(c.description, null) not in ('purchase','unknown'),
      closed_at     = case when classify_line_kind(c.description, null)
                                not in ('purchase','unknown') then now() end,
      closed_by     = case when classify_line_kind(c.description, null)
                                not in ('purchase','unknown') then 'auto' end,
      closed_reason = case classify_line_kind(c.description, null)
                        when 'fee' then 'bank_noise' when 'interest' then 'bank_noise'
                        when 'card_payment' then 'card_payment'
                        when 'balance_summary' then 'not_a_transaction'
                        else null end
  where c.kind_source = 'default';

  select count(*) into after_flagged from charges where no_receipt_expected;
  select count(*) into unflagged from charges
    where not no_receipt_expected
      and id in (select id from charges_backup_pre_0019 where no_receipt_expected);

  raise notice '0019 classification: no_receipt_expected % -> % (% previously-flagged charges UNFLAGGED)',
    before_flagged, after_flagged, unflagged;
end $$;
```

**Verify:**
```sql
select line_kind, count(*), sum(amount) from charges group by 1 order by 2 desc;
-- Expect 'fee' to contain OVERLIMIT FEE 45.00.
select description, line_kind, kind_source from charges where line_kind <> 'purchase' order by 2;
-- Eyeball every row. If anything here is a real merchant, the regex over-matched.
```

### Section G — `assign_charge()` rewritten (**DATA-CHANGING behaviour; the DDL touches no rows**)

Replaces `0015:83-135`. Changes, in order:

1. **Resolve the kind by precedence.** `learning_rules` where `rule_type = 'line_kind'` and `pattern = noise_key_of(new.description)` and `user_id = new.user_id` → `kind_source='rule'`; else `classify_line_kind(new.description, new.model_kind)` → `'pattern'`; else `new.model_kind` → `'model'`; else `'purchase'` → `'default'`. **This lookup lives here, not in `classify_line_kind`, because that function is `IMMUTABLE` and cannot read tables.** RLS is satisfied: the trigger runs as the inserting user and `learning_rules_all_own` is `auth.uid() = user_id and public.is_approved()` (`0002_rls_policies.sql:95-98`, tightened `0008_enforce_approval.sql:70-72`).
2. **Apply Tier 4b** (§4.2.3): an *ambiguous* payment description is upgraded to `card_payment` **only when `new.direction = 'credit'`**.
3. **Resolve direction:** the parser's value if present, else the kind's natural direction.
4. **Widen the charge lookup predicate** at `0015:94-110` with `and c.direction = v_direction`, so a purchase and its refund can never merge. **`charge_key` is untouched and `line_kind` stays out of the predicate**, so reclassifying a line never fragments charge identity.
5. **On charge creation** (`0015:113-122`) set `line_kind`, `direction`, `kind_source`, and derive the legacy booleans so the existing view keeps working: `no_receipt_expected := v_kind not in ('purchase','unknown')`, `fee_auto_flagged := (v_source <> 'user')`.

`unknown` is chased. Failing safe means showing noise, and showing noise is the cheaper error.

### Section H — views (**replaces two views that nothing reads yet**)

Both `charge_reconciliation` and `orphan_receipts` are safe to `create or replace` because **no file in the codebase queries either one** (verified by grep across `app/`, `lib/`, `components/`).

`charge_reconciliation` — everything at `0017:17-82` kept; appended to the outer select, and the `state` CASE reordered:

```sql
  a.line_kind, a.direction, a.kind_source, a.noise_key, a.charge_created_at,
  a.closed_at, a.closed_by, a.closed_reason,
  coalesce(cm.paid, false) as receipt_paid,   -- cm already selects r.paid at 0017:47
                                              -- and the outer select drops it
  case when a.direction = 'credit' then -a.amount else a.amount end as signed_amount,
  (a.line_kind not in ('card_payment','balance_summary'))            as counts_as_spend,
  (cm.receipt_id is null
     and a.closed_at is null
     and not a.no_receipt_expected
     and a.line_kind in ('purchase','unknown'))                      as is_open,
  case
    when cm.receipt_id is not null and cm.sent then 'already_sent'
    when cm.receipt_id is not null             then 'already_matched'
    when a.no_receipt_expected                 then 'no_receipt_expected'
    when coalesce(pm.pending_count,0) > 0      then 'needs_confirmation'
    else                                            'genuinely_new'
  end as state
```

> **The reorder is a real bug fix.** Today `no_receipt_expected` is evaluated *first* (`0017:74`), ahead of `already_sent` and `already_matched`. A charge wrongly flagged as a fee that in fact has a confirmed, already-sent receipt renders as "no receipt expected" and the receipt disappears from view entirely. Only *confirmed* evidence outranks the flag; a stale pending suggestion does not. Affects zero rows in current live data — which is exactly why to fix it now rather than discover it later.

`orphan_receipts` — everything at `0017:96-111` kept; filter widened, columns appended:

```sql
where r.duplicate_of is null
  and r.status in ('confirmed','needs_review')      -- was: = 'confirmed'  (0017:108)
  and not exists (select 1 from receipt_statement_matches m
                  where m.receipt_id = r.id and m.confirmed)
-- appended columns:
  (r.status = 'needs_review')                            as needs_review,
  r.created_at, r.doc_type,
  r.no_charge_expected, r.closed_at, r.closed_reason,
  (not r.no_charge_expected and r.closed_at is null and not r.sent) as is_open
```

> **Widening `status` is the other real bug fix.** As applied, a receipt still in `needs_review` is invisible to reconciliation entirely — and those are precisely "receipts that have not been processed since the last time." Surfaced with a `needs_review` badge so they read as needing attention, not ready-to-match.

And:

```sql
-- Month is not an axis. Zero consumers; see §1.2.
drop view if exists reconciliation_months;
```

### Section I — statement completeness and honesty (**ADDITIVE**)

```sql
alter table statements
  add column if not exists printed_purchases_total numeric(14,2),
  add column if not exists printed_payments_total  numeric(14,2),
  add column if not exists printed_closing_balance numeric(14,2),
  -- 0014_reconciliation_settings.sql:33-40 backfilled NULL periods from txn
  -- dates without recording that it had done so. Two live statements parsed
  -- with period_start IS NULL. A report header must never print an inferred
  -- period as if it had been read off the document.
  add column if not exists period_inferred boolean not null default false;
```

`period_inferred` **cannot be derived after the fact** — `0014` overwrote the NULLs without a record. **Do not guess.** Leave existing rows `false`, and have Step 11's UI show *"period not verified"* for any statement where `printed_closing_balance is null` — true for all four existing statements, and the honest signal.

### Section J — settings scalars (**ADDITIVE**)

```sql
alter table user_settings
  add column if not exists last_reconcile_run_at  timestamptz,
  add column if not exists last_reconcile_seen_at timestamptz;
```

Two scalars, no run-log table. They must be **separate**: a run fired automatically after a statement parse would otherwise clear Andrew's NEW badges before he ever looked at them.

## 2.3 What is deliberately NOT in the schema

- **No `reconciliation_runs` table.** Its own design concedes the watermark is advisory and correctness never depends on it. A table correctness never depends on exists only to power run-history screens Andrew did not ask for. `decided_via` + two scalars deliver attribution and the "new since" lens with zero new tables.
- **No `open_items` or `ledger_summary` view.** `charge_reconciliation` and `orphan_receipts` both now carry `is_open`; the header count is two `count(*)`s in `lib/reconciliation/`. Two views nothing reads do not need a third and fourth wrapped around them.
- **No `vendor_aliases` table.** `learning_rules` already has `unique(user_id, rule_type, pattern)` (`0001:260`), an `action jsonb` (`0001:256`), a never-incremented `hit_count` (`0001:257`) purpose-built for ranking, and `learning_rules_user_idx (user_id, rule_type)` (`0001:262`).
- **No cached scores, no `ALGO_VERSION`, no `last_matched_at` cursor.** §4.4.
- **`pg_trgm` is not enabled and nothing may assume it.** Grep for `create extension` across `supabase/migrations/` returns zero hits.
- **`vendors` is not the canonical alias target.** Defined (`0001:107-118`) with a perfect-looking `unique(user_id, normalized_name)`, but **no code ever writes it** — the only reference anywhere is `vendor_id` in a select list at `app/(app)/receipts/page.tsx:38`. It is a dead table.

---

# 3. THE STEPS

Ten steps. **The app works after every one.** Andrew sees the first real payoff at Step 7 and the count can reach zero at Step 8.

## Step 5 — Safety rails (half a day, small but visible)

Nothing else ships first. The moment a persistent count goes on screen, the app promises **the number only ever changes for a stated reason** — and `deleteStatement` currently breaks that promise silently.

**Changed:**
- `lib/statements/actions.ts:7-26` — `deleteStatement` discards `{ error }` on both the storage `remove()` (`:18`) and the `delete()` (`:21`), and carries the comment *"statement_transactions + matches cascade-delete via FK"* at `:20` which has been **false since `0016_match_durability.sql:31-36` changed `statement_transaction_id` to `ON DELETE SET NULL`.** Rewrite: count confirmed matches on this statement's charges; if > 0 return `{ ok:false, message:"This statement has N confirmed receipt matches. Deleting it will not delete them, but the charges will leave your list. Type DELETE to confirm." }`; check `{ error }` on both calls and surface it.
- `components/delete-button.tsx` — accept the typed result and show it.

**New:**
- `package.json` — `vitest` devDependency, `"test": "vitest run"`. There is no test runner and no `*.test.*` file in the repo, and `lib/matching/match.ts` is about to be substantially rewritten.
- `lib/reconciliation/paginate.ts` — `fetchAll<T>(build: (from:number,to:number) => PostgrestFilterBuilder<T>): Promise<T[]>`, 1000-row pages. Every unbounded query (`lib/matching/actions.ts:22,30,43`; `app/(app)/matching/page.tsx:40,49,100,107`; `app/api/reports/statement/route.ts:49,59`; `lib/reports/append-receipts.ts:62`) routes through it as it is touched. **Load-bearing for §4.1:** building the IDF corpus from a truncated 1,000-row page would silently change every vendor score.

**After this step Andrew can:** delete a statement and be told what it will cost, instead of silently stranding twelve confirmed matches.
**Verify:** delete a statement with confirmed matches; the dialog names the count. `npm test` runs and reports 0 tests.

## Step 6 — Migrations `0018` and `0019` (one day, invisible)

Apply §2. Run every verification query and paste the output into the PR.

**After this step Andrew can:** nothing new — but fee/payment lines are already classified and closed, receipt-side closure columns exist, and the two views are correct. **This is the only invisible step and it is one day.**
**Verify:** `select count(*) from charge_reconciliation where is_open` ≈ 64 minus fees minus already-matched. `select count(*) from orphan_receipts where is_open` should be **27**.

## Step 7 — The close-out list at `/reconcile` (read-only) — **FIRST VISIBLE WIN**

One merged list across every statement, counted once, correct totals, bank noise already gone.

**New:**
- `lib/reconciliation/types.ts` — `ChargeRow`, `OrphanRow`, `OpenCounts`, `CloseReason`.
- `lib/reconciliation/board-data.ts` — `loadCloseOut(supabase)`:

```ts
// Three queries in parallel. RLS scopes to the user, so no .in(...) built from
// 64 uuids — that unbounded-URL pattern is the bug at matching/page.tsx:49,74.
const chargesQ = supabase.from("charge_reconciliation")
  .select("charge_id, txn_date, description, amount, currency, card_last4, canonical_txn_id, " +
          "copies, is_duplicate, statement_names, state, line_kind, direction, kind_source, " +
          "closed_at, closed_by, closed_reason, no_receipt_expected, fee_auto_flagged, " +
          "signed_amount, counts_as_spend, is_open, charge_created_at, " +
          "receipt_id, receipt_vendor, receipt_date, receipt_amount, receipt_currency, " +
          "receipt_sent, receipt_paid, pending_count, best_confidence, match_id")
  .order("txn_date", { ascending: true, nullsFirst: false })
  .order("charge_id", { ascending: true });          // deterministic tiebreak

const receiptsQ = supabase.from("orphan_receipts")
  .select("receipt_id, receipt_date, vendor_name, ttd_amount, amount, currency, card_last4, " +
          "sent, sent_at, paid, needs_review, possible_duplicate_upload, " +
          "no_charge_expected, closed_at, closed_reason, is_open, created_at, pending_count")
  .order("receipt_date", { ascending: true, nullsFirst: false })
  .order("receipt_id", { ascending: true });

const suggestionsQ = supabase.from("receipt_statement_matches")
  .select("id, charge_id, receipt_id, confidence")
  .eq("confirmed", false).is("rejected_at", null).not("charge_id", "is", null)
  .order("confidence", { ascending: false });
```

- `app/(app)/reconcile/page.tsx` — header **"18 open · TTD 11,648.69"** over a progress bar *"closed 46 of 64"*; the completeness line (Step 11 fills it; until then *"statement totals not read — can't verify this list is complete"*); filter chips **All open** (default) · Needs a receipt · Suggested (n) · Receipt with no statement line · Closed; then a single flat list, **oldest first, no statement grouping, no month grouping**. Each row: bold right-aligned amount, description/vendor, date, age badge ("open 94 days"), an `on 3 statements · counted once` chip where `copies > 1`, and a `NEW` dot where `charge_created_at > last_reconcile_seen_at`.
- Foot of the list: two collapsed strips, always on screen and never a filter — **"🏦 Bank charges — nothing to chase · 5 · TTD 312.00"** and **"Payments & credits — not spending · 2 · −TTD 5,000.00"**.
- `components/reconcile/open-row.tsx`, `components/reconcile/summary-header.tsx`.

**Changed:** `components/app-shell/nav.ts:19` — `{ href:"/matching", label:"Matching", icon:"🔗" }` becomes `{ href:"/reconcile", label:"Close-Out", icon:"✅" }`. `/matching` stays reachable and working; retired at Step 14.

**After this step Andrew can:** open one screen and see the true number of outstanding items and the true total across all four statements — TTD 30,583.05 rather than 42,920.49 — with the 24 carried-over charges counted once and bank fees already off the list.
**Verify:** header total matches `select sum(amount) from charge_reconciliation where counts_as_spend`. The 15 falsely-missing lines no longer appear as missing. The 27 unsent orphans appear.

## Step 8 — The closing moves + undo — **THE COUNT CAN NOW REACH ZERO**

**New:** `lib/reconciliation/actions.ts`

```ts
linkChargeToReceipt({ chargeId, receiptId, canonicalTxnId, via }): Promise<LinkResult>
unlinkCharge(matchId): Promise<LinkResult>
rejectSuggestion(matchId): Promise<LinkResult>          // alias of unlinkCharge
closeCharge({ chargeId, reason, note }): Promise<LinkResult>
reopenCharge(chargeId): Promise<LinkResult>
closeReceipt({ receiptId, reason }): Promise<LinkResult>
reopenReceipt(receiptId): Promise<LinkResult>
markSeen(): Promise<void>                                // stamps last_reconcile_seen_at
```

`linkChargeToReceipt` pre-checks both partial unique indexes (`rsm_unique_confirmed_charge`, `0016:157-158`; `rsm_unique_confirmed_receipt`, `0013:14-16`) so the user sees a sentence rather than `23505`, then upserts `onConflict: "receipt_id,charge_id"` (`rsm_unique_pair`, `0016:160-161`). **It passes `statement_transaction_id: canonicalTxnId` as well as `charge_id`** — the `rsm_sync_charge` BEFORE-INSERT trigger (`0016:52-68`) reads `charge_id` and all four `snap_*` provenance columns off the transaction; passing only `charge_id` leaves the snapshot null. Sets `decided_via` and `rejected_at: null`.

**`unlinkCharge` and `rejectSuggestion` set `rejected_at = now()` and never delete.** This is the fix `0016:26-27` was explicitly written for — *"Set by rejectMatch instead of deleting, so a rejected pairing is never resurrected by a later run"* — which `lib/matching/actions.ts:202` still has not applied. They also stamp `rejected_fingerprint` from the receipt's current `match_fingerprint`.

**Changed:**
- `components/toast.tsx:14-17` — `toast(message, variant, action?: { label, onAction })`; render the action button beside the dismiss control at `:64-71` and raise `ttl` to 8000 when an action is present. ~15 lines. **The single most important safety valve on the whole surface.**
- `app/(app)/reconcile/page.tsx` — every row gets one primary action that changes by state (`Attach` → `Yes, that's it` → `···`) and a `···` menu with close reasons **in Andrew's words**: *Bank charge, never chase · Paid cash, no receipt exists · Personal, not a business expense · Accountant will handle it · Written off*. Orphan rows get the same minus the bank options.
- New `app/(app)/reconcile/closed/page.tsx` — grouped by reason with counts, each row showing reason, date, who decided (`closed_by`/`decided_via`), and **Reopen**. An **"Auto-closed since you last looked (n)"** tray pinned to the top.
- `lib/matching/actions.ts` — delete the hand-written `is_matched` updates at `:88-92`, `:188-193`, `:204-207`. The `rsm_sync_is_matched` trigger (`0016:74-93`) derives it; writing it by hand is now a source of drift.

**After this step Andrew can:** cross every single thing off. Attach a receipt, say "no receipt needed", say "the accountant just deals with it", and undo any of it. The header can reach **0 open**.
**Verify:** close one fee charge and one orphan receipt; the header decrements; both appear under `/reconcile/closed` with a reason and Reopen; Reopen restores the count.

## Step 9 — Vendor identity and scoring hardening (pure functions, fully tested)

Must land **before** the global pass, or a defective matcher gets pointed at every charge at once. Specs: **§4.1** (aliasing), **§4.3** (gate).

**New:**
- `lib/matching/vendor-alias.ts` — `statementZone`, `receiptTokens`, `zoneKey`, `buildIdf`, `vendorScoreV2`. Pure, no I/O.
- `lib/matching/vendor-alias.test.ts` — the **30-row test table in §4.1.4 verbatim** as fixtures.
- `lib/matching/match.test.ts` — the five known-bad live pairs: the 224.70 (01 Jun) / 222.32 (03 Jun) cross-match that auto-confirmed **both** above 85, and the four July receipts pulled backwards onto April–June charges at 43, 50 and 71 days.
- `lib/reconciliation/amounts.ts` — `amountVerdict()`, currency-aware exactness (**§4.3.3**).
- `lib/matching/learn-alias.ts` — `learnAliasFromDecision`, `loadAliasMap`.

**Changed:**
- `lib/matching/match.ts` — replace `vendorScore` (`:63-71`); reweight `scorePair` (`:97`) from `a·0.50 + d·0.20 + v·0.20 + card` to **`a·0.45 + v·0.35 + d·0.15 + card`**; card mismatch becomes **disqualifying** rather than `−0.15` (`:94`); null date 0.3 → **0.25** (`:86`); `MatchTxn`/`MatchReceipt` (`:3-17`) gain `currency` and `charge_id`; `STRONG_CONFIDENCE` 75 → 82 and becomes **conjunctive plus a uniqueness margin**; `candidates.sort` (`:124`) gains deterministic tiebreakers; an exact-amount pre-pass runs before the greedy loop.
- `app/api/receipts/extract/route.ts:121` — `.select("*")` → `.select("*").in("rule_type", ["vendor_category","last4_card"])`. It is unfiltered and unpaginated and runs on every receipt extraction; adding `vendor_alias` and `line_kind` rows would make it strictly worse. `classify()` reads only those two types (`lib/classification/classify.ts:71-73`, `:104-109`).
- `lib/types.ts:25` — `RuleType` gains `"vendor_alias" | "line_kind"`.

**After this step Andrew can:** nothing new on screen, but the next run will know `SCL TRINIDAD LTD SAN JUAN` is `SCL (Trinidad) Limited` and will refuse to guess between 224.70 and 222.32.
**Verify:** `npm test` — 30/30 alias fixtures pass; all five known-bad pairs now fail to auto-confirm.

## Step 10 — The consolidated close-out pass

Spec: **§4.4**. **New:** `lib/reconciliation/run.ts` — `runCloseOut(): Promise<RunSummary>`.

- Inputs are **never narrowed by time-of-run.** Open charges from `charge_reconciliation` where `is_open`; eligible receipts filtered only by data quality (`duplicate_of is null`, `no_charge_expected = false`, `status in ('confirmed','needs_review')`, `ttd_amount not null`).
- **Suppression** of already-decided pairs is the whole of "incremental" (§4.4.2).
- **Candidate windowing** per charge from `receipt_window_days_before` (60) / `receipt_window_days_after` (15) (`0014:16-19`) — read by no code today, which is exactly why four July receipts were pulled backwards. Confirmed and sent receipts are **exempt**, per the column comment at `0014:25-26`. The run **reports** how many receipts fell outside the window; a silent window is the failure mode this design exists to prevent.
- **Upsert + sweep**, never delete-then-insert (§4.4.3).
- `auto_confirm_enabled` (`0014:23`, default `false`, documented *"the consolidated run produces suggestions, not confirmations"*) is actually **read**, unlike `runMatching` which auto-confirms everything ≥75 at `lib/matching/actions.ts:79`.

**Changed:**
- `lib/matching/actions.ts:197-210` — `rejectMatch` stops deleting. **Must ship in the same commit as the sweep.** The current delete at `:65-69` is `.delete().in("statement_transaction_id", txnIds).eq("confirmed", false)` — and a rejected row *has* `confirmed = false`, so fixing `rejectMatch` alone would leave the next `runMatching` deleting the rejection anyway.
- `app/api/statements/parse/route.ts` — fire `runCloseOut()` after a successful parse. Andrew should not have to know a button exists; the button stays for re-runs.
- `app/(app)/reconcile/page.tsx` — one primary **"Find matches"** button using `useActionState`, returning an inline banner: *"scanned 18 open items · 6 suggestions · 2 bank charges auto-closed · 3 receipts outside the date window were not considered."*

**After this step Andrew can:** upload a statement and watch the list shrink by itself, with suggestions to say yes or no to — and a "no" that stays no.
**Verify:** run twice with no new data; the second run produces **byte-identical rows including unchanged `created_at`**. Reject a suggestion, re-run, confirm it does not come back.

## Step 11 — Noise: the parser stops deleting, and Andrew can correct it

Spec: **§4.2**.

**Changed:**
- `lib/extraction/parse-statement.ts:7-16` — `TxnSchema` gains `direction`, `kind`, `raw_line`. `:18-26` — `StatementSchema` gains `printed_purchases_total`, `printed_payments_total`, `printed_closing_balance`.
- `lib/extraction/parse-statement.ts:34` — **delete this line.** It reads *"Only include purchases/charges (money spent). EXCLUDE payments to the card, refunds, credits, interest, and fees unless they are clearly purchases."* Replace per §4.2.4.
- `app/api/statements/parse/route.ts:109-119` — map `amount: Math.abs(t.amount!)`, `direction: t.amount! < 0 ? "credit" : (t.direction ?? "debit")`, `model_kind: t.kind`, `raw_line: t.raw_line`. Write `printed_*` onto `statements`, set `period_inferred = (parsed.period_start == null)` — **in the update at `:69-76`, which must also move to run AFTER the confirmed-match guard at `:78-101`** (today it writes the period before deciding whether to keep the existing transactions).
- `:130` — `{ok:true, count:0}` becomes `{ok:false, message:"No transactions were found in this file."}`; `components/statements/statement-uploader.tsx:152-155` currently renders zero rows as a **green badge**.
- `:60-65` — the card lookup is `.eq("last4", parsed.card_last4)` with **no `user_id` scope**; add it, plus the `/^\d{4}$/` guard that currently only exists at `:106-108`.
- `:104,121-128` — chunk the insert (500 rows) and derive `period_start`/`period_end` from `min/max(txn_date)` after insert when the parser returned null.

**New:**
- `lib/reconciliation/noise.ts` — `noiseKeyOf()`, the TypeScript mirror of `noise_key_of()`, plus a test asserting the two agree (mirroring already documented at `0015:22` for `normalizeVendor`).
- `setLineKind(chargeId, kind, note?)` — three things: fix this charge (`kind_source='user'`, `fee_auto_flagged=false`); upsert `learning_rules {rule_type:'line_kind', pattern: noiseKeyOf(description), action:{line_kind, direction}}` so every future statement carrying that line is classified on ingest; and sweep history now with `.eq("noise_key", key).neq("kind_source","user")`. **`kind_source='user'` is never overwritten by a rule or by re-parsing.**
- UI: the two collapsed strips gain per-row **"Actually needs a receipt"**; every open purchase row gains a kind picker behind `···` (*Bank fee · Interest · Payment I made · Refund · Not a transaction*). `kind_source` drives a badge: `pattern`/`model` → *auto*, `rule` → *"because you told me before"*, `user` → *"you set this"*. This is `fee_auto_flagged`'s original intent (`0015:51`, *"so a wrong auto-flag stays visible"*) made visible at last.
- The completeness line becomes real:

```
  Spend this period            TTD 22,295.00     purchases + fees + interest − refunds
  Net movement                 TTD 17,295.00     spend − payments
  Statement says               TTD 17,295.00  ✓  printed_closing_balance
```

If `printed_*` was not read it prints **"Statement total not read — can't verify this list is complete"** and never a tick.

**After this step Andrew can:** tell the app "this is bank crap" once and never see that line again on any statement, past or future; and see whether the parser actually read the whole statement.
**Verify:** re-parse one statement; the `OVERLIMIT FEE` line is present and classified rather than absent. Mark one line as a bank fee; it disappears from the list, appears in the strip, and a second statement carrying the same line is classified on ingest.

## Step 12 — The pairing board at `/reconcile/board`

Spec: **§4.5**. **Ship order inside the step is not negotiable** — three independently useful, independently revertible sub-steps:

1. **12a — the floor.** Every charge row keeps a `<details>` containing the existing `<AttachReceipt>` (`components/matching/attach-receipt.tsx:19-157`) — a real `<form action={attachReceiptToCharge}>` with a radio list sorted by closeness to the line amount (`:46-53`) with exact matches flagged (`:103`). Works with JavaScript off.
2. **12b — tap-to-hold + keyboard + optimistic cross-off.** The complete feature on Andrew's phone: tap a charge, the opposite list re-sorts closest-amount-first with exact matches pinned under a green **EXACT** pill and the signed delta printed on near misses, tap a receipt, done.
3. **12c — drag, mouse and pen only.** Progressive enhancement. `e.pointerType === "touch"` never initiates a drag. Deletable at any time without touching 12a or 12b.

**Refusing to drag on touch removes the entire scroll-versus-drag arbitration problem** — no `touch-action: none` on the lists, no long-press timer competing with iOS text selection, no `pointercancel` recovery. That is the highest-defect-density surface in this plan, deleted rather than mitigated, at zero functional cost.

**After this step Andrew can:** sit at a desk and blitz the residue, or clear it two taps at a time on his phone.
**Verify:** on an actual iPhone, both lists scroll normally, tap-to-hold works, a mis-tap is undoable from the toast for 8 seconds.

## Step 13 — The close-out PDF and bulk send to the accountant

**New:**
- `app/api/reports/reconciliation/route.ts` — one document across **all** statements, built from `charge_reconciliation` so each charge is counted once. Header *"Open items as at 28 Jul 2026"*, period from `statement_coverage.effective_start/effective_end` (`0014:51-65`), reading **"dates inferred from transactions"** where the period was not read off the document. Sections: charges still needing a receipt · charges closed with a reason · **receipts with no statement line** · bank charges suppressed. Receipt-image appendix via `lib/reports/append-receipts.ts`.
- `lib/reports/reconciliation-report-document.tsx`.
- **Bulk "Send these to the accountant"** on the orphan section — multi-select plus `setReceiptsSent` (`lib/receipts/actions.ts:259-268`). This is **27 receipts worth TTD 11,648.69**, the single largest pot in the dataset, and today the only way to act on it is to leave the close-out screen entirely. Add `revalidatePath("/reconcile")` to that action, which it lacks.
- **"Copy the chase list"** — plain text to the clipboard so Andrew can paste it into WhatsApp from his phone.

**Changed:** `lib/reports/append-receipts.ts` — add `APPENDIX_MAX_RECEIPTS` and a `deadline` parameter; route the `.in("receipt_id", ids)` at `:62-66` through `fetchAll`.

## Step 14 — Retire `/matching`, wire settings, clean up

- `app/(app)/matching/page.tsx` → permanent redirect to `/reconcile`. `runMatching` (`lib/matching/actions.ts:12-96`) deleted; `attachReceiptToCharge` moves to `lib/reconciliation/actions.ts` (keeping a re-export).
- `app/api/reports/statement/route.ts` — the legacy per-statement PDF reads raw `statement_transactions` (`:49-53`) so its totals still double-count carried-over charges, and matches via `.in("statement_transaction_id", txnIds)` (`:63`) so it still reports charges covered elsewhere as missing. Point it at `charge_reconciliation` or remove it.
- `components/settings/settings-form.tsx:14` and `lib/settings/actions.ts:36-40` — expose the five `0014` columns in plain English: *"Look for receipts up to [60] days before and [15] days after a charge"*, *"Treat statement lines within [4] days as the same charge"*, and one switch *"Let a run tick things off by itself when it is certain"*. `lib/types.ts:37-45` `UserSettings` gains all seven new columns.
- Drop `rsm_backup_pre_0016`, `charges_backup_pre_0019`, `stmt_txn_backup_pre_0019` **only after a full close-out cycle and Andrew confirming the numbers.**

---

# 4. THE FOUR SPECIALIST SUBSYSTEMS

## 4.1 Vendor aliasing

Verified against the real corpus (64 charges, 86 receipts) with a working prototype over the **full 928-pair cross product**. Everything here is measured.

### 4.1.1 What the live descriptions actually look like

| Real description | What it teaches |
|---|---|
| `MICROSOFT#G156344268 MSBILL.INFO WA` | the processor delimiter is `#`, not only `*` |
| `ANTHROPIC* CLAUDE SUB ANTHROPIC.COMCA` | `*` followed by a space; TLD and country glued (`COMCA`) |
| `PETRO MART LTD 16 VICTORIA A` ↔ `Petromart Ltd` | **zero token overlap** — the word split differs across sides |
| `ETTES OFFICE FURNITU WOODBROOK` ↔ `Ettes Office Furniture Ltd.` | truncation is **mid-word**, not only trailing |
| `SCL TRINIDAD LTD SAN JUAN`, `NEW MAYARO LTD CORNER GANADO`, `CIRCUIT ZONE LIMITED WEST MALL`, `HYATT TRINIDAD LIMITED PORT OF SPAIN` | a legal suffix is a **position marker**: everything after `LTD`/`LIMITED`/`INC` is address, on five independent descriptions |
| `PEAKE PETROLEUM 177 WESTERN M` vs `PEAKE TRADING 177 WESTERN M` | the hardest non-collision: **same branch address**, different business |
| `CAL_CORP_CTO TRINIDAD` ↔ `Caribbean Airlines` | the true acronym case, ×5 charges — zero shared tokens |

Two consequences: a Trinidad geo gazetteer is **not** needed — legal suffixes and store numbers mark the boundary far more reliably; and `CAL_CORP_CTO` is the real "SCL is SCL" case here, and it is deterministically unsolvable.

### 4.1.2 Normalisation

Shared base: `norm(s) = lower → /[^a-z0-9]+/g → " " → trim` — byte-identical to `normalizeVendor` (`lib/classification/classify.ts:11-16`) and `charge_key_of` (`0015:26`). **Do not diverge; three normalisers would be a maintenance trap.**

```
LEGAL   = ltd ltda limited llc lp llp inc incorporated corp corporation
          co company plc unlimited pte sa nv bv gmbh
STOP    = and the of for at in on to by
CHANNEL = mktpl mktplace marketplace
TLDISH  = /^(com|net|org|info|io|biz|ai|app|co)(uk|ca|us|tt|au|wa|nl|de|fr)?$/
```

`CHANNEL` is three words on purpose. `web`, `store`, `online`, `bill` are **not** in it — `WEB SOURCE` is a real merchant and `MASSY STORES` must stay distinguishable from `MASSY MOTORS`. `TLDISH` is a regex, not a list, so it handles `ANTHROPIC.COMCA` → `comca` and `Amazon.com` → `com`.

**Statement side — the merchant zone.** A card descriptor is `MERCHANT [MERCHANT2] <branch/street/city…>`. Only the merchant prefix carries identity; everything else is systematic pollution to be **ignored, not penalised**.

```ts
statementZone(description): string[]        // ORDERED
  1. head = description.split(/[*#]/)[0]    // NAME*REF / NAME#REF processor descriptor
  2. toks = norm(head).split(" ").filter(len >= 2)
  3. walk left→right, emitting:
       if /^\d+$/       → BREAK    // 112, 177, 16 → an address follows
       if LEGAL.has(t)  → BREAK    // LTD/LIMITED/INC → an address follows
       if STOP|CHANNEL|TLDISH → skip
       else emit (dedup)
  4. if empty, retry without the BREAK rules
```

Verified output on all 32 distinct live descriptions — every one correct:

```
STAR PETROL 112 ROBERTS S               → [star petrol]
PEAKE PETROLEUM 177 WESTERN M           → [peake petroleum]
PEAKE TRADING 177 WESTERN M             → [peake trading]
SCL TRINIDAD LTD SAN JUAN               → [scl trinidad]
PETRO MART LTD 16 VICTORIA A            → [petro mart]
WEB SOURCE CO 16 TRINCITY B             → [web source]
NEW MAYARO LTD CORNER GANADO            → [new mayaro]
CIRCUIT ZONE LIMITED WEST MALL          → [circuit zone]
HYATT TRINIDAD LIMITED PORT OF SPAIN    → [hyatt trinidad]
PARC RAYNE INC EAST BANK DEM            → [parc rayne]
AMAZON MKTPL*BS0Y50YY2 Amzn.com/billWA  → [amazon]
Amazon.com*BJ03E77A1 AMZN.COM/BILLWA    → [amazon]
LinkedIn*P3042891416 LINKEDIN.COM       → [linkedin]
MICROSOFT#G156344268 MSBILL.INFO WA     → [microsoft]
ANTHROPIC* CLAUDE SUB ANTHROPIC.COMCA   → [anthropic]
ANTHROPIC ANTHROPIC.COMCA               → [anthropic]        ← TLDISH earns its keep
CAL_CORP_CTO TRINIDAD                   → [cal]
ETTES OFFICE FURNITU WOODBROOK          → [ettes office furnitu woodbrook]
HYATT REGENCY-FOOD AND PORT OF SPAIN    → [hyatt regency food port spain]
NATIONAL CAR RENTAL/AL CROWN POINT      → [national car rental al crown point]
```

The last three have no terminator so the zone runs long; positional decay handles them, and no gazetteer is needed.

**Receipt side.** `receiptTokens(vendor)` = the same normalisation dropping `LEGAL|STOP|CHANNEL|TLDISH`, **unordered, no zone logic** — receipt vendor names are not positionally structured.

### 4.1.3 The scoring function

Replaces `vendorScore` at `lib/matching/match.ts:63-71`.

**Direction matters.** The current metric divides by `Math.min(a.size, b.size)` (`:70`), which rewards *shorter* receipt names — `SCL Ltd` would score 1.0 against `SCL TRINIDAD LTD SAN JUAN` while the fuller, more informative `SCL (Trinidad) Limited` scores 0.667. The fix is not a different denominator; it is **measuring coverage of the statement zone by the receipt**, so receipt-side padding is free and statement-side pollution is bounded by decay.

```
score = Σ_{z covered} idf(z)·w(i)  /  Σ_{all z} idf(z)·w(i)

w = [1.0, 1.0, 0.25, 0.10, 0.05]      // by zone position, clamped at index 4
idf(t) = ln((N+1)/(df(t)+1)) + 1      // smoothed; an unknown token gets max idf

z at position i is COVERED iff:
  a) z ∈ receiptTokens                                          (exact)
  b) z.length ≥ 6 AND ∃r: r.length > z.length AND r.startsWith(z)
                                                                (ONE-WAY truncation)
  c) (z + zone[i+1]) ∈ receiptTokens  OR  (zone[i-1] + z) ∈ receiptTokens
                                                                (concatenation invariance)

HEAD GATE: if zone[0] is not covered → score = min(score, 0.5)
```

- **(b) is deliberately one-way.** Banks truncate; receipts do not. Allowing the reverse makes `petrol` cover `petroleum`, i.e. `Star Petrol ≡ Peake Petroleum` — measured at 0.550 with a symmetric rule, gone with the asymmetric one. `MIN_PREFIX = 6`, not 5: `furnitu`(7)→`furniture` still fires, `petro`(5)→`petroleum` no longer does.
- **(c)** is the only thing that solves `PETRO MART LTD` ↔ `Petromart Ltd`, where token overlap is exactly zero.
- **Head gate:** the first zone token *is* the merchant. Without it, `HYATT TRINIDAD` ↔ `SCL (Trinidad) Limited` scores on the shared word `trinidad` alone.

**IDF corpus** — built once per run over **distinct zone strings ∪ distinct receipt vendor keys**, *not* over the 90 statement lines. Deduping is essential: `PEAKE PETROLEUM` appears on 15 lines but must count as one document. Measured: N = 49, `idf(trinidad)` = 2.97 (df 6), `idf(peake)` = 3.12 (df 5), `idf(scl)` = 3.81 (df 2). Cost is microseconds. Scores are a normalised ratio, so far more drift-stable than raw IDF as the corpus grows; confirmed matches are immutable, so drift only affects future suggestions.

**Thresholds:** `ALIAS_STRONG = 0.75` · `MIN_VENDOR_EVIDENCE = 0.45`.

### 4.1.4 Test table — measured output, not predicted

30/30. `old` = the current `vendorScore`; `new` = this design. PASS for MUST = ≥0.75; PASS for MUST NOT = <0.60.

| statement description | receipt vendor | want | zone | old | new | verdict |
|---|---|---|---|---|---|---|
| `SCL TRINIDAD LTD SAN JUAN` | SCL (Trinidad) Limited | MUST | `scl trinidad` | 0.67 | **1.00** | PASS |
| `STAR PETROL 112 ROBERTS S` | Star Petrol and One Stoppe Limited | MUST | `star petrol` | 0.50 | **1.00** | PASS |
| `PEAKE PETROLEUM 177 WESTERN M` | Peake Petroleum | MUST | `peake petroleum` | 1.00 | **1.00** | PASS |
| `Amazon.com*BJ03E77A1 AMZN.COM/BILLWA` | Amazon.com | MUST | `amazon` | 1.00 | **1.00** | PASS |
| `Amazon.com*BJ03E77A1 AMZN.COM/BILLWA` | Amazon | MUST | `amazon` | 1.00 | **1.00** | PASS |
| `AMAZON MKTPL*BS0Y50YY2 Amzn.com/billWA` | Amazon | MUST | `amazon` | 1.00 | **1.00** | PASS |
| `AMAZON MKTPL*BS0Y50YY2 Amzn.com/billWA` | Amazon (Emma's Market) | MUST | `amazon` | 0.33 | **1.00** | PASS |
| `LinkedIn*P3042891416 LINKEDIN.COM` | LinkedIn Ireland Unlimited Company | MUST | `linkedin` | 0.33 | **1.00** | PASS |
| `MICROSOFT#G156344268 MSBILL.INFO WA` | Microsoft Corporation | MUST | `microsoft` | 0.50 | **1.00** | PASS |
| `PETRO MART LTD 16 VICTORIA A` | Petromart Ltd | MUST | `petro mart` | 0.50 | **1.00** | PASS |
| `ETTES OFFICE FURNITU WOODBROOK` | Ettes Office Furniture Ltd. | MUST | `ettes office furnitu woodbrook` | 0.50 | **0.95** | PASS |
| `NEW MAYARO LTD CORNER GANADO` | New Mayaro Ltd (NP Mayaro) | MUST | `new mayaro` | 0.75 | **1.00** | PASS |
| `CIRCUIT ZONE LIMITED WEST MALL` | Circuit Zone Ltd. | MUST | `circuit zone` | 0.67 | **1.00** | PASS |
| `NATIONAL CAR RENTAL/AL CROWN POINT` | National Car Rental Crown Point | MUST | `national car rental al crown point` | 1.00 | **0.95** | PASS |
| `PORT ROYAL KITCHENS TOBAGO` | Bli Restaurant & Bar (Port Royal Kitchens Ltd)… | MUST | `port royal kitchens tobago` | 1.00 | **1.00** | PASS |
| `HYATT TRINIDAD LIMITED PORT OF SPAIN` | Hyatt Regency Trinidad - Lobby Bar | MUST | `hyatt trinidad` | 0.40 | **1.00** | PASS |
| `HYATT REGENCY-FOOD AND PORT OF SPAIN` | Hyatt Regency Trinidad - Cinnamon | MUST | `hyatt regency food port spain` | 0.50 | **0.80** | PASS |
| `WEB SOURCE CO 16 TRINCITY B` | Web Source | MUST | `web source` | 1.00 | **1.00** | PASS |
| `PEAKE TRADING 177 WESTERN M` | Peake Trading - Cocorite | MUST | `peake trading` | 0.67 | **1.00** | PASS |
| `CAL_CORP_CTO TRINIDAD` | Caribbean Airlines | MUST (acronym) | `cal` | 0.00 | **0.00** | PASS — needs a learned alias |
| `PEAKE PETROLEUM 177 WESTERN M` | Peake Trading Ltd | MUST NOT | `peake petroleum` | 0.33 | **0.45** | PASS |
| `PEAKE TRADING 177 WESTERN M` | Peake Petroleum | MUST NOT | `peake trading` | 0.50 | **0.49** | PASS |
| `PETRO MART LTD 16 VICTORIA A` | Peake Petroleum | MUST NOT | `petro mart` | 0.00 | **0.00** | PASS |
| `STAR PETROL 112 ROBERTS S` | Peake Petroleum | MUST NOT | `star petrol` | 0.00 | **0.50** | PASS (head gate) |
| `HYATT TRINIDAD LIMITED PORT OF SPAIN` | Blu Restaurant & Bar, Crown Point Hotel Tobago | MUST NOT | `hyatt trinidad` | 0.00 | **0.00** | PASS |
| `PORT ROYAL KITCHENS TOBAGO` | Blu Restaurant & Bar, Crown Point Hotel Tobago | MUST NOT | `port royal kitchens tobago` | 0.25 | **0.04** | PASS |
| `NEW MAYARO LTD CORNER GANADO` | Moonan Service Station | MUST NOT | `new mayaro` | 0.00 | **0.00** | PASS |
| `FABRIC LAND TRADING PORT OF SPAIN` | Homeland Furnishings | MUST NOT | `fabric land trading port spain` | 0.00 | **0.00** | PASS |
| `PARC RAYNE INC EAST BANK DEM` | Peake Trading Ltd | MUST NOT | `parc rayne` | 0.00 | **0.00** | PASS |
| `WEB SOURCE CIF LOGISTICS SOUTH MIAMI FL` | Web Source | ambiguous | `web source cif logistics south miami fl` | 1.00 | **0.77** | canary — see below |

**Full cross product** (32 distinct zones × 29 distinct vendors = 928 pairs): exactly **24 pairs score ≥ 0.60, and 23 are true positives.** The 24th is `WEB SOURCE CIF LOGISTICS SOUTH MIAMI FL` ↔ `Web Source` at 0.770 — very likely correct (Web Source's Miami forwarding address) but the one pair not verifiable from data alone. It sits just above `ALIAS_STRONG`, so it is the canary: **it must not auto-confirm on vendor evidence alone.**

**The residual band 0.45–0.60 contains no true positives and 5 near-misses**, all structurally explained: a two-token zone with one token uncovered is arithmetically capped near 0.5 regardless of IDF. That is a safety *property*, not a tuning accident.

**One finding that bears directly on the matcher:** all three Hyatt receipts score **1.00** against `HYATT TRINIDAD LIMITED PORT OF SPAIN`. Aliasing makes the matcher *more* confident, which makes the uniqueness margin in §4.3 **more** load-bearing, not less.

### 4.1.5 Storage and learning

Extend `learning_rules`. The existing `unique (user_id, rule_type, pattern)` (`0001:260`) **is** the alias correctness invariant: one canonical vendor per statement zone. A new table would re-declare exactly that, plus DDL, RLS, an index, an `updated_at` trigger, types and its own migration.

```jsonc
{ rule_type: "vendor_alias",
  pattern:  "cal",                       // ← the normalised ZONE KEY, never the raw description
  action:   { vendor_tokens: ["caribbean","airlines"],
              vendor_name: "Caribbean Airlines",
              source: "attach",          // attach | drag | tap | confirm | model
              learned_from_charge_id: "…", learned_from_receipt_id: "…" } }
```

**Alias match is containment, not equality**: it fires when `vendor_tokens ⊆ receiptTokens(candidate.vendor_name)`. Equality would break the moment a receipt reads `Caribbean Airlines Limited (CAL)`.

```ts
// lib/matching/learn-alias.ts
async function learnAliasFromDecision(supabase, userId, description, vendorName, ctx) {
  const zone = statementZone(description);
  const toks = receiptTokens(vendorName);
  if (zone.length === 0 || toks.length === 0) return;
  if (vendorScoreV2(description, vendorName, idf, null).score >= ALIAS_STRONG) return; // already solved
  await supabase.from("learning_rules").upsert({
    user_id: userId, rule_type: "vendor_alias", pattern: zone.join(" "),
    action: { vendor_tokens: toks, vendor_name: vendorName, ...ctx },
  }, { onConflict: "user_id,rule_type,pattern" });
}
```

**Write sites — every one is a human asserting "this description is this vendor":** `attachReceiptToCharge` (`lib/matching/actions.ts:105-177`, after the upsert at `:160-172`; it already selects `description` at `:121`, so no extra query); `confirmMatch` (`:179-195`, needs one added join); and every drag/tap drop, which routes through the same action.

**Four hard guards:**

1. **Only human decisions teach.** Never learn from an auto-confirmed match. Auto-confirm → alias → higher score → more auto-confirm is a runaway loop. Gate on `decided_via in ('user','attach','drag','tap','keyboard')`.
2. **Only learn what was got wrong** (`score < ALIAS_STRONG`). On the live corpus 23 of the 24 strong pairs write nothing — the table stays small and every row is meaningful.
3. **Aliases only ever ADD score, never subtract**, and never bypass the amount/date/card gates. An alias hit sets vendor evidence to 1.0; it confirms nothing by itself.
4. **Aliases affect scoring ONLY. `charge_key_of` (`0015:23-30`) must not change.** If aliases fed charge identity, `PEAKE PETROLEUM 177 WESTERN M` and `PEAKE TRADING 177 WESTERN M` — same address, genuinely different merchants in this data — could collapse into one charge, defeating Guard 1 (`0015:103-108`) and silently deleting real work. **Put this as a comment in the migration, not only in this document.**

**Negative aliases are not needed.** A rejection is per-pair evidence and `rejected_at` (`0016:19`) is already the right home at the right granularity.

**Scale honesty:** correct to ~10⁴ rules. Beyond that you would want trigram indexing, and `pg_trgm` is not enabled.

## 4.2 Bank noise removal

### 4.2.1 Six defects in what exists today

`is_fee_description()` (`0015:35-39`) plus `no_receipt_expected`/`fee_auto_flagged` (`0015:50-51`) has the right *shape* — it keeps the line and flags it rather than deleting it. But:

- **D1 — coverage is ~20% of the real vocabulary.** Thirteen alternatives. No `overdraft`, no `paper statement fee`, no `paper payment fee`, no `returned payment`/NSF, no `replacement card fee`, no `finance charge`, no `cross border`/`currency conversion`, no refunds, no reversals, no chargebacks, and no concept of a **balance-summary line**. Andrew named overdraft and paper payment fees by name; neither is in the list.
- **D2 — it matches substrings, not tokens, and one term is a live landmine.** `0015:38` is an unanchored alternation containing bare `interest`. `PINTEREST ADS` → `pinterest ads` → contains `interest` → both flags set at `0015:120` → a real, receipt-bearing advertising spend silently disappears. Same class of bug for `payment cr`. **The fix is tokenisation, not deleting the term.**
- **D3 — one boolean, three behaviours.** §2.2 Section E.
- **D4 — two competing noise filters, and the wrong one is destructive.** `lib/extraction/parse-statement.ts:34` tells the model to **drop** payments/refunds/credits/interest/fees; `0015:35-39` **keeps and flags** them. Live data settles it: `OVERLIMIT FEE 45.00` is in `statement_transactions`, so the prompt's exclusion did not fire. And when it *does* fire the evidence is gone forever — `statement_transactions` has no `raw_extraction` equivalent (unlike `receipts`, `0001:147`), so the parse can never be reconciled against the printed statement. **This is exactly "silently hiding real money", and it is shipping today.**
- **D5 — nothing reads either flag, and the one view that does reads it wrong.** Grep for `no_receipt_expected|fee_auto_flagged|is_fee_description` across `*.ts`/`*.tsx` returns **zero hits**. The only consumer is `charge_reconciliation`, whose CASE puts `no_receipt_expected` first (`0017:74`) — fixed in §2.2 Section H.
- **D6 — no correction path and no persistence.** No UI can set, clear or display either column, and even with one, the next statement carrying the same line would repeat the mistake.

### 4.2.2 The taxonomy — nine kinds on two independent axes

"Needs a receipt" and "counts as money" are orthogonal.

| `line_kind` | Example | Chase? | In **spend**? | In **movement**? | Direction |
|---|---|---|---|---|---|
| `purchase` | `SCL TRINIDAD LTD SAN JUAN` | **Yes** | + | + | debit |
| `unknown` | unreadable / unclassifiable | **Yes** (fail safe) | + | + | debit |
| `fee` | `OVERLIMIT FEE`, `PAPER STATEMENT FEE`, `OVERDRAFT FEE` | No | **+ real expense** | + | debit |
| `interest` | `INTEREST CHARGE`, `FINANCE CHARGE` | No | **+ real expense** | + | debit |
| `card_payment` | `PAYMENT — THANK YOU` | No | **excluded** | − | credit |
| `refund` | `CREDIT VOUCHER`, `GOODS RETURNED` | Optional | **−** | − | credit |
| `reversal` | `TRANSACTION REVERSAL`, `CHARGEBACK` | No | **−** | − | credit |
| `adjustment` | `FEE WAIVER`, `REBATE` | No | ± | ± | from parser |
| `balance_summary` | `MINIMUM PAYMENT DUE`, `PREVIOUS BALANCE` | No | **never** | **never** | n/a |

**`balance_summary` is the class nobody has modelled and does the most damage.** `MINIMUM PAYMENT DUE 250.00` parses as a perfectly plausible charge — a date, a description, an amount. It inflates the total, sits on the worklist forever as `genuinely_new` (`0017:78`), and never matches anything. It is a *phantom*, not noise.

### 4.2.3 Exact pattern lists

Matched against `norm_desc()` — lowercased, non-alphanumerics → single spaces, **space-padded both ends** — so every phrase matches only on whole-token boundaries. **Precedence is load-bearing and must be evaluated in this order.**

**Tier 1 — `balance_summary`** (first; these are not transactions at all)
```
minimum payment | minimum payment due | minimum due | amount due | total amount due
previous balance | opening balance | beginning balance | balance brought forward | balance b f
closing balance | new balance | statement balance | current balance | ending balance
credit limit | available credit | available balance | cash advance limit
total purchases | total payments | total credits | total debits | total fees | total charges
total this period | purchases and adjustments | sub total | subtotal | grand total
payment due date | past due amount | finance charge summary
```

**Tier 2 — `reversal`** (BEFORE `fee`: "fee reversal" is a credit, not a fee)
```
reversal | reversed | transaction reversal | fee reversal | charge reversal
chargeback | charge back | dispute credit | disputed transaction | error correction
void | voided | voided transaction | duplicate reversal
```

**Tier 3 — `refund`**
```
refund | refunded | merchant refund | purchase refund
credit voucher | credit memo | credit note | merchant credit
goods returned | purchase return | returned goods | cancelled transaction | cancellation
```

**Tier 4 — `card_payment`**, split in two, and **excluded whenever the token `fee` is present** (so `RETURNED PAYMENT FEE` falls through to Tier 6 where it belongs).

*4a — unambiguous, fires on description alone:*
```
payment thank you | thank you for your payment | payment received | payment recd
payment credit | payment cr | payment reversal thank you | card payment received
autopay | auto pay payment | pre authorized payment | preauthorized payment
```
*4b — requires `direction = 'credit'` from the parser or an explicit CR marker in `raw_line`:*
```
payment | bill payment | online payment | mobile payment | branch payment
in branch payment | telebanking payment | direct debit | standing order
transfer payment | payment transfer | linx payment
```

> **Why 4b is gated.** On a *credit card* statement `PAYMENT` means a payment to the card. On a *chequing account* statement `BILL PAYMENT TSTT` is a real expense that needs a receipt. Andrew named **overdraft** fees — an overdraft is a deposit-account concept, not a card one — which strongly suggests he uploads or will upload current-account statements too, while `parse-statement.ts:31` hard-codes "credit card statement". Gating 4b on an actual credit direction is what stops this design from deleting real expenses. **See §5.4.**

**Tier 5 — `interest`**
```
interest | interest charge | interest charged | purchase interest | retail interest
cash advance interest | overdraft interest | interest on overdraft
finance charge | financing charge | monthly interest | arrears interest
penalty interest | default interest | interest adjustment
```

**Tier 6 — `fee`** (Andrew's "normal bank crap")
```
# over-limit / late / default
overlimit fee | over limit fee | overlimit charge | over the limit fee
late fee | late payment fee | past due fee | default fee | delinquency fee

# card carrying costs
annual fee | annual membership fee | membership fee | card fee | renewal fee
card renewal fee | replacement card fee | card replacement fee | pin replacement fee
credit protection | credit shield | card protection | payment protection

# account / servicing  <-- Andrew's "paper payment fee"
service charge | service fee | monthly service charge | maintenance fee
account maintenance fee | ledger fee | statement fee | paper statement fee
e statement fee | paper fee | paper payment fee | in branch payment fee
over the counter fee | otc fee | counter payment fee | teller fee
dormant account fee | inactivity fee | sms alert fee | alert fee | online banking fee

# overdraft  <-- Andrew named this
overdraft fee | overdraft charge | od fee | unauthorized overdraft fee
unauthorised overdraft fee | excess overdraft fee | overdraft protection fee

# failed / returned
returned payment fee | returned cheque fee | returned check fee | nsf fee
insufficient funds fee | r d cheque | stop payment fee | recall fee

# cash / transfer
cash advance fee | atm fee | atm withdrawal fee | withdrawal fee
wire transfer fee | transfer fee | balance transfer fee | cheque book fee | chequebook fee

# FX / cross-border
fx fee | fx levy | foreign transaction fee | foreign currency fee
foreign currency conversion | currency conversion fee | cross border fee
international transaction fee | exchange fee

# misc
processing fee | handling fee | transaction fee | e commerce fee
government levy | stamp duty | duty fee
```

**Tier 7 — `adjustment`**
```
adjustment | account adjustment | balance adjustment | misc adjustment
miscellaneous adjustment | write off | writeoff | waiver | fee waiver
rebate | cashback | cash back | loyalty credit | points redemption | rewards redemption
goodwill credit | courtesy credit
```

**Tier 8 —** fall through to the parser's `kind`; if absent, `purchase`. **Never `balance_summary` by fallback.**

```sql
create or replace function classify_line_kind(p_description text, p_model_kind text)
returns text language sql immutable as $$
  select case
    when norm_desc(p_description) ~ ' (minimum payment|…|finance charge summary) ' then 'balance_summary'
    when norm_desc(p_description) ~ ' (reversal|…|duplicate reversal) '            then 'reversal'
    when norm_desc(p_description) ~ ' (refund|…|cancellation) '                    then 'refund'
    -- ' fee ' guard: RETURNED PAYMENT FEE is a fee, not a payment.
    when norm_desc(p_description) !~ ' fee '
     and norm_desc(p_description) ~ ' (payment thank you|…|preauthorized payment) ' then 'card_payment'
    when norm_desc(p_description) ~ ' (interest|…|interest adjustment) '           then 'interest'
    when norm_desc(p_description) ~ ' (overlimit fee|…|duty fee) '                 then 'fee'
    when norm_desc(p_description) ~ ' (adjustment|…|courtesy credit) '             then 'adjustment'
    when p_model_kind in ('purchase','fee','interest','card_payment','refund',
                          'reversal','adjustment')                                then p_model_kind
    else 'purchase'
  end;
$$;
```
Tier 4b is applied in `assign_charge()`, which can see `direction`.

### 4.2.4 Parser changes — stop deleting, start labelling

```ts
const TxnSchema = z.object({
  date: z.string().nullable().describe("Transaction date as YYYY-MM-DD"),
  description: z.string().nullable().describe("Merchant / description text"),
  amount: z.number().nullable()
    .describe("Amount as printed, ALWAYS positive, whether it is a charge or a credit"),
  direction: z.enum(["debit","credit"]).nullable()
    .describe("debit = money spent. credit = money coming back: payments to the card, refunds, reversals. Use the CR/DR marker or the credits column if the statement has one."),
  kind: z.enum(["purchase","fee","interest","card_payment","refund",
                "reversal","adjustment","balance_summary","unknown"]).nullable()
    .describe("What sort of line this is. Use 'unknown' if unsure — never guess 'purchase'."),
  currency: z.string().nullable(),
  card_last4: z.string().nullable(),
  raw_line: z.string().nullable()
    .describe("The line exactly as printed, including any CR/DR marker"),
});
```

Replacement prompt rules for `parse-statement.ts:34`:

> - Include EVERY line in the transaction table — purchases, payments, refunds, credits, fees, interest. Do not omit anything. Label each one with `kind` and `direction` instead.
> - Do not include summary figures printed outside the transaction table (minimum payment due, previous balance, new balance). **If you are unsure whether a line is a transaction or a summary, INCLUDE it with `kind: "balance_summary"` rather than dropping it.**
> - Also return the statement's printed total purchases, total payments/credits, and closing balance if they are shown.

**That inversion — never drop, always label — is the single most important change in this design.** It converts an invisible, unrecoverable deletion into a visible, correctable row.

### 4.2.5 Correction, persistence, and what Andrew sees

Two directions: **(a)** *"This isn't bank crap — I need a receipt for it"* on every suppressed row, one tap; **(b)** *"This is bank crap — stop asking"* on every purchase row, behind the kind picker. Both call `setLineKind` (Step 11), which fixes this charge, writes the `line_kind` rule, and sweeps history via `noise_key`.

Suppressed lines are **always on screen** as collapsed summary rows — never a filter, never a deletion:

```
64 charges across 4 statements

  To chase                    41    TTD 22,150.00      ← the worklist
  Bank charges (no receipt)    3    TTD    145.00   ▸  ← fee + interest
  Payments & credits           2   −TTD  5,000.00   ▸  ← card_payment + refund + reversal
  Not transactions             1                    ▸  ← balance_summary
  ───────────────────────────────────────────────
  Spend this period                 TTD 22,295.00
  Net movement                      TTD 17,295.00
  Statement says                    TTD 17,295.00  ✓
```

Language: *"Bank charges — no receipt needed"*, *"Payments you made to the card — not spending"*, *"Lines we couldn't read as a transaction"*. Never `no_receipt_expected`.

## 4.3 Scoring and the auto-confirm gate

### 4.3.1 What is demonstrably broken

- `scorePair` (`match.ts:97`) weights `aScore·0.5 + dScore·0.2 + vScore·0.2 + card`. **Vendor agreement — the strongest available evidence of merchant identity — contributes less than date proximity plus the card bonus.** That is the precise mechanism that swapped 224.70 (01 Jun) and 222.32 (03 Jun): both scored above 85 and both auto-confirmed, because same-day proximity outweighed exact amount.
- Card mismatch is only `−0.15` (`:94`) — not a disqualifier.
- No currency check anywhere: a USD receipt is compared on `ttd_amount` blindly.
- `candidates.sort((a,b) => b.confidence - a.confidence)` (`:124`) has **no tiebreaker**, and neither load in `actions.ts` (`:22-25`, `:43-46`) has an `.order()`. PostgREST guarantees no row order without one, so two identical runs can produce different assignments on tied scores. **Idempotency is impossible until both are fixed.**
- No exact-amount pre-pass. No candidate windowing at all (`:43-46` takes every receipt ever uploaded) — the mechanism behind the July receipts pulled onto April–June charges at 43/50/71 days.

### 4.3.2 The gate

Auto-confirm is not a single number. In order:

1. **Exact-amount pre-pass** before the greedy loop.
2. **Conjunctive gate:** amount agreement **AND** (alias hit **OR** IDF vendor score ≥ 0.6) **AND** card not mismatched **AND** within `date_tolerance_days`.
3. **Uniqueness margin: no rival candidate within 3 points.** This is the load-bearing half. The conjunctive gate alone would *not* have stopped the 224.70/222.32 swap — both wrong pairs have plausible amounts and same-week dates. What stops it is refusing to guess when two candidates score near-identically. §4.1.4 shows why this matters *more* after aliasing: all three Hyatt receipts score 1.00 against the same charge.
4. **`auto_confirm_enabled`** (`0014:23`, default `false`) is actually consulted.
5. **Deterministic sort:** confidence desc → |amount diff| asc → |date diff| asc → charge_id → receipt_id.

`STRONG_CONFIDENCE` 75 → **82**; `MIN_CONFIDENCE` stays 40. Null date 0.3 → **0.25**.

### 4.3.3 Currency-aware exactness — the thing every earlier design got wrong

Sixteen receipts are USD. `ttd_amount` derives from one scalar `user_settings.usd_to_ttd_rate` (`0001:66`, default 6.8) while the bank applies its own rate on the day — a measured **~0.45% gap**. An absolute `< 0.005` test like `attach-receipt.tsx:103` **can never fire for a USD receipt**, so an exact-amount pre-pass, an EXACT pill and a green ring at absolute tolerance would put every USD receipt permanently in the dimmed tier.

```ts
// lib/reconciliation/amounts.ts
export type Tier = "exact" | "near" | "far";

export function amountVerdict(
  chargeAmount: number | null, chargeCurrency: string | null,
  receipt: { ttd_amount: number | null; currency: string | null }
): { tier: Tier; delta: number } {
  const a = Number(chargeAmount ?? NaN);
  const b = Number(receipt.ttd_amount ?? NaN);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { tier: "far", delta: NaN };
  const delta = b - a;
  const sameCurrency =
    (receipt.currency ?? "TTD").toUpperCase() === (chargeCurrency ?? "TTD").toUpperCase();
  // Same currency: cents. Cross-currency: 0.75% absorbs the FX spread between
  // usd_to_ttd_rate and the rate the bank actually applied on the day.
  const exactTol = sameCurrency ? 0.01 : Math.max(0.01, Math.abs(a) * 0.0075);
  if (Math.abs(delta) <= exactTol) return { tier: "exact", delta };
  if (Math.abs(delta) <= Math.abs(a) * 0.05) return { tier: "near", delta };
  return { tier: "far", delta };
}
```

Every exactness affordance in the app — pre-pass, pill, ring, sort — routes through this one function. **Every confirmed USD match also writes back the implied observed rate** (`charge amount / receipt.amount`) into the run summary, so Andrew can see the drift.

**Deliberate departure:** `far` rows are dimmed but **still accept a drop**. A hard refusal blocks legitimate work — a receipt covering part of a charge, a tip added at the terminal, a rounding error the parser made — and on a phone leaves no route forward. Undo is the confirmation step; a modal is not.

## 4.4 Incremental processing

### 4.4.1 The verdict, and why the two obvious designs are wrong

**"Incremental" is suppression of already-*decided* pairs, never narrowing of the input set. The scoring pass stays a full, unconditional, idempotent recompute.**

- **A per-receipt flag (`receipts.last_matched_at`) — rejected.** The unit of work is a *pair*; the flag knows one side. `assign_charge()` creates a new charge the moment any new statement line lands, and every one must be scored against every existing receipt. To be correct the predicate degenerates to `receipt.last_matched_at > (select max(created_at) from charges)` — a full rescan wearing a flag. It also cannot express a negative, and `receipts.updated_at` cannot substitute (§2.2 Section C).
- **A per-run high-water mark — rejected as a correctness mechanism.** This is the design that fails the brief's own scenario. Andrew 1 is almost entirely contained in Andrew 3; 24 of 64 charges appear on 2+ statements. Upload a statement today and it introduces charges whose correct receipts were **all** uploaded before the watermark, so `receipts.created_at > watermark` returns nothing and every one of those charges reports missing forever. It also misses edits entirely (`saveReceipt` at `lib/receipts/actions.ts:89-110` never touches `created_at`), and a partially-failed run either advances the mark and loses work or does not and redoes everything.
- **Content hashing as an optimisation — rejected.** To know whether a pair's hash changed you must enumerate the pair, which is the O(C×R) work you were avoiding. A hash never saves the scoring. It is used for exactly one thing: detecting that the evidence a *rejection* was made against no longer exists.

### 4.4.2 The suppression predicate

```sql
-- a pair (c, r) is SUPPRESSED iff
exists (select 1 from receipt_statement_matches m
        where m.charge_id = c.charge_id
          and m.receipt_id = r.id
          and (m.confirmed
               or (m.rejected_at is not null
                   and m.rejected_fingerprint is not distinct from r.match_fingerprint)))
```

`is not distinct from` is deliberate: a rejection written before `0019` has `rejected_fingerprint IS NULL`, which must **not** silently equal a real fingerprint. Hence the backfill in §2.2 Section D.

Plus: charges where `is_open = false`; receipts where `is_open = false`; receipts already confirmed elsewhere (`rsm_unique_confirmed_receipt`, `0013:14-16`).

**Deliberately NOT stored: scores that fell below threshold.** 64 charges × 82 receipts ≈ 5,200 `scorePair` calls is single-digit milliseconds. The expensive thing is not CPU, it is re-showing Andrew a suggestion he already dismissed — solved by rejection durability, not caching. Caching would also need an `ALGO_VERSION` and a re-score migration, because the scorer is about to be rewritten. **Full recompute has no version to bump.**

### 4.4.3 Upsert and sweep, never delete-then-insert

```ts
await supabase.from("receipt_statement_matches").upsert(
  pairs.map(p => ({
    user_id: user.id, receipt_id: p.receipt_id, charge_id: p.charge_id,
    statement_transaction_id: p.canonical_txn_id,
    status: p.status, confidence: p.confidence,
    confirmed: p.autoConfirm, decided_via: p.autoConfirm ? "auto" : null,
    last_seen_run_at: runAt,
  })),
  { onConflict: "receipt_id,charge_id" }          // rsm_unique_pair, 0016:160-161
);

// SWEEP: retire suggestions this run no longer produces. Decisions are immune.
await supabase.from("receipt_statement_matches").delete()
  .eq("confirmed", false).is("rejected_at", null)
  .not("charge_id", "is", null).lt("last_seen_run_at", runAt);
```

`charge_id` is passed explicitly rather than relying on the `rsm_sync_charge` trigger: `rsm_unique_pair` is a plain unique index, so rows with `charge_id IS NULL` are never deduped (Postgres treats NULLs as distinct).

**The live bug this replaces:** `lib/matching/actions.ts:65-69` is `.delete().in("statement_transaction_id", txnIds).eq("confirmed", false)`. **A rejected row has `confirmed = false`.** Fixing `rejectMatch` alone would leave the next run deleting the rejection anyway. Both ship together (Step 10).

### 4.4.4 The three hard cases

**A receipt is edited after being processed.**
- *Edited while confirmed:* the confirmation stands. A human asserted merchant identity; a typo fix does not undo it, and a stale confirmation fails **visibly** — it sits on the charge with an Unmatch button.
- *Edited while rejected:* the rejection is **invalidated** if `match_fingerprint` changed, and the pair returns labelled *"You said no to this before — the receipt has changed since."* This asymmetry decides the whole design: a stale rejection fails **invisibly**. Concretely — Andrew rejects a 224.70 receipt against a 222.32 charge, then corrects the receipt to 222.32. Under any watermark or flag design that match is lost permanently and silently.
- *Edited in a way that does not affect matching* (sent, paid, notes, category, duplicate flag): fingerprint unchanged, nothing resurfaces. That is why the fingerprint is a hand-picked field list.

**A new statement introduces charges that old receipts now match.** Found automatically, because the receipt input set is never narrowed by time-of-run. The one thing that could narrow it wrongly is the candidate window, made safe by three rules: anchored to the **charge's** `anchor_date`, never a statement period or a run timestamp; confirmed and sent receipts exempt (`0014:25-26`); and **visible** — the run reports how many receipts fell outside it, and manual attach and the board apply **no window at all**.

**Re-running is idempotent.** Requires the deterministic tiebreakers of §4.3.2 *and* explicit `.order()` on both loads. With those plus upsert-and-sweep, run N and run N+1 over unchanged data produce byte-identical rows — including unchanged `created_at`, which is what keeps the NEW badges honest.

### 4.4.5 Visible or invisible?

**The mechanism is invisible and unconditional. The word "new" is visible and purely cosmetic.** Andrew asked for this in user-facing terms because what he wants is not to re-read things he has already dealt with. If the two are conflated, the app quietly stops looking — which on this dataset means charges carried onto a second statement go unmatched exactly as they did before `0015` was written.

```sql
-- open items that appeared since Andrew last looked
select 'charge' as kind, c.charge_id as id
from charge_reconciliation c join charges ch on ch.id = c.charge_id
where c.is_open and ch.created_at > :last_reconcile_seen_at
union all
select 'receipt', r.receipt_id from orphan_receipts r
where r.is_open and r.created_at > :last_reconcile_seen_at;
```

`last_reconcile_seen_at` advances only when Andrew opens `/reconcile` or taps "mark all seen" — **never on a run**, so an auto-fired run after a statement parse cannot clear badges he never saw. `last_reconcile_run_at` drives only the *"last checked 2 hours ago"* line.

## 4.5 The pairing surface

### 4.5.1 Library decision: none

`package.json:11-21` has nine runtime dependencies and no drag library, no gesture library, no virtualiser.

- **HTML5 drag-and-drop is disqualified.** `dragstart`/`dragover`/`drop` never fire from touch on iOS Safari, and `app/manifest.ts:12-13` declares `display:"standalone", orientation:"portrait"` — the phone is the primary target.
- **`@dnd-kit/core` (~34 kB gz) / `@hello-pangea/dnd` (~90 kB gz) rejected.** Both are sortable-list engines: reorderable collections, collision-detection strategies, transform-based reflow. We need one gesture — pick one card, put it on one card in the other list; nothing reorders, nothing reflows, two lists, no nesting. dnd-kit's activation constraint is ~15 lines of what we write ourselves and its collision detection is replaced by one `elementFromPoint` call.

**Chosen: Pointer Events + `document.elementFromPoint`,** with a hard split — touch gets **tap-to-hold only**; mouse and pen get tap-to-hold *and* press-and-move drag on one code path; keyboard gets Enter/Space to hold, Enter to place, Escape to cancel.

### 4.5.2 Files

```
app/(app)/reconcile/board/page.tsx          server: auth + loadCloseOut + <Board/>
components/reconcile/board/board.tsx        "use client": layout, tabs, useOptimistic, live region
components/reconcile/board/use-pairing.ts   "use client": hold state + pointer core
components/reconcile/board/charge-row.tsx   memo()
components/reconcile/board/receipt-row.tsx  memo()
components/reconcile/board/held-bar.tsx     sticky mobile action bar + drag ghost
```

`usePairing` and `amountVerdict` are independent of the board layout, so the same held-state rendering mounts inside the row-level attach flow on `/reconcile` without duplicating the interaction.

### 4.5.3 The interaction core

```tsx
// components/reconcile/board/use-pairing.ts
"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type Side = "charge" | "receipt";
export type HeldItem = { side: Side; id: string; label: string; sub: string };

const SLOP = 8;            // px of movement before a press becomes a drag
const EDGE = 72;           // px band at a panel edge that auto-scrolls
const EDGE_SPEED = 14;     // px per frame

export function usePairing(pair: (chargeId: string, receiptId: string) => void) {
  const [held, setHeld] = useState<HeldItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [overId, setOverId] = useState<string | null>(null);

  const heldRef = useRef<HeldItem | null>(null);
  heldRef.current = held;                     // handlers read this, never stale
  const press = useRef<{ x: number; y: number; pid: number } | null>(null);
  const point = useRef({ x: 0, y: 0 });
  const ghost = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);

  const clear = useCallback(() => {
    press.current = null; setHeld(null); setDragging(false); setOverId(null);
  }, []);

  /** Screen point -> droppable row id on the OPPOSITE side, or null. */
  const targetAt = useCallback((x: number, y: number) => {
    const h = heldRef.current;
    if (!h) return null;
    // One hit-test per frame. Correct under scroll and overflow without caching
    // 107 DOMRects. The ghost MUST be pointer-events:none or it shadows this.
    const row = (document.elementFromPoint(x, y) as HTMLElement | null)
      ?.closest<HTMLElement>("[data-drop-id]");
    if (!row || row.dataset.dropSide === h.side) return null;
    return row.dataset.dropId ?? null;
  }, []);

  const commit = useCallback((targetId: string) => {
    const h = heldRef.current;
    if (!h) return;
    h.side === "charge" ? pair(h.id, targetId) : pair(targetId, h.id);
    clear();
  }, [pair, clear]);

  /* ---------- TAP-TO-HOLD -- every input type, the primary flow ---------- */
  const activate = useCallback((item: HeldItem) => {
    const h = heldRef.current;
    if (!h) return setHeld(item);                       // pick up
    if (h.side !== item.side) return commit(item.id);   // place -> match
    setHeld(h.id === item.id ? null : item);            // same side: swap or drop
  }, [commit]);

  /* ---------- DRAG -- mouse/pen only, shares commit() ---------- */
  const onPointerDown = useCallback((e: React.PointerEvent, item: HeldItem) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    press.current = { x: e.clientX, y: e.clientY, pid: e.pointerId };
    point.current = { x: e.clientX, y: e.clientY };
    setHeld(item);

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== press.current?.pid) return;
      point.current = { x: ev.clientX, y: ev.clientY };
      const far = Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y);
      if (!dragging && far < SLOP) return;              // still a click, not a drag
      setDragging(true);
      ev.preventDefault();                              // suppress text selection
      if (!frame.current) frame.current = requestAnimationFrame(tick);
    };

    const tick = () => {
      frame.current = 0;
      const { x, y } = point.current;
      if (ghost.current) ghost.current.style.transform =
        `translate3d(${x + 12}px, ${y + 12}px, 0)`;     // no React render per move
      const t = targetAt(x, y);
      setOverId((prev) => (prev === t ? prev : t));      // render only on change
      autoScroll(y);
      if (press.current) frame.current = requestAnimationFrame(tick);
    };

    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== press.current?.pid) return;
      const wasDrag = dragging;
      const t = wasDrag ? targetAt(ev.clientX, ev.clientY) : null;
      teardown();
      if (!wasDrag) return activate(item);               // a plain click = pick up
      t ? commit(t) : clear();                           // dropped on nothing = cancel
    };
    const cancel = () => { teardown(); clear(); };

    function teardown() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0; press.current = null; setDragging(false); setOverId(null);
    }

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }, [dragging, activate, commit, clear, targetAt]);

  useEffect(() => {                                      // Escape always releases
    if (!held) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clear(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [held, clear]);

  return { held, dragging, overId, activate, onPointerDown, ghostRef: ghost, clear };
}

function autoScroll(y: number) {
  const panel = document.querySelector<HTMLElement>('[data-panel][data-active="true"]');
  if (!panel) return;
  const r = panel.getBoundingClientRect();
  if (y < r.top + EDGE) panel.scrollTop -= EDGE_SPEED;
  else if (y > r.bottom - EDGE) panel.scrollTop += EDGE_SPEED;
}
```

Only `held`, `dragging` and `overId` are React state, and `overId` changes at most a few times per drag. Ghost position is a direct style mutation inside `requestAnimationFrame` — 60 fps with zero reconciliation.

### 4.5.4 Held-state rendering — requirement 6 as a visual property

The moment anything is held, the **opposite** panel re-sorts and the near side does not move (so the held row stays under the thumb):

```ts
const ranked = useMemo(() => {
  if (!held || held.side !== "charge") return view.receipts;
  const c = view.charges.find(x => x.charge_id === held.id);
  return [...view.receipts]
    .map(r => ({ r, v: amountVerdict(c?.amount ?? null, c?.currency ?? null, r) }))
    .sort((a, b) =>
      (a.v.tier === "exact" ? 0 : 1) - (b.v.tier === "exact" ? 0 : 1) ||
      Math.abs(a.v.delta) - Math.abs(b.v.delta) ||
      a.r.receipt_id.localeCompare(b.r.receipt_id))       // deterministic
    .map(x => x.r);
}, [held, view]);
```

`exact` → green **EXACT** pill, pinned to the top. `near` → signed delta in mono (`+TTD 4.20` / `−TTD 2.38`), amber. `far` → 40% opacity, still droppable. An `aria-live="polite"` region announces *"Holding PriceSmart 224.70. 3 receipts match this amount."*

**Visual grammar, entire:** dashed = proposed · solid = confirmed · struck through = crossed off. Suggestion pre-links render as an inline dashed amber receipt chip beneath the charge row with `Yes, that's it` / `Not this one`, and the corresponding receipt row carries a dashed amber outline and `suggested ↖`. **No connector lines** — SVG between two independently-scrolling panels is fragile and worthless on a phone where only one panel is visible.

### 4.5.5 Optimistic cross-off

Crossing off is a **state, not an unmount**, which is what makes it animatable in plain React:

```css
/* app/globals.css — after the .stagger block at :143-154 */
@keyframes cross-off {
  0%   { opacity: 1; max-height: 12rem; }
  30%  { background: color-mix(in srgb, var(--brand) 14%, #fff); }
  100% { opacity: 0; transform: translateX(8px) scale(.98);
         max-height: 0; margin-block: 0; padding-block: 0; border-width: 0; }
}
.crossing { animation: cross-off 340ms var(--ease-out) forwards; overflow: hidden; }
.crossing .row-title { text-decoration: line-through; }
```

`--ease-out` and `--brand` already exist (`app/globals.css:13,18`) and the `prefers-reduced-motion` block at `:157` already collapses this to an instant removal. The animation runs ~340 ms; the round trip and `revalidatePath` land at ~400–600 ms, so the two overlap into one motion.

The failure path needs no rollback code: when the action rejects and `revalidatePath` produces identical props, React retires the optimistic op automatically and the rows reappear. That is the reason to use `useOptimistic` here rather than hand-rolled local state.

### 4.5.6 Layout, virtualisation, terminal states

Portrait phone cannot show two columns. Below `md`: a segmented control (`Charges 41` / `Receipts 43`), one panel visible; picking something up **auto-switches to the other tab** and shows a sticky bar above `env(safe-area-inset-bottom)` reading *"Placing: PEAKE PETROLEUM · TTD 224.70 — tap a receipt"* with Cancel. At `md`+: `grid md:grid-cols-2`, each panel `overflow-y-auto`, page body never scrolls horizontally.

**Virtualisation: no.** 64 + 43 = 107 rows ≈ 900 DOM nodes — an order of magnitude below where a browser struggles, and fewer than `/matching` renders today (`page.tsx:343` already lists 50 receipts plus five other sections). Virtualising would actively hurt: rows unmount mid-drag and break `elementFromPoint`; Ctrl-F stops finding a vendor; auto-scroll has to reconcile with a virtual scroller's offset maths. Instead, at ~1/50th the cost: `React.memo` on both row components comparing `id, crossed, isHeld, isOver, tier`; ghost movement via direct `style.transform`; one `elementFromPoint` per frame; `content-visibility: auto; contain-intrinsic-size: 0 76px;` on rows. **Revisit threshold: ~400 rows sustained in either panel — and the answer then is server-side filtering and a search box, not a virtualiser.**

Four terminal states, all distinct: both non-empty (the working board); **left empty, right non-empty** → *"Every charge on your statements has a receipt. N receipts have no statement line"* + the bulk **Send these to the accountant** button from Step 13; right empty, left non-empty → *"N charges still need a receipt"* → `/upload`; both empty → the green complete state, the session count crossed off, and a link to the close-out PDF.

---

# 5. WHAT WE ARE DELIBERATELY NOT DOING

## 5.1 Superseded from the old plan

| Old plan | Status |
|---|---|
| **Step 4c — month scoping**, `?month=YYYY-MM`, month picker, `dateFrom`/`dateTo` | **CANCELLED.** §1.2. |
| **`reconciliation_months` view** (`0017:126-146`) | **DROPPED** in `0019`. Zero consumers. |
| **Step 6's `?all=1` / `?state=` / `?rp=` scheme** on `/matching` | Replaced by `/reconcile` with filter chips over an outstanding-first model. `/matching` retired at Step 14. |
| **The 4-value `ChargeState`** (`plan:662`, `plan:483-489`) | Wrong. The applied view has **five** states (`0017:73-79`); this plan adds `is_open` alongside. |
| **Every reference to `rsm_backup_pre_0015`** (`plan:256,331-346,365,368,914-915,923`) | The table is `rsm_backup_pre_0016` (`0016:14-15`). |
| **Step 2's "keep earliest" demotion tie-break** (`plan:341-345`) | Superseded by the closest-amount/closest-date/highest-confidence ranking actually applied (`0016:131-150`). |
| **Step 4b's figures** — 39 orphans / 24 unsent / TTD 10,772.75 (`plan:519-522`, and the comment at `0017:94`) | Measured reality is **43 / 27 / TTD 11,648.69**. |
| **Step 9's per-statement PDF as the deliverable** | Replaced by one consolidated close-out PDF built from `charge_reconciliation`. |

## 5.2 Rejected on the merits

- **A `reconciliation_runs` table with run-history and run-result screens.** Its own design concedes the watermark is advisory and correctness never depends on it. `decided_via` plus two scalars deliver attribution, the "auto-closed this run" tray and per-item undo with zero new tables and zero new screens. Run status pills, red failed-run rows and a batch-undo button are an operator console; Andrew is one non-technical owner on a phone.
- **Caching scores / a per-pair processed table / an `ALGO_VERSION`.** §4.4.2.
- **`pg_trgm` / trigram or fuzzy distance matching.** Cheap, but confidently wrong between short names in a small market, and no migration enables the extension.
- **Prefix matching as sufficient evidence.** `star` prefix-matches `starbucks`. Used one-way (§4.1.3 rule b) and as a tiebreaker only.
- **Feeding aliases into `charge_key_of`.** §4.1.5 guard 4.
- **Virtualising the board.** §4.5.6.
- **HTML5 drag-and-drop, and drag on touch at all.** §4.5.1.
- **`vendors` as the canonical alias target.** Dead table. §2.3.

## 5.3 Where an AI/model call was considered — the answer, with evidence

Andrew asked whether to bring AI in. Three separate questions, three different answers.

**REJECTED — a model call in the matching path ("are these the same merchant?").**
- 64 charges × 86 receipts = **5,504 pairs**. Per-pair calls are absurd. Even one call per open charge is ~30 round trips per run, against an engine that must be idempotent and re-runnable (§4.4.4).
- The output is non-deterministic and unauditable, and would still require Andrew's confirmation — so it saves nothing over showing him a ranked list.
- **The residual it would address is tiny and measured.** The deterministic pipeline in §4.1 handles **19 of the 20 required pairs** and every non-collision, at 24 pairs ≥0.60 across the full 928-pair cross product with 23 true positives. After amount and date gating, an unmatched charge has ~1–3 plausible receipts.
- The one real gap is `CAL_CORP_CTO TRINIDAD` ↔ `Caribbean Airlines` (5 charges, score 0.00 — zero shared tokens, deterministically unsolvable). **One drag on the board resolves it permanently, writes the alias, and solves all five CAL charges from then on.** That is a better product outcome than a guess.

**ACCEPTED — and expanded — the existing ingest call.** `parseStatement` (`lib/extraction/parse-statement.ts:42-83`) is already one `messages.parse` call per statement. **The parser is the only place in the entire pipeline that can still see the CR marker, the credit column, or the fee section** — that information is destroyed at `:13` ("ignore payments/credits") and is unrecoverable afterwards, because `statement_transactions` has no `raw_extraction` equivalent (unlike `receipts`, `0001:147`). So `line_kind`, `direction`, `raw_line` and the three printed totals are added to the schema it already returns (§4.2.4). **Zero additional API calls.** The SQL classifier becomes the safety net for `kind: "unknown"`, not the sole mechanism.

**CONDITIONALLY ACCEPTED, LATER, BOUNDED — one batched alias-proposal call per run.** Only *after* the board ships (Step 12). Send the still-open zone keys (~30 short strings) and orphan receipt vendor keys (~30) in **one** request asking only "which of these are the same merchant?" — well under 2k tokens, one call, using the existing `@anthropic-ai/sdk` client pattern. Write results as `learning_rules` rows with `action.source = "model"` and `hit_count = 0`, and use them **only to reorder the board's right-hand list — never to score, never to auto-confirm.** A model proposal that a human then drags becomes a real alias through the normal path. **If Step 12 makes the residue feel small, do not build this at all.**

## 5.4 One open question for Andrew

**"When you say overdraft fees — are you also giving me current-account (chequing) statements, not just the credit card?"**

`parse-statement.ts:31` is hard-coded to "credit card statement". On a chequing statement `BILL PAYMENT TSTT` is a real expense that needs a receipt, whereas on a card statement `PAYMENT` means a payment to the card. Tier 4b's direction gate (§4.2.3) is what keeps that safe today. A "yes" means the prompt needs a second document mode, and that should be settled before Step 11.

---

# 6. RISKS AND DATA SAFETY

## 6.1 Everything that touches existing rows, and how to reverse it

| What | Migration | Reversal |
|---|---|---|
| **Reclassification of all 64 charges and 90 lines** — `line_kind`, `direction`, `kind_source`, and **`no_receipt_expected` can be both SET and UNSET** | `0019` §F | `charges_backup_pre_0019` / `stmt_txn_backup_pre_0019` (§A). `update charges c set no_receipt_expected = b.no_receipt_expected, fee_auto_flagged = b.fee_auto_flagged from charges_backup_pre_0019 b where b.id = c.id;` |
| **Auto-closing fee/interest/payment/summary charges** (`closed_at`, `closed_by='auto'`, `closed_reason`) | `0019` §F | Same backup; or `update charges set closed_at=null, closed_by=null, closed_reason=null where closed_by='auto';` — and every one is visible in the "Auto-closed since you last looked" tray with one-tap Reopen. |
| **`amount >= 0` check on `statement_transactions`** | `0019` §E | Fails loudly on apply if any negative exists (there are none). `alter table … drop constraint stmt_txn_amount_nonneg;` |
| **`state` CASE reorder in `charge_reconciliation`** | `0019` §H | `create or replace view` with the `0017:73-79` body. Affects zero rows in current live data. |
| **`orphan_receipts` widened to `needs_review`** | `0019` §H | Same. It only *adds* rows; the badge marks them. |
| **`drop view reconciliation_months`** | `0019` §H | Re-run the `create or replace view` from `0017:126-146`. Zero consumers, verified. |
| **`receipts` table rewrite** for the STORED generated column | `0019` §C | `alter table receipts drop column match_fingerprint;` 86 rows — instant. |
| **`rejectMatch` stops deleting** | Step 10 code | Behavioural, not destructive: it now writes where it previously destroyed. Code revert. |
| **`deleteStatement` gains a guard** | Step 5 code | Code revert. Today's version is the dangerous one. |

**Nothing in this plan deletes a receipt, a statement, a charge, or a confirmed match.** The only `delete` in the whole design is the sweep of *unconfirmed, unrejected* suggestion rows that a run no longer produces (§4.4.3).

## 6.2 The biggest risk: taking work off the list without Andrew knowing

A close-out ledger is only useful if the number is trustworthy, and there are exactly two ways to destroy that trust.

**(a) Silent auto-close.** The noise regex broadens substantially in `0019`. If it over-matches, a real chaseable charge vanishes with `closed_by='auto'` and Andrew never learns it existed — the count reads zero while money is unclaimed. Mitigations: whole-token matching kills the `PINTEREST`-class bug that exists **today**; the backfill `raise notice`s a before/after count *and* the number of previously-flagged charges it **unflagged**; `fee_auto_flagged` (`0015:51`) keeps machine decisions distinguishable from human ones; every auto-closed item lands in the review tray with one-tap Reopen; the run banner always names what the machine did.

**(b) Silent auto-confirm.** The matcher has demonstrably produced confident wrong pairs — 224.70 and 222.32 received each other's receipts, both above 85, both auto-confirmed. An auto-confirmed wrong match closes **two** items with one error and sends the wrong document to the accountant. Mitigations in order of load-bearing-ness: the **uniqueness margin** (§4.3.2 step 3) is what refuses to guess between two near-identical candidates — the conjunctive gate alone would not have stopped it; `auto_confirm_enabled` stays `false` (`0014:23`) and is actually read; `STRONG_CONFIDENCE` rises to 82; the greedy sort becomes deterministic; the candidate window (60/15) removes the July-onto-April class entirely; and five known-bad live pairs become regression fixtures at Step 9.

## 6.3 The hazards adjacent to this design

1. **`receipt_statement_matches.charge_id` is `ON DELETE CASCADE` to `charges` (`0016:18`).** The rollback documented at `0015:18-19` (`truncate charges cascade`) would destroy **every decision** — the entire "processed" ledger. **Strike that rollback from the comment in `0019`.** The correct rollback for charge identity is now a restore from `charges_backup_pre_0019`, never a truncate.
2. **Deleting a statement orphans charges out of the read model.** `charge_reconciliation` inner-joins statement lines (`0017:41`), so a charge whose only statement was deleted vanishes from the view while its confirmed match row survives pointing at nothing. Once a count is on screen, it moves with no stated reason. **This is why Step 5 is first and is a hard prerequisite, not a later step.**
3. **Nothing currently defines completeness against the paper statement.** `TxnSchema` carries no raw line text and no per-line confidence; `app/api/statements/parse/route.ts:130` returns `{ok:true, count:0}` on a zero-transaction parse, which `components/statements/statement-uploader.tsx:152-155` renders as a **green badge**. So "everything crossed off" could mean "the parser found 12 of 34 lines and you crossed off all 12." The `printed_*` totals (§2.2 §I) and the completeness line (Step 11) are the only real check that will exist, and until they land the header must say so.
4. **Two statements parsed with `period_start IS NULL`** and `0014:33-40` backfilled them without recording that it had. Any header or report printing a period must read **"dates inferred from transactions"** unless it was genuinely read off the document (§2.2 §I, Step 13).
5. **`learning_rules` is read by an unfiltered, unpaginated `select("*")`** on every receipt extraction (`app/api/receipts/extract/route.ts:121`). Adding `vendor_alias` and `line_kind` rows makes that query strictly worse. **Filter it by `rule_type` in the same PR that adds either type** (Step 9).
6. **`rsm_unique_pair` is a plain unique index**, so rows with `charge_id IS NULL` are never deduped. `upsert(..., { onConflict: "receipt_id,charge_id" })` only behaves as intended when `charge_id` is explicitly non-null — which is why every write in this plan passes it.

---

## Appendix — the numbers this plan is measured against

| Fact | Value |
|---|---|
| Statement lines / real charges | 90 → **64** |
| Charges on 2+ statements | **24** (one on three) |
| Total inflation removed | TTD 42,920.49 → **30,583.05** (−12,337.44, 29%) |
| Falsely "missing receipt" lines | **15**, of which **12 already sent** |
| Receipts | 81–82 (86 rows including duplicates) |
| Receipts with no statement line | **43**, of which **27 unsent** worth **TTD 11,648.69** |
| Receipts filed under the wrong month | **62 of 82** |
| Charges with two receipts confirmed | **4** (demoted by `0016:131-150`) |
| Statements that parsed no period | **2** |
| USD receipts | **16**, consistent ~0.45% FX gap |
| Known-bad matcher pairs (regression fixtures) | 224.70/222.32 swap + 4 July-onto-April/June at 43/50/71 days |

---

Written to `c:/Users/Andrew/OneDrive/Documents/Tayeng Receipt App/tayeng-app/docs/close-out-plan.md`. The superseded document remains at `c:/Users/Andrew/OneDrive/Documents/Tayeng Receipt App/tayeng-app/docs/reconciliation-plan.md` — its Steps 1–4 are still the correct record of what was applied; its Steps 5–11 and Step 4c are dead.