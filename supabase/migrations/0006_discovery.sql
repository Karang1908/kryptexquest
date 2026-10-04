-- Hidden locations, discovery, and the unlock flag.
-- Run after 0005. Replaces the 0005 "walk in to unlock" rule with the organisers' final design:
--
--  * Locations are HIDDEN. A team only learns where one is by walking into its radius ("Location discovered"). A discovered
--    location stays on that team's map: grey while locked, blue while unlocked, green once cleared.
--  * To unlock a discovered location the team types its ENTRY FLAG there. The flag comes from the base: handing in the previous
--    location's code at the base releases the next location's hint + entry question (the answer is the entry flag, or the
--    flag itself is shown when no question is set). Locations must be unlocked in sequence ('chain'); 'open' ones are released
--    right after check-in. A location with no entry flag set unlocks as soon as it is discovered and released.
--  * 'hub' entry mode (answer a question at the base to unlock) is gone: it is now just the entry question, answered anywhere.

update public.stops set entry_mode = 'open' where entry_mode = 'hub';
alter table public.stops drop constraint if exists stops_entry_mode_check;
alter table public.stops add constraint stops_entry_mode_check check (entry_mode in ('chain', 'open'));

create table public.discoveries (
  team_id uuid not null references public.teams on delete cascade,
  stop_id text not null references public.stops on delete cascade,
  user_id uuid,
  at timestamptz not null default now(),
  primary key (team_id, stop_id)
);
alter table public.discoveries enable row level security;

drop function if exists public.arrive_stop(text, double precision, double precision, double precision);
drop function if exists public.hub_answer(text, text, double precision, double precision, double precision);

create or replace function public.stop_discovered(p_team uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stops where id = p_stop and role = 'hub')
      or exists (select 1 from discoveries where team_id = p_team and stop_id = p_stop)
      or exists (select 1 from unlocks where team_id = p_team and stop_id = p_stop)
$$;

-- The base has released this location's hint and entry question to the team.
create or replace function public.stop_released(p_team uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select case
      when s.role <> 'stop' or not team_started(p_team) then false
      when s.entry_mode = 'open' then true
      else not exists (select 1 from stops p where p.role = 'stop' and p.ord < s.ord)
           or exists (select 1 from hub_flags h where h.team_id = p_team
                      and h.stop_id = (select p.id from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1))
      end from stops s where s.id = p_stop), false)
$$;

-- Internal: record every not-yet-discovered location within reach; returns what is new.
create or replace function public.discover_nearby(p_team uuid, p_user uuid, p_lat double precision, p_lng double precision, p_acc double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb := '[]'::jsonb; s record;
begin
  if p_lat is null or p_lng is null then return r; end if;
  for s in select * from stops where role = 'stop'
             and not stop_discovered(p_team, id)
             and distance_m(p_lat, p_lng, lat, lng) <= radius_m + least(greatest(coalesce(p_acc, 0), 0), 25)
  loop
    insert into discoveries (team_id, stop_id, user_id) values (p_team, s.id, p_user) on conflict do nothing;
    insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, dist_m, detail)
    values (p_user, p_team, 'discover', s.id, true, p_lat, p_lng, distance_m(p_lat, p_lng, s.lat, s.lng), 'discovered');
    r := r || jsonb_build_array(jsonb_build_object('id', s.id, 'ord', s.ord));
  end loop;
  return r;
end $$;

