-- Arrival unlocks, the bonus as a question screen, and the sequential rule moved to the base.
-- Run after 0004. (0004 is left untouched so the migration history stays honest.)
--
--  * A location no longer asks for a password at the location. Walking into its radius unlocks it, IF it is available:
--      chain: the previous location's code has been handed in at the base (the first one: once the team has checked in)
--      hub:   unlocked by answering its base question (unchanged)
--      open:  always available
--    Locked locations stay visible to the team as greyed beacons; my_progress() says which are available.
--  * The quest is finished when every location's code is handed in. The bonus is an extra question shown on the finish
--    screen: it needs no location and does not stop the clock.

drop function if exists public.unlock_stop(text, text, double precision, double precision, double precision);

create or replace function public.arrive_stop(p_stop text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_prev stops; v_err text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  select * into v_stop from stops where id = p_stop;
  if not found or v_stop.role <> 'stop' then return jerr('Unknown location.'); end if;
  if stop_open(v_team.id, p_stop) then return jsonb_build_object('ok', true, 'already', true); end if;
  if v_stop.entry_mode = 'hub' then return jerr('This location is unlocked at the base: answer its question there.'); end if;
  if not in_range(v_team.id, p_stop, p_lat, p_lng, p_acc) then return jerr('You need to be at this location. Indoors? Scan the QR code posted there.'); end if;
  if v_stop.entry_mode = 'chain' then
    select * into v_prev from stops where role = 'stop' and ord < v_stop.ord order by ord desc limit 1;
    if v_prev.id is not null and not exists (select 1 from hub_flags where team_id = v_team.id and stop_id = v_prev.id) then
      return jerr('Locked. Hand in the code from Location ' || v_prev.ord || ' at the base to unlock this location.');
    end if;
  end if;
  insert into unlocks (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing;
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, detail) values (v_uid, v_team.id, 'unlock', p_stop, true, p_lat, p_lng, 'arrived');
  return jsonb_build_object('ok', true, 'place', v_stop.place);
end $$;

-- The bonus question needs no location.
create or replace function public.in_range(p_team uuid, p_stop text, p_lat double precision, p_lng double precision, p_acc double precision)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from stops where id = p_stop and role = 'bonus')
    or coalesce((
      select p_lat is not null and p_lng is not null
         and distance_m(p_lat, p_lng, s.lat, s.lng) <= s.radius_m + least(greatest(coalesce(p_acc, 0), 0), 25)
      from stops s where s.id = p_stop), false)
    or exists (select 1 from presence where team_id = p_team and stop_id = p_stop and at > now() - interval '15 minutes')
$$;

