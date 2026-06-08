-- ============================================================================
-- Enforce admin approval at the DATA layer (defense in depth), and stop users
-- from approving themselves.
-- ============================================================================

-- Is the current user approved? SECURITY DEFINER so policies can call it.
create or replace function public.is_approved()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and approved = true
  );
$$;

-- A user may edit their own profile but CANNOT change their role or approval.
alter policy "profiles_update_own" on profiles
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = (select role from profiles where id = auth.uid())
    and approved = (select approved from profiles where id = auth.uid())
  );

-- Require approval for ALL access to user data (read + write). Admins are
-- approved, so they're unaffected; unapproved users can touch nothing.
alter policy "user_settings_all_own" on user_settings
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "categories_all_own" on categories
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "cards_all_own" on cards
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "vendors_all_own" on vendors
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "receipts_all_own" on receipts
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "receipt_files_all_own" on receipt_files
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "statements_all_own" on statements
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "statement_txn_all_own" on statement_transactions
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "rsm_all_own" on receipt_statement_matches
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "monthly_reports_all_own" on monthly_reports
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

alter policy "learning_rules_all_own" on learning_rules
  using (auth.uid() = user_id and public.is_approved())
  with check (auth.uid() = user_id and public.is_approved());

-- Storage: only approved users may read/write their document folder.
drop policy if exists "documents_select_own" on storage.objects;
drop policy if exists "documents_insert_own" on storage.objects;
drop policy if exists "documents_update_own" on storage.objects;
drop policy if exists "documents_delete_own" on storage.objects;

create policy "documents_select_own" on storage.objects for select
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text and public.is_approved());
create policy "documents_insert_own" on storage.objects for insert
  with check (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text and public.is_approved());
create policy "documents_update_own" on storage.objects for update
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text and public.is_approved());
create policy "documents_delete_own" on storage.objects for delete
  using (bucket_id = 'documents' and (storage.foldername(name))[1] = auth.uid()::text and public.is_approved());

-- P3 hardening: don't expose the security-definer helpers as RPC to anon.
revoke execute on function public.is_admin() from public;
revoke execute on function public.is_approved() from public;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.is_approved() to authenticated, service_role;
