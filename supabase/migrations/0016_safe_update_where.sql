-- 0016: Supabase enables pg-safeupdate for API requests, which rejects UPDATE/DELETE without a WHERE clause
-- ("UPDATE requires a WHERE clause"). game_state has a single row and the purges clear whole tables, so these
-- statements now say `where true` explicitly. Behaviour is unchanged.
create or replace function public.admin_set_game(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update game_state set
    status = coalesce(nullif(p ->> 'status', ''), status),
    starts_at = case when p ? 'startsAt' then nullif(p ->> 'startsAt', '')::timestamptz else starts_at end,
    ends_at = case when p ? 'endsAt' then nullif(p ->> 'endsAt', '')::timestamptz else ends_at end,
    board_public = coalesce((p ->> 'boardPublic')::boolean, board_public),
    hub_reveal = coalesce(nullif(p ->> 'hubReveal', ''), hub_reveal),
    bounds = case when p ? 'bounds' then p -> 'bounds' else bounds end,
    no_go = case when p ? 'noGo' then coalesce(p -> 'noGo', '[]'::jsonb) else no_go end,
    updated_at = now()
  where true;
  insert into events (user_id, kind, ok, detail) values (auth.uid(), 'game', true, left(p::text, 200));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_purge(p_what text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_paths jsonb := '[]'::jsonb;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_what = 'locations' then
    delete from player_locations where true;
    update events set lat = null, lng = null where lat is not null;
    update help_requests set lat = null, lng = null where true;
  elsif p_what = 'photos' then
    select coalesce(jsonb_agg(path), '[]'::jsonb) into v_paths from photo_submissions;
    delete from photo_submissions where true;
  else return jerr('Unknown purge.');
  end if;
  insert into events (user_id, kind, ok, detail) values (auth.uid(), 'content', true, 'purged ' || p_what);
  return jsonb_build_object('ok', true, 'paths', v_paths);
end $$;
