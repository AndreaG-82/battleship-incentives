-- Managers can own multiple campaigns instead of exactly one. Replaces
-- the single profiles.company_id link (for managers only - players
-- still belong to exactly one company) with a many-to-many join table,
-- so a manager account can start with zero campaigns and create more
-- than one over time.

create table manager_companies (
  manager_id uuid not null references profiles(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (manager_id, company_id)
);

-- Backfill every existing manager's current company_id, then null it
-- out - only players require company_id from here on.
insert into manager_companies (manager_id, company_id)
select id, company_id from profiles where role = 'manager' and company_id is not null;

alter table profiles drop constraint profiles_admin_no_company;

update profiles set company_id = null where role = 'manager';

alter table profiles add constraint profiles_company_id_players_only
  check ((role = 'player') = (company_id is not null));

create or replace function is_manager_of(target_company_id uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from manager_companies mc
    where mc.manager_id = auth.uid() and mc.company_id = target_company_id
  );
$$;

grant execute on function is_manager_of(uuid) to authenticated;

alter table manager_companies enable row level security;

create policy manager_companies_select_self on manager_companies
  for select to authenticated
  using (manager_id = auth.uid() or my_role() = 'admin');

create policy manager_companies_insert_self on manager_companies
  for insert to authenticated
  with check (manager_id = auth.uid() and my_role() = 'manager');

-- ---------------------------------------------------------------------
-- companies: let a manager create their own campaign directly (no
-- Edge Function needed - no auth account is being created here).
-- ---------------------------------------------------------------------

create policy companies_insert_manager on companies
  for insert to authenticated
  with check (my_role() = 'manager');

drop policy companies_select_own on companies;
create policy companies_select_own on companies
  for select to authenticated
  using ((my_role() = 'manager' and is_manager_of(id)) or my_role() = 'admin');

drop policy companies_update_own on companies;
create policy companies_update_own on companies
  for update to authenticated
  using ((my_role() = 'manager' and is_manager_of(id)) or my_role() = 'admin')
  with check ((my_role() = 'manager' and is_manager_of(id)) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------

drop policy profiles_select_company_admin on profiles;
create policy profiles_select_company_admin on profiles
  for select to authenticated
  using ((my_role() = 'manager' and is_manager_of(company_id)) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- ships
-- ---------------------------------------------------------------------

drop policy ships_admin_all on ships;
create policy ships_admin_all on ships
  for all to authenticated
  using ((my_role() = 'manager' and is_manager_of(company_id)) or my_role() = 'admin')
  with check ((my_role() = 'manager' and is_manager_of(company_id)) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- plays
-- ---------------------------------------------------------------------

drop policy plays_select_admin on plays;
create policy plays_select_admin on plays
  for select to authenticated
  using ((my_role() = 'manager' and is_manager_of(company_id)) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- storage (logos)
-- ---------------------------------------------------------------------

drop policy logos_admin_write on storage.objects;
create policy logos_admin_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'logos'
    and (
      (my_role() = 'manager' and is_manager_of((storage.foldername(name))[1]::uuid))
      or my_role() = 'admin'
    )
  );

drop policy logos_admin_update on storage.objects;
create policy logos_admin_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'logos'
    and (
      (my_role() = 'manager' and is_manager_of((storage.foldername(name))[1]::uuid))
      or my_role() = 'admin'
    )
  );
