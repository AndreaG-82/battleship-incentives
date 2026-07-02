-- Battleships-App schema, RLS policies, and RPCs
-- Design notes:
--  * Players never get direct SELECT on `ships` (that's raw prize-location data).
--    They read the sanitized `board_state()` function instead.
--  * All writes that touch ships/plays go through the `play_move` RPC
--    (SECURITY DEFINER) so the client never needs write access to ships,
--    and duplicate-invoice rejection is enforced by a DB unique constraint
--    instead of a client-side check (closes a race condition).
--  * `my_role()` / `my_company_id()` are SECURITY DEFINER helpers so that
--    policies on `profiles` can look up the caller's own row without
--    recursive RLS evaluation on `profiles` itself.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_url text,
  primary_color text not null default '#0f172a',
  secondary_color text not null default '#0ea5e9',
  rows int not null default 0,
  cols int not null default 0,
  launched boolean not null default false,
  total_ships int not null default 0,
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'player')),
  company_id uuid not null references companies(id) on delete cascade,
  username text not null,
  business_name text,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);
create index profiles_company_id_idx on profiles(company_id);
create unique index profiles_company_role_username_idx on profiles (company_id, role, lower(username));

create table ships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  name text not null,
  size int not null,
  prize_name text not null,
  prize_desc text,
  cells jsonb not null,
  hits jsonb not null default '[]'::jsonb,
  sunk boolean not null default false,
  winner_profile_id uuid references profiles(id),
  winner_invoice text,
  winner_business_name text,
  winner_username text,
  winner_ts timestamptz,
  created_at timestamptz not null default now()
);
create index ships_company_id_idx on ships(company_id);

-- Keeps companies.total_ships in sync so players (who can't read the
-- ships table directly) can still render "X/Y prizes claimed".
create or replace function bump_total_ships()
returns trigger language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update companies set total_ships = total_ships + 1 where id = new.company_id;
    return new;
  elsif tg_op = 'DELETE' then
    update companies set total_ships = greatest(total_ships - 1, 0) where id = old.company_id;
    return old;
  end if;
  return null;
end;
$$;

create trigger ships_count_ins after insert on ships
for each row execute function bump_total_ships();

create trigger ships_count_del after delete on ships
for each row execute function bump_total_ships();

create table plays (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  invoice text not null,
  profile_id uuid not null references profiles(id),
  business_name text,
  username text,
  ts timestamptz not null default now(),
  cell jsonb not null,
  result text not null check (result in ('hit', 'miss', 'sunk')),
  prize_name text
);
create index plays_company_id_idx on plays(company_id);
create unique index plays_company_invoice_idx on plays (company_id, lower(invoice));

-- ---------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER to avoid recursive RLS on profiles)
-- ---------------------------------------------------------------------

create or replace function my_role()
returns text
language sql security definer stable
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function my_company_id()
returns uuid
language sql security definer stable
set search_path = public
as $$
  select company_id from profiles where id = auth.uid();
$$;

grant execute on function my_role() to authenticated, anon;
grant execute on function my_company_id() to authenticated, anon;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------

alter table companies enable row level security;
alter table profiles enable row level security;
alter table ships enable row level security;
alter table plays enable row level security;

