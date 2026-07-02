-- jsonb ->> only accepts int/text, not the bigint produced by
-- WITH ORDINALITY, so board_state() 404'd with "operator does not
-- exist: jsonb ->> bigint" on first real use.
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