-- The location ping now also discovers locations (the phone cannot: it does not know where hidden locations are).
drop function if exists public.update_my_location(double precision, double precision, double precision);
create function public.update_my_location(p_lat double precision, p_lng double precision, p_accuracy double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_found jsonb := '[]'::jsonb;
begin
  if v_uid is null or p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return jsonb_build_object('discovered', v_found); end if;
  insert into player_locations (user_id, team_id, lat, lng, accuracy, updated_at)
  values (v_uid, current_team(v_uid), p_lat, p_lng, p_accuracy, now())
  on conflict (user_id) do update
    set team_id = excluded.team_id, lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = now()
    where player_locations.updated_at < now() - interval '3 seconds';
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if found and v_team.locked and game_error() is null and team_started(v_team.id) then
    v_found := discover_nearby(v_team.id, v_uid, p_lat, p_lng, p_accuracy);
  end if;
  return jsonb_build_object('discovered', v_found);
end $$;

-- Unlock a discovered location by typing its entry flag while standing there.
create or replace function public.unlock_stop(p_stop text, p_flag text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_prev stops; v_err text; v_answer text; v_ok boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  select * into v_stop from stops where id = p_stop;
  if not found or v_stop.role <> 'stop' then return jerr('Unknown location.'); end if;
  if stop_open(v_team.id, p_stop) then return jsonb_build_object('ok', true, 'already', true); end if;
  if not in_range(v_team.id, p_stop, p_lat, p_lng, p_acc) then return jerr('You need to be at this location. Indoors? Scan the QR code posted there.'); end if;
  if not stop_released(v_team.id, p_stop) then
    select * into v_prev from stops where role = 'stop' and ord < v_stop.ord order by ord desc limit 1;
    return jerr('Locked. Unlock the locations in order: hand in the code from Location ' || coalesce(v_prev.ord::text, '?') || ' at the base to get this one''s hint and entry question.');
  end if;
  select entry_answer into v_answer from stop_secrets where stop_id = p_stop;
  if v_answer is not null then
    if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
    v_ok := norm_flag(p_flag) = norm_flag(v_answer);
    insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, detail)
    values (v_uid, v_team.id, 'unlock', p_stop, v_ok, p_lat, p_lng, case when v_ok then 'entry flag' else left(btrim(coalesce(p_flag, '')), 60) end);
    if not v_ok then return jerr('That is not this location''s entry flag. Check the hint and question you got at the base.'); end if;
  else
    insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, detail) values (v_uid, v_team.id, 'unlock', p_stop, true, p_lat, p_lng, 'no flag required');
  end if;
  insert into discoveries (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing;
  insert into unlocks (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true, 'place', v_stop.place);
end $$;

create or replace function public.scan_qr(p_stop text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_err text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Join and lock a team first, then scan again.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  select s.* into v_stop from stops s join stop_secrets x on x.stop_id = s.id where s.id = p_stop and x.qr_token = btrim(coalesce(p_token, ''));
  if not found then return jerr('That QR code is not valid.'); end if;
  insert into presence (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid)
  on conflict (team_id, stop_id) do update set at = now(), user_id = excluded.user_id;
  if v_stop.role = 'stop' then insert into discoveries (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing; end if;
  insert into events (user_id, team_id, kind, stop_id, ok, detail) values (v_uid, v_team.id, 'qr', p_stop, true, 'scanned');
  return jsonb_build_object('ok', true, 'place', v_stop.place);
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
      'id', s.id, 'ord', s.ord, 'role', s.role, 'entryMode', s.entry_mode,
      'discovered', f.d,
      'released', f.r,                                   -- hint + entry question are at the base
      'needsFlag', x.entry_answer is not null,
      -- what a team has not discovered stays hidden: no name, no position
      'name', case when f.d then s.name end, 'place', case when f.d then s.place end, 'label', case when f.d then s.label end,
      'type', case when f.d then s.type end, 'icon', case when f.d then s.icon end,
      'lat', case when f.d then s.lat end, 'lng', case when f.d then s.lng end, 'radius', case when f.d then s.radius_m end,
      'description', case when f.d then s.description end,
      'hint', case when f.r then x.hint end,
      'entryQuestion', case when f.r then x.entry_question end,
      'entryFlag', case when f.r and x.entry_question is null then x.entry_answer end,
      'prevOrd', (select p.ord from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1),
      'state', case when stop_is_clear(v_team.id, s.id) then 'cleared' when stop_open(v_team.id, s.id) then 'open' else 'locked' end,
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
    cross join lateral (select stop_discovered(v_team.id, s.id) as d, stop_released(v_team.id, s.id) as r) f
    where s.role = 'hub'
       or s.role = 'stop'
       or stop_open(v_team.id, s.id)
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
  if v_role not in ('hub', 'stop', 'bonus') or v_mode not in ('chain', 'open') then return jerr('Unknown role or entry mode.'); end if;
  if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then return jerr('Latitude / longitude are not valid.'); end if;
  if v_radius < 5 or v_radius > 500 then return jerr('Radius must be 5 to 500 m.'); end if;
  if btrim(coalesce(p ->> 'place', '')) = '' or btrim(coalesce(p ->> 'name', '')) = '' then return jerr('Place name and quest title are required.'); end if;
  if v_role = 'stop' and (btrim(coalesce(p ->> 'exitFlag', '')) = '' or btrim(coalesce(p ->> 'nextClue', '')) = '') then return jerr('A location needs its handoff flag and a next clue.'); end if;
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

create or replace function public.admin_team_action(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_team uuid := (p ->> 'team')::uuid;
  v_action text := p ->> 'action';
  v_stop text := p ->> 'stop';
  v_idx int := (p ->> 'idx')::int;
  v_user uuid := (p ->> 'user')::uuid;
  v_to uuid := (p ->> 'to')::uuid;
  v_name text;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select name into v_name from teams where id = v_team;
  if v_name is null then return jerr('Unknown team.'); end if;
  case v_action
    when 'unlock_team' then update teams set locked = false, locked_at = null where id = v_team;
    when 'lock_team' then update teams set locked = true, locked_at = coalesce(locked_at, now()) where id = v_team;
    when 'rename' then
      if char_length(btrim(coalesce(p ->> 'name', ''))) not between 2 and 24 then return jerr('Team names are 2 to 24 characters.'); end if;
      update teams set name = btrim(p ->> 'name') where id = v_team;
    when 'remove_member' then
      delete from team_members where user_id = v_user and team_id = v_team;
      if not exists (select 1 from team_members where team_id = v_team) then delete from teams where id = v_team;
      elsif (select leader_id from teams where id = v_team) = v_user then update teams set leader_id = (select user_id from team_members where team_id = v_team order by joined_at limit 1) where id = v_team; end if;
    when 'move_member' then
      if not exists (select 1 from teams where id = v_to) then return jerr('Unknown destination team.'); end if;
      if (select count(*) from team_members where team_id = v_to) >= 4 then return jerr('The destination team is full (4).'); end if;
      delete from team_members where user_id = v_user and team_id = v_team;
      insert into team_members (user_id, team_id) values (v_user, v_to) on conflict (user_id) do update set team_id = excluded.team_id;
      if not exists (select 1 from team_members where team_id = v_team) then delete from teams where id = v_team;
      elsif (select leader_id from teams where id = v_team) = v_user then update teams set leader_id = (select user_id from team_members where team_id = v_team order by joined_at limit 1) where id = v_team; end if;
    when 'disband' then delete from teams where id = v_team;
    when 'reset_progress' then
      delete from solves where team_id = v_team; delete from unlocks where team_id = v_team; delete from hub_flags where team_id = v_team;
      delete from presence where team_id = v_team; delete from photo_submissions where team_id = v_team; delete from discoveries where team_id = v_team;
      update teams set started_at = null, finished_at = null where id = v_team;
    when 'check_in' then update teams set started_at = coalesce(started_at, now()) where id = v_team;
    when 'clear_finish' then update teams set finished_at = null where id = v_team;
    when 'grant_stop' then   -- bypass a blocked location: unlock it and mark all its questions solved
      insert into unlocks (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      insert into discoveries (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      insert into solves (team_id, stop_id, idx, user_id) select v_team, stop_id, idx, null from puzzles where stop_id = v_stop on conflict do nothing;
      perform check_finish(v_team);
    when 'grant_puzzle' then
      insert into unlocks (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      insert into discoveries (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      insert into solves (team_id, stop_id, idx, user_id) values (v_team, v_stop, v_idx, null) on conflict do nothing;
      perform check_finish(v_team);
    when 'revoke_puzzle' then
      delete from solves where team_id = v_team and stop_id = v_stop and idx = v_idx;
      update teams set finished_at = null where id = v_team;
    when 'grant_hub_flag' then
      insert into hub_flags (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      if (select count(*) from hub_flags where team_id = v_team) >= (select count(*) from stops where role = 'stop') then
        insert into unlocks (team_id, stop_id, user_id) select v_team, id, auth.uid() from stops where role = 'bonus' on conflict do nothing;
      end if;
      perform check_finish(v_team);
    else return jerr('Unknown action.');
  end case;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, detail) values (auth.uid(), v_team, 'admin_action', v_stop, v_idx, true, v_action || ' (' || v_name || ')');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_teams() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'code', t.code, 'locked', t.locked, 'lockedAt', t.locked_at,
    'createdAt', t.created_at, 'leaderId', t.leader_id, 'startedAt', t.started_at, 'finishedAt', t.finished_at,
    'lastActivity', (select max(at) from events e where e.team_id = t.id),
    'hubFlags', (select coalesce(jsonb_agg(stop_id), '[]'::jsonb) from hub_flags h where h.team_id = t.id),
    'discovered', (select coalesce(jsonb_agg(stop_id), '[]'::jsonb) from discoveries d where d.team_id = t.id),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.user_id, 'name', display_name(m.user_id), 'email', u.email, 'isLeader', m.user_id = t.leader_id,
        'joinedAt', m.joined_at,
        'solves', (select count(*) from solves s where s.team_id = t.id and s.user_id = m.user_id),
        'unlocks', (select count(*) from unlocks k where k.team_id = t.id and k.user_id = m.user_id),
        'wrong', (select count(*) from events e where e.team_id = t.id and e.user_id = m.user_id and e.ok = false
                    and e.kind in ('flag', 'unlock', 'hub_flag') and e.detail is distinct from 'out_of_range'),
        'lastSeen', (select updated_at from player_locations l where l.user_id = m.user_id)
      ) order by m.joined_at), '[]'::jsonb)
      from team_members m join auth.users u on u.id = m.user_id where m.team_id = t.id),
    'solved', (select coalesce(jsonb_agg(jsonb_build_object(
        'stopId', s.stop_id, 'idx', s.idx, 'title', pz.title, 'kind', pz.kind,
        'userId', s.user_id, 'userName', case when s.user_id is null then 'organiser' else display_name(s.user_id) end, 'at', s.at) order by s.at), '[]'::jsonb)
      from solves s join puzzles pz on pz.stop_id = s.stop_id and pz.idx = s.idx where s.team_id = t.id),
    'unlocked', (select coalesce(jsonb_agg(jsonb_build_object(
        'stopId', k.stop_id, 'userName', case when k.user_id is null then 'organiser' else display_name(k.user_id) end, 'at', k.at) order by k.at), '[]'::jsonb)
      from unlocks k where k.team_id = t.id)
  ) order by t.created_at) from teams t), '[]'::jsonb);
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
grant execute on function public.hub_checkin(double precision, double precision, double precision) to authenticated;
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
grant execute on function public.update_my_location(double precision, double precision, double precision) to authenticated;
grant execute on function public.unlock_stop(text, text, double precision, double precision, double precision) to authenticated;
