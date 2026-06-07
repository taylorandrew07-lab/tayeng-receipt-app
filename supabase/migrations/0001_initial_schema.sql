-- ============================================================================
-- Tayeng Receipt App — Initial schema
-- Multi-user. Every user-data table carries user_id and is protected by RLS.
-- ============================================================================

-- Useful enums --------------------------------------------------------------
create type card_type as enum ('personal', 'company', 'cash', 'other');

create type payment_method as enum (
  'personal_card', 'company_card', 'cash', 'online', 'unknown', 'other'
);

create type doc_type as enum (
  'receipt', 'invoice', 'statement', 'unknown'
);

create type receipt_status as enum (
  'processing',     -- uploaded, extraction running
  'needs_review',   -- uncertain, waiting on the user
  'confirmed'       -- user-confirmed or auto-classified with high confidence
);

create type match_status as enum (
  'matched', 'possible_match', 'unmatched_receipt',
  'missing_receipt', 'needs_review'
);

create type rule_type as enum (
  'vendor_category', 'last4_card', 'vendor_payment'
);

-- Reusable updated_at trigger ----------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- profiles  (1 row per auth user)
-- ============================================================================
create table profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  full_name     text,
  company_name  text,
  role          text not null default 'user' check (role in ('user', 'admin', 'super_admin')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- ============================================================================
-- user_settings  (1 row per user — created alongside the profile)
-- ============================================================================
create table user_settings (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  base_currency        text not null default 'TTD',
  usd_to_ttd_rate      numeric(12, 4) not null default 6.8000,
  date_tolerance_days  int not null default 3,
  amount_tolerance_pct numeric(5, 2) not null default 5.00,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create trigger user_settings_updated_at
  before update on user_settings
  for each row execute function set_updated_at();

-- ============================================================================
-- categories
-- ============================================================================
create table categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);
create index categories_user_id_idx on categories (user_id);

-- ============================================================================
-- cards  (user-defined payment rules)
-- ============================================================================
create table cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  nickname    text not null,
  last4       text check (last4 ~ '^[0-9]{4}$'),
  card_type   card_type not null default 'personal',
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index cards_user_id_idx on cards (user_id);
create index cards_user_last4_idx on cards (user_id, last4);

create trigger cards_updated_at
  before update on cards
  for each row execute function set_updated_at();

-- ============================================================================
-- vendors  (learned vendor -> default category mapping)
-- ============================================================================
create table vendors (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  name                text not null,
  normalized_name     text not null,
  default_category_id uuid references categories (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, normalized_name)
);
create index vendors_user_id_idx on vendors (user_id);

create trigger vendors_updated_at
  before update on vendors
  for each row execute function set_updated_at();

-- ============================================================================
-- receipts
-- ============================================================================
create table receipts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  receipt_date    date,
  month_key       text,                         -- 'YYYY-MM' bucket for the monthly workspace
  vendor_name     text,
  vendor_id       uuid references vendors (id) on delete set null,
  category_id     uuid references categories (id) on delete set null,
  doc_type        doc_type not null default 'unknown',
  amount          numeric(14, 2),
  currency        text not null default 'TTD',
  ttd_amount      numeric(14, 2),               -- converted/equivalent amount in TTD
  tax_amount      numeric(14, 2),
  payment_method  payment_method not null default 'unknown',
  card_id         uuid references cards (id) on delete set null,
  card_last4      text check (card_last4 ~ '^[0-9]{4}$'),
  reimbursable    boolean,                       -- null = undecided
  status          receipt_status not null default 'processing',
  confidence      numeric(5, 2),                 -- 0-100 extraction/classification confidence
  raw_extraction  jsonb,                         -- full model output for auditing
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index receipts_user_id_idx on receipts (user_id);
create index receipts_user_month_idx on receipts (user_id, month_key);
create index receipts_user_status_idx on receipts (user_id, status);

create trigger receipts_updated_at
  before update on receipts
  for each row execute function set_updated_at();

-- ============================================================================
-- receipt_files  (uploaded documents in Storage)
-- ============================================================================
create table receipt_files (
  id            uuid primary key default gen_random_uuid(),
  receipt_id    uuid references receipts (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  storage_path  text not null,                  -- documents/{user_id}/{month}/{receipt_id}/{file}
  file_name     text not null,
  mime_type     text,
  size_bytes    bigint,
  created_at    timestamptz not null default now()
);
create index receipt_files_user_id_idx on receipt_files (user_id);
create index receipt_files_receipt_id_idx on receipt_files (receipt_id);

-- ============================================================================
-- statements  (uploaded credit card statement PDFs)
-- ============================================================================
create table statements (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  card_id       uuid references cards (id) on delete set null,
  period_start  date,
  period_end    date,
  storage_path  text not null,
  file_name     text not null,
  created_at    timestamptz not null default now()
);
create index statements_user_id_idx on statements (user_id);

-- ============================================================================
-- statement_transactions
-- ============================================================================
create table statement_transactions (
  id            uuid primary key default gen_random_uuid(),
  statement_id  uuid not null references statements (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  txn_date      date,
  description   text,
  amount        numeric(14, 2),
  currency      text not null default 'TTD',
  card_last4    text check (card_last4 ~ '^[0-9]{4}$'),
  is_matched    boolean not null default false,
  created_at    timestamptz not null default now()
);
create index statement_txn_user_id_idx on statement_transactions (user_id);
create index statement_txn_statement_idx on statement_transactions (statement_id);

-- ============================================================================
-- receipt_statement_matches
-- ============================================================================
create table receipt_statement_matches (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  receipt_id               uuid references receipts (id) on delete cascade,
  statement_transaction_id uuid references statement_transactions (id) on delete cascade,
  status                   match_status not null default 'needs_review',
  confidence               numeric(5, 2),
  confirmed                boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index rsm_user_id_idx on receipt_statement_matches (user_id);
create index rsm_receipt_idx on receipt_statement_matches (receipt_id);
create index rsm_txn_idx on receipt_statement_matches (statement_transaction_id);

create trigger rsm_updated_at
  before update on receipt_statement_matches
  for each row execute function set_updated_at();

-- ============================================================================
-- monthly_reports
-- ============================================================================
create table monthly_reports (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  month_key     text not null,                  -- 'YYYY-MM'
  storage_path  text,                           -- generated PDF in Storage
  totals        jsonb,                          -- cached summary totals
  generated_at  timestamptz not null default now(),
  unique (user_id, month_key)
);
create index monthly_reports_user_id_idx on monthly_reports (user_id);

-- ============================================================================
-- learning_rules  (corrections that improve future automatic classification)
-- ============================================================================
create table learning_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  rule_type   rule_type not null,
  pattern     text not null,                    -- e.g. normalized vendor name, or card last4
  action      jsonb not null,                   -- e.g. {"category_id": "..."} or {"card_id": "..."}
  hit_count   int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, rule_type, pattern)
);
create index learning_rules_user_idx on learning_rules (user_id, rule_type);

create trigger learning_rules_updated_at
  before update on learning_rules
  for each row execute function set_updated_at();
