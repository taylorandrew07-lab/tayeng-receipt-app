-- ============================================================================
-- Row Level Security — every table is locked down to its owning user.
-- Pattern: enable RLS, then a single "own rows" policy keyed on auth.uid().
-- profiles/user_settings key on id/user_id = auth.uid() directly.
-- ============================================================================

-- Helper macro is not possible in plain SQL, so policies are written per table.

-- profiles ------------------------------------------------------------------
alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);

create policy "profiles_update_own" on profiles
  for update using (auth.uid() = id)
  with check (
    auth.uid() = id
    -- prevent self-elevation: role cannot be changed by the owner
    and role = (select role from profiles where id = auth.uid())
  );

-- (insert handled by the signup trigger using security definer; no client insert)

-- user_settings -------------------------------------------------------------
alter table user_settings enable row level security;

create policy "user_settings_all_own" on user_settings
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- categories ----------------------------------------------------------------
alter table categories enable row level security;

create policy "categories_all_own" on categories
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- cards ---------------------------------------------------------------------
alter table cards enable row level security;

create policy "cards_all_own" on cards
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- vendors -------------------------------------------------------------------
alter table vendors enable row level security;

create policy "vendors_all_own" on vendors
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- receipts ------------------------------------------------------------------
alter table receipts enable row level security;

create policy "receipts_all_own" on receipts
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- receipt_files -------------------------------------------------------------
alter table receipt_files enable row level security;

create policy "receipt_files_all_own" on receipt_files
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- statements ----------------------------------------------------------------
alter table statements enable row level security;

create policy "statements_all_own" on statements
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- statement_transactions ----------------------------------------------------
alter table statement_transactions enable row level security;

create policy "statement_txn_all_own" on statement_transactions
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- receipt_statement_matches -------------------------------------------------
alter table receipt_statement_matches enable row level security;

create policy "rsm_all_own" on receipt_statement_matches
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- monthly_reports -----------------------------------------------------------
alter table monthly_reports enable row level security;

create policy "monthly_reports_all_own" on monthly_reports
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- learning_rules ------------------------------------------------------------
alter table learning_rules enable row level security;

create policy "learning_rules_all_own" on learning_rules
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================================
-- New-user provisioning: when a row is added to auth.users, create their
-- profile, settings, and a starter set of default categories.
-- SECURITY DEFINER so it can write despite RLS.
-- ============================================================================
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''));

  insert into public.user_settings (user_id)
  values (new.id);

  insert into public.categories (user_id, name, is_default)
  values
    (new.id, 'Fuel', true),
    (new.id, 'Food', true),
    (new.id, 'Office supplies', true),
    (new.id, 'Travel', true),
    (new.id, 'Equipment', true),
    (new.id, 'Online purchase', true),
    (new.id, 'Other', true);

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
