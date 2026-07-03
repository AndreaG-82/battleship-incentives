-- Adds a platform-level `admin` role above the existing per-campaign
-- owner (renamed `manager`) and `player`. Admin accounts aren't tied
-- to a single company (company_id is null) and get unrestricted
-- read/write across every company, via an `or my_role() = 'admin'`
-- added to each policy that previously only granted the campaign
-- owner access to their own company's rows.

alter table profiles drop constraint profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('admin', 'manager', 'player'));

-- Every existing 'admin' row is today's per-campaign owner (there's no
-- platform admin yet) - reclassify them to 'manager' before the new
-- role gets any real meaning attached, and before the company_id-null
-- check below (which every existing 'admin' row, having a company_id,
-- would otherwise violate).
update profiles set role = 'manager' where role = 'admin';

alter table profiles alter column company_id drop not null;
alter table profiles add constraint profiles_admin_no_company check ((role = 'admin') = (company_id is null));

-- ---------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------

drop policy companies_select_own on companies;
create policy companies_select_own on companies
  for select to authenticated
  using ((my_role() = 'manager' and my_company_id() = id) or my_role() = 'admin');

drop policy companies_update_own on companies;
create policy companies_update_own on companies
  for update to authenticated
  using ((my_role() = 'manager' and my_company_id() = id) or my_role() = 'admin')
  with check ((my_role() = 'manager' and my_company_id() = id) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------

drop policy profiles_select_company_admin on profiles;
create policy profiles_select_company_admin on profiles
  for select to authenticated
  using ((my_role() = 'manager' and my_company_id() = company_id) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- ships
-- ---------------------------------------------------------------------

drop policy ships_admin_all on ships;
create policy ships_admin_all on ships
  for all to authenticated
  using ((my_role() = 'manager' and my_company_id() = company_id) or my_role() = 'admin')
  with check ((my_role() = 'manager' and my_company_id() = company_id) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- plays
-- ---------------------------------------------------------------------

drop policy plays_select_admin on plays;
create policy plays_select_admin on plays
  for select to authenticated
  using ((my_role() = 'manager' and my_company_id() = company_id) or my_role() = 'admin');

-- ---------------------------------------------------------------------
-- storage (logos)
-- ---------------------------------------------------------------------

drop policy logos_admin_write on storage.objects;
create policy logos_admin_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'logos'
    and (
      (my_role() = 'manager' and (storage.foldername(name))[1] = my_company_id()::text)
      or my_role() = 'admin'
    )
  );

drop policy logos_admin_update on storage.objects;
create policy logos_admin_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'logos'
    and (
      (my_role() = 'manager' and (storage.foldername(name))[1] = my_company_id()::text)
      or my_role() = 'admin'
    )
  );

-- ---------------------------------------------------------------------
-- board_state(): let a platform admin inspect any company's board too
-- ---------------------------------------------------------------------

create or replace function board_state(p_company_id uuid)
returns table(r int, c int, state text, prize_name text, ship_name text)
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_rows int;
  v_cols int;
begin
  select rows, cols into v_rows, v_cols from companies where id = p_company_id;
  if v_rows is null then
    raise exception 'company_not_found';
  end if;
  if my_role() <> 'admin' and my_company_id() is distinct from p_company_id then
    raise exception 'not_authorized';
  end if;

  return query
  with grid as (
    select gr.r, gc.c
    from generate_series(0, greatest(v_rows - 1, -1)) as gr(r)
    cross join generate_series(0, greatest(v_cols - 1, -1)) as gc(c)
  ),
  ship_cells as (
    select
      sh.prize_name,
      sh.name as ship_name,
      sh.sunk,
      (t.elem ->> 'r')::int as r,
      (t.elem ->> 'c')::int as c,
      (sh.hits ->> (t.idx - 1)::int)::boolean as is_hit
    from ships sh
    cross join lateral jsonb_array_elements(sh.cells) with ordinality as t(elem, idx)
    where sh.company_id = p_company_id
  ),
  misses as (
    select (pl.cell ->> 'r')::int as r, (pl.cell ->> 'c')::int as c
    from plays pl
    where pl.company_id = p_company_id and pl.result = 'miss'
  )
  select
    g.r,
    g.c,
    case
      when sc.r is not null and sc.is_hit and sc.sunk then 'sunk'
      when sc.r is not null and sc.is_hit then 'hit'
      when m.r is not null then 'miss'
      else 'hidden'
    end as state,
    case when sc.r is not null and sc.is_hit and sc.sunk then sc.prize_name else null end as prize_name,
    case when sc.r is not null and sc.is_hit and sc.sunk then sc.ship_name else null end as ship_name
  from grid g
  left join ship_cells sc on sc.r = g.r and sc.c = g.c
  left join misses m on m.r = g.r and m.c = g.c;
end;
$$;

-- ---------------------------------------------------------------------
-- create_company_with_admin(): unused by the frontend (company/manager
-- creation now goes through the create-company Edge Function so the
-- account can be pre-confirmed via the Auth Admin API), but fixed so
-- it doesn't violate the new profiles_admin_no_company check if it's
-- ever invoked directly.
-- ---------------------------------------------------------------------

create or replace function create_company_with_admin(
  p_name text,
  p_primary text,
  p_secondary text,
  p_username text
)
returns companies
language plpgsql security definer
set search_path = public
as $$
declare
  v_company companies%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'profile_already_exists';
  end if;

  insert into companies (name, primary_color, secondary_color)
  values (p_name, p_primary, p_secondary)
  returning * into v_company;

  insert into profiles (id, role, company_id, username, must_change_password)
  values (auth.uid(), 'manager', v_company.id, p_username, false);

  return v_company;
end;
$$;