create or replace function public.check_finish(p_team uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_stops int; v_flags int; v_bonus int; v_bonus_clear boolean;
begin
  select count(*) into v_stops from stops where role = 'stop';
  select count(*) into v_flags from hub_flags where team_id = p_team;
  -- Finished = every location's code handed in. The bonus question is an extra and does not stop the clock.
  if v_flags >= v_stops and v_stops > 0 then
    update teams set finished_at = now() where id = p_team and finished_at is null;
    if found then insert into events (team_id, kind, ok, detail) values (p_team, 'finished', true, 'quest complete'); end if;
  end if;
end $$;

create or replace function public.my_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_game game_state;
  v_info jsonb;
  v_started boolean;
  v_stops jsonb;
  v_hub jsonb;
begin
  select * into v_game from game_state;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found then
    return jsonb_build_object('team', null, 'game', jsonb_build_object('status', game_status(), 'now', now()), 'stops', '[]'::jsonb, 'announcements', '[]'::jsonb);
  end if;
  v_info := jsonb_build_object(
    'id', v_team.id, 'name', v_team.name, 'code', v_team.code, 'locked', v_team.locked,
    'leaderId', v_team.leader_id, 'me', v_uid, 'min', 2, 'max', 4,
    'startedAt', v_team.started_at, 'finishedAt', v_team.finished_at,
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', m.user_id, 'name', display_name(m.user_id), 'isLeader', m.user_id = v_team.leader_id,
                  'avatar', coalesce((select avatar from profiles where id = m.user_id), 'male')) order by m.joined_at), '[]'::jsonb)
                from team_members m where m.team_id = v_team.id));
  if not v_team.locked then
    return jsonb_build_object('team', v_info, 'game', jsonb_build_object('status', game_status(), 'now', now()), 'stops', '[]'::jsonb, 'announcements', '[]'::jsonb);
  end if;

  v_started := team_started(v_team.id);
  select coalesce(jsonb_agg(sj order by ord), '[]'::jsonb) into v_stops from (
    select s.ord, jsonb_build_object(
      'id', s.id, 'ord', s.ord, 'name', s.name, 'place', s.place, 'label', s.label, 'type', s.type, 'icon', s.icon,
      'lat', s.lat, 'lng', s.lng, 'radius', s.radius_m, 'description', s.description, 'role', s.role, 'entryMode', s.entry_mode,
      'hint', x.hint, 'entryQuestion', x.entry_question,
      'prevPlace', (select p.place from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1),
      'state', case when stop_is_clear(v_team.id, s.id) then 'cleared' when stop_open(v_team.id, s.id) then 'open' else 'locked' end,
      -- can this location be unlocked right now by walking into it?
      'available', case
          when stop_open(v_team.id, s.id) then true
          when s.role <> 'stop' then false
          when s.entry_mode = 'open' then true
          when s.entry_mode = 'chain' then v_started and (
              not exists (select 1 from stops p where p.role = 'stop' and p.ord < s.ord)
              or exists (select 1 from hub_flags h where h.team_id = v_team.id
                         and h.stop_id = (select p.id from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1)))
          else false end,
      'prevOrd', (select p.ord from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1),
      'puzzleCount', (select count(*) from puzzles where stop_id = s.id),
      'exitFlag', case when stop_is_clear(v_team.id, s.id) then x.exit_flag end,
      'nextClue', case when stop_is_clear(v_team.id, s.id) then x.next_clue end,
      'puzzles', case when stop_open(v_team.id, s.id) then (select coalesce(jsonb_agg(jsonb_build_object(
          'idx', p.idx, 'title', p.title, 'kind', p.kind, 'prompt', p.prompt,
          'question', case when p.kind = 'photo' and photo_cleared(v_team.id, p.stop_id, p.idx) then ps.question end,
          'photoCleared', p.kind = 'photo' and photo_cleared(v_team.id, p.stop_id, p.idx),
          'pending', exists (select 1 from photo_submissions q where q.team_id = v_team.id and q.stop_id = p.stop_id and q.idx = p.idx and q.status = 'pending'),
          'solved', exists (select 1 from solves v where v.team_id = v_team.id and v.stop_id = p.stop_id and v.idx = p.idx),
          'solvedBy', (select v.user_id from solves v where v.team_id = v_team.id and v.stop_id = p.stop_id and v.idx = p.idx)
        ) order by p.idx), '[]'::jsonb)
        from puzzles p left join puzzle_secrets ps on ps.stop_id = p.stop_id and ps.idx = p.idx where p.stop_id = s.id) else '[]'::jsonb end
    ) as sj
    from stops s join stop_secrets x on x.stop_id = s.id
    where s.role = 'hub'
       or stop_open(v_team.id, s.id)
       or (s.role = 'stop' and v_started and (
             v_game.hub_reveal = 'all'
             or not exists (select 1 from stops p where p.role = 'stop' and p.ord < s.ord)
             or stop_is_clear(v_team.id, (select p.id from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1))))
  ) t;
  v_hub := jsonb_build_object(
    'id', hub_id(),
    'entered', coalesce((select jsonb_agg(stop_id) from hub_flags where team_id = v_team.id), '[]'::jsonb),
    'needed', (select count(*) from stops where role = 'stop'));

  return jsonb_build_object(
    'team', v_info,
    'game', jsonb_build_object('status', game_status(), 'startsAt', v_game.starts_at, 'endsAt', v_game.ends_at, 'now', now(),
                               'hubReveal', v_game.hub_reveal, 'bounds', v_game.bounds, 'noGo', v_game.no_go, 'boardPublic', v_game.board_public),
    'started', v_started,
    'hub', v_hub,
    'stops', v_stops,
    'announcements', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'message', a.message, 'level', a.level) order by a.id desc), '[]'::jsonb)
                      from (select * from announcements where at > now() - interval '8 hours' and (team_id is null or team_id = v_team.id) order by id desc limit 5) a));