-- companies: anyone can see launched campaigns (for the "choose your
-- campaign" screen); an admin can also see/update their own company.
-- No INSERT policy: creation only happens via create_company_with_admin().
create policy companies_select_launched on companies
  for select to anon, authenticated
  using (launched = true);

create policy companies_select_own on companies
  for select to authenticated
  using (my_role() = 'admin' and my_company_id() = id);

create policy companies_update_own on companies
  for update to authenticated
  using (my_role() = 'admin' and my_company_id() = id)
  with check (my_role() = 'admin' and my_company_id() = id);

-- profiles: a user can see their own row; an admin can see every
-- profile in their own company (players list). No INSERT/UPDATE/DELETE
-- policy: those go through create_company_with_admin(),
-- clear_must_change_password(), or the admin-* Edge Functions
-- (service role, bypasses RLS).
create policy profiles_select_self on profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_select_company_admin on profiles
  for select to authenticated
  using (my_role() = 'admin' and my_company_id() = company_id);

-- ships: admin-only. Players read board_state() instead, never this
-- table directly, so raw ship coordinates never reach the client.
create policy ships_admin_all on ships
  for all to authenticated
  using (my_role() = 'admin' and my_company_id() = company_id)
  with check (my_role() = 'admin' and my_company_id() = company_id);

-- plays: admin sees all plays for their company; a player sees their
-- own plays plus any company-wide winning play (for "recent winners").
-- No INSERT/UPDATE/DELETE policy: only play_move() writes here.
create policy plays_select_admin on plays
  for select to authenticated
  using (my_role() = 'admin' and my_company_id() = company_id);

create policy plays_select_player on plays
  for select to authenticated
  using (
    my_role() = 'player'
    and my_company_id() = company_id
    and (profile_id = auth.uid() or result = 'sunk')
  );

-- ---------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------

-- Creates a company and its admin profile atomically, tied to the
-- already-authenticated caller (client calls auth.signUp() first).
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
  values (auth.uid(), 'admin', v_company.id, p_username, false);

  return v_company;
end;
$$;

grant execute on function create_company_with_admin(text, text, text, text) to authenticated;

-- Lets a player clear their own must-change-password flag without a
-- general-purpose profiles UPDATE policy (which would otherwise let a
-- client rewrite their own role/company_id and self-escalate).
create or replace function clear_must_change_password()
returns void
language sql security definer
set search_path = public
as $$
  update profiles set must_change_password = false where id = auth.uid();
$$;

grant execute on function clear_must_change_password() to authenticated;

-- Sanitized read of a company's board: hidden/hit/miss/sunk per cell,
-- never the raw ship layout. Caller must be an admin or player of the
-- company (via profiles), otherwise raises.
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
  if my_company_id() is distinct from p_company_id then
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
      (sh.hits ->> (t.idx - 1))::boolean as is_hit
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

grant execute on function board_state(uuid) to authenticated;

-- Resolves a player's move server-side: the client sends a cell and an
-- invoice number and gets back only {result, prize_name}. Ship layout
-- and hit/sunk bookkeeping never leave the database.
create or replace function play_move(p_company_id uuid, p_r int, p_c int, p_invoice text)
returns table(result text, prize_name text)
language plpgsql security definer
set search_path = public
as $$
declare
  v_profile profiles%rowtype;
  v_ship ships%rowtype;
  v_ship_id uuid;
  v_cell_idx int;
  v_clean_invoice text := trim(p_invoice);
  v_result text;
  v_prize text;
  v_new_hits jsonb;
  v_sunk boolean;
begin
  if v_clean_invoice = '' then
    raise exception 'invoice_required';
  end if;

  select * into v_profile from profiles where id = auth.uid();
  if v_profile.id is null or v_profile.company_id <> p_company_id or v_profile.role <> 'player' then
    raise exception 'not_authorized';
  end if;

  select sh.id, (t.idx - 1)
  into v_ship_id, v_cell_idx
  from ships sh
  cross join lateral jsonb_array_elements(sh.cells) with ordinality as t(elem, idx)
  where sh.company_id = p_company_id
    and (t.elem ->> 'r')::int = p_r
    and (t.elem ->> 'c')::int = p_c
  limit 1;

  if v_ship_id is not null then
    select * into v_ship from ships where id = v_ship_id;
    v_new_hits := jsonb_set(v_ship.hits, array[v_cell_idx::text], 'true'::jsonb);
    select bool_and(elem::boolean) into v_sunk from jsonb_array_elements_text(v_new_hits) as elem;

    update ships set
      hits = v_new_hits,
      sunk = v_sunk,
      winner_profile_id = case when v_sunk then v_profile.id else winner_profile_id end,
      winner_invoice = case when v_sunk then v_clean_invoice else winner_invoice end,
      winner_business_name = case when v_sunk then v_profile.business_name else winner_business_name end,
      winner_username = case when v_sunk then v_profile.username else winner_username end,
      winner_ts = case when v_sunk then now() else winner_ts end
    where id = v_ship.id;

    v_result := case when v_sunk then 'sunk' else 'hit' end;
    v_prize := case when v_sunk then v_ship.prize_name else null end;
  else
    v_result := 'miss';
    v_prize := null;
  end if;

  begin
    insert into plays (company_id, invoice, profile_id, business_name, username, cell, result, prize_name)
    values (
      p_company_id, v_clean_invoice, v_profile.id, v_profile.business_name, v_profile.username,
      jsonb_build_object('r', p_r, 'c', p_c), v_result, v_prize
    );
  exception
    when unique_violation then
      raise exception 'invoice_used';
  end;

  return query select v_result, v_prize;
end;
$$;

grant execute on function play_move(uuid, int, int, text) to authenticated;

-- ---------------------------------------------------------------------
-- Storage: public logo bucket, admin-only upload scoped to their company
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

create policy logos_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'logos');

create policy logos_admin_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'logos'
    and my_role() = 'admin'
    and (storage.foldername(name))[1] = my_company_id()::text
  );

create policy logos_admin_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'logos'
    and my_role() = 'admin'
    and (storage.foldername(name))[1] = my_company_id()::text
  );
