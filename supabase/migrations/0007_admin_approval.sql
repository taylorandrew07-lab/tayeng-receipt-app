-- ============================================================================
-- Admin-approved signups: new users must be approved by an admin before they
-- can use the app. The founding user is promoted to admin + approved.
-- ============================================================================

alter table profiles
  add column if not exists approved boolean not null default false;

-- Promote + approve existing accounts (only the founding admin exists today).
update profiles set approved = true, role = 'admin';

-- SECURITY DEFINER helper so admin policies can check role without RLS recursion.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'super_admin')
  );
$$;

-- Admins can read and update every profile (to see + approve pending users).
create policy "profiles_select_admin" on profiles
  for select using (public.is_admin());

create policy "profiles_update_admin" on profiles
  for update using (public.is_admin()) with check (public.is_admin());
