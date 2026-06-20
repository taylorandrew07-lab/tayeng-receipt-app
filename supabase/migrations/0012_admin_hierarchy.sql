-- ============================================================================
-- Real admin hierarchy. A plain admin must NOT be able to grant/become
-- super_admin, edit a super_admin, or escalate/attack peers via direct DB
-- writes. Only a super_admin can manage other admins.
-- ============================================================================

-- Promote the founding account (earliest profile) to super_admin.
update profiles
set role = 'super_admin'
where id = (select id from profiles order by created_at asc limit 1);

create or replace function public.is_super_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'super_admin'
  );
$$;

revoke execute on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, service_role;

-- Replace the over-permissive admin update policy with a hierarchical one.
alter policy "profiles_update_admin" on profiles
  using (
    public.is_admin()
    and id <> auth.uid()                                  -- never edit your own row here
    and (role <> 'super_admin' or public.is_super_admin()) -- only super_admins may touch super_admins
  )
  with check (
    public.is_admin()
    and id <> auth.uid()
    -- a plain admin may only set role to user/admin; only super_admin may grant super_admin
    and (role in ('user', 'admin') or public.is_super_admin())
  );