end $$;

create or replace function public.build_leaderboard() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'rank', rn, 'teamId', id, 'name', name, 'players', players, 'flags', flags, 'stopsCleared', cleared, 'hubFlags', hubflags,
      'bonus', bonus_done, 'startedAt', started_at, 'finishedAt', finished_at, 'elapsedSeconds', elapsed, 'lastSolveAt', last_solve) order by rn), '[]'::jsonb)
  from (
    select row_number() over (order by (finished_at is null), elapsed asc nulls last, flags desc, last_solve asc nulls last, created_at) as rn, *
    from (
      select t.id, t.name, t.created_at, t.started_at, t.finished_at,
             (select count(*) from team_members m where m.team_id = t.id) as players,
             (select count(*) from solves s where s.team_id = t.id) as flags,
             (select count(*) from stops st where st.role <> 'hub' and stop_is_clear(t.id, st.id)) as cleared,
             (select count(*) from hub_flags h where h.team_id = t.id) as hubflags,
             coalesce((select bool_and(stop_is_clear(t.id, b.id)) from stops b where b.role = 'bonus'), false) as bonus_done,
             (select max(s.at) from solves s where s.team_id = t.id) as last_solve,
             case when t.finished_at is not null then extract(epoch from t.finished_at - coalesce(t.started_at, t.locked_at, t.created_at)) end as elapsed
      from teams t where t.locked
    ) base
  ) ranked
$$;

create or replace function public.admin_save_stop(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id text := lower(btrim(coalesce(p ->> 'id', '')));
  v_role text := coalesce(nullif(p ->> 'role', ''), 'stop');
  v_mode text := coalesce(nullif(p ->> 'entryMode', ''), 'chain');
  v_exists boolean;
  v_lat double precision := (p ->> 'lat')::double precision;
  v_lng double precision := (p ->> 'lng')::double precision;
  v_radius int := coalesce((p ->> 'radius')::int, 50);
  v_ord int;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if v_id !~ '^[a-z0-9][a-z0-9_-]{1,29}$' then return jerr('Location id: 2-30 characters, a-z 0-9 - _'); end if;
  if v_role not in ('hub', 'stop', 'bonus') or v_mode not in ('chain', 'hub', 'open') then return jerr('Unknown role or entry mode.'); end if;
  if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then return jerr('Latitude / longitude are not valid.'); end if;
  if v_radius < 5 or v_radius > 500 then return jerr('Radius must be 5 to 500 m.'); end if;
  if btrim(coalesce(p ->> 'place', '')) = '' or btrim(coalesce(p ->> 'name', '')) = '' then return jerr('Place name and quest title are required.'); end if;
  if v_role = 'stop' and (btrim(coalesce(p ->> 'exitFlag', '')) = '' or btrim(coalesce(p ->> 'nextClue', '')) = '') then return jerr('A location needs its handoff flag and a next clue.'); end if;
  if v_role = 'stop' and v_mode = 'hub' and (btrim(coalesce(p ->> 'entryQuestion', '')) = '' or btrim(coalesce(p ->> 'entryAnswer', '')) = '') then return jerr('A base-unlocked location needs its base question and answer.'); end if;
  if v_role = 'hub' and exists (select 1 from stops where role = 'hub' and id <> v_id) then return jerr('There is already a base location.'); end if;
  select exists (select 1 from stops where id = v_id) into v_exists;
  v_ord := case when v_role = 'hub' then 0 else coalesce((select ord from stops where id = v_id and ord >= 1), (select coalesce(max(ord), 0) + 1 from stops)) end;
  if v_exists then
    update stops set name = btrim(p ->> 'name'), place = btrim(p ->> 'place'), label = coalesce(nullif(btrim(p ->> 'label'), ''), label),
      type = coalesce(nullif(btrim(p ->> 'type'), ''), type), icon = coalesce(nullif(btrim(p ->> 'icon'), ''), icon),
      lat = v_lat, lng = v_lng, radius_m = v_radius, description = coalesce(p ->> 'description', ''), role = v_role, entry_mode = v_mode, ord = v_ord
    where id = v_id;
  else
    insert into stops (id, ord, role, entry_mode, name, place, label, type, icon, lat, lng, radius_m, description)
    values (v_id, v_ord, v_role, v_mode, btrim(p ->> 'name'), btrim(p ->> 'place'), coalesce(nullif(btrim(p ->> 'label'), ''), 'NEW STOP'),
            coalesce(nullif(btrim(p ->> 'type'), ''), case v_role when 'hub' then 'hub' else 'custom' end),
            coalesce(nullif(btrim(p ->> 'icon'), ''), case v_role when 'hub' then '⌂' else '◆' end), v_lat, v_lng, v_radius, coalesce(p ->> 'description', ''));
  end if;
  insert into stop_secrets (stop_id, exit_flag, next_clue, hint, entry_question, entry_answer)
  values (v_id, nullif(btrim(p ->> 'exitFlag'), ''), nullif(btrim(p ->> 'nextClue'), ''), coalesce(btrim(p ->> 'hint'), ''), nullif(btrim(p ->> 'entryQuestion'), ''), nullif(btrim(p ->> 'entryAnswer'), ''))
  on conflict (stop_id) do update set exit_flag = excluded.exit_flag, next_clue = excluded.next_clue, hint = excluded.hint,
    entry_question = excluded.entry_question, entry_answer = excluded.entry_answer;
  insert into events (user_id, kind, stop_id, ok, detail) values (auth.uid(), 'content', v_id, true, case when v_exists then 'location edited' else 'location created' end);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.am_i_admin() to authenticated;
grant execute on function public.my_progress() to authenticated;
grant execute on function public.create_team(text) to authenticated;
grant execute on function public.join_team(text) to authenticated;
grant execute on function public.leave_team() to authenticated;
grant execute on function public.kick_member(uuid) to authenticated;
grant execute on function public.lock_team() to authenticated;
grant execute on function public.update_my_location(double precision, double precision, double precision) to authenticated;
grant execute on function public.hub_checkin(double precision, double precision, double precision) to authenticated;
grant execute on function public.hub_answer(text, text, double precision, double precision, double precision) to authenticated;
grant execute on function public.hub_submit_flag(text, double precision, double precision, double precision) to authenticated;
grant execute on function public.submit_flag(text, int, text, double precision, double precision, double precision) to authenticated;
grant execute on function public.scan_qr(text, text) to authenticated;
grant execute on function public.request_help(double precision, double precision, text) to authenticated;
grant execute on function public.leaderboard() to authenticated;
grant execute on function public.public_leaderboard() to anon, authenticated;
grant execute on function public.admin_live() to authenticated;
grant execute on function public.admin_teams() to authenticated;
grant execute on function public.admin_events(int, bigint, uuid, text) to authenticated;
grant execute on function public.admin_content() to authenticated;
grant execute on function public.admin_save_stop(jsonb) to authenticated;
grant execute on function public.admin_move_stop(text, jsonb) to authenticated;
grant execute on function public.admin_delete_stop(text) to authenticated;
grant execute on function public.admin_reorder_stops(text[]) to authenticated;
grant execute on function public.admin_save_puzzle(jsonb) to authenticated;
grant execute on function public.admin_delete_puzzle(text, int) to authenticated;
grant execute on function public.admin_photo_submissions(text, int) to authenticated;
grant execute on function public.admin_review_photo(uuid, boolean) to authenticated;
grant execute on function public.admin_game() to authenticated;
grant execute on function public.admin_set_game(jsonb) to authenticated;
grant execute on function public.admin_broadcast(text, uuid, text) to authenticated;
grant execute on function public.admin_help_requests() to authenticated;
grant execute on function public.admin_resolve_help(bigint) to authenticated;
grant execute on function public.admin_team_action(jsonb) to authenticated;
grant execute on function public.admin_question_stats() to authenticated;
grant execute on function public.admin_purge(text) to authenticated;
grant execute on function public.game_error() to service_role;
grant execute on function public.record_photo_clear(uuid, text, int, double precision, double precision) to service_role;
grant execute on function public.log_photo_miss(uuid, text, int, double precision, double precision, double precision, text) to service_role;
grant execute on function public.arrive_stop(text, double precision, double precision, double precision) to authenticated;
