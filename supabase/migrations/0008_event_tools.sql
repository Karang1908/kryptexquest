-- 0008: teammate positions, rehearsal (test) teams, organiser alerts, team recap.

alter table public.teams add column if not exists is_test boolean not null default false;

-- Rehearsal teams ignore the event clock (so organisers can rehearse before the real start).
create or replace function public.game_error() returns text
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from teams where id = current_team(auth.uid()) and is_test) then null
    else case public.game_status()
      when 'lobby' then 'The quest has not started yet.'
      when 'paused' then 'The quest is paused. Wait for the organisers.'
      when 'ended' then 'The quest has ended.'
      else null end
  end
$$;

-- A single-player locked team flagged as a test, for the signed-in organiser. It never appears on the leaderboard.
create or replace function public.admin_start_rehearsal() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team uuid; v_id uuid;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  v_team := current_team(v_uid);
  if v_team is not null then
    if exists (select 1 from teams where id = v_team and is_test) then return jsonb_build_object('ok', true, 'already', true); end if;
    return jerr('Leave your current team first, then start a rehearsal.');
  end if;
  insert into teams (name, code, leader_id, locked, locked_at, is_test)
  values ('Rehearsal ' || substr(md5(random()::text), 1, 4), upper(substr(md5(random()::text), 1, 6)), v_uid, true, now(), true)
  returning id into v_id;
  insert into team_members (user_id, team_id) values (v_uid, v_id);
  return jsonb_build_object('ok', true);
end $$;

-- Deletes the organiser's rehearsal team and everything it produced.
create or replace function public.admin_end_rehearsal() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select id into v_id from teams where is_test and leader_id = auth.uid();
  if v_id is null then return jerr('No rehearsal is running.'); end if;
  delete from events where team_id = v_id;
  delete from photo_submissions where team_id = v_id;
  delete from help_requests where team_id = v_id;
  delete from announcements where team_id = v_id;
  delete from player_locations where team_id = v_id;
  delete from teams where id = v_id;   -- members, unlocks, solves, hub_flags, presence, discoveries cascade
  return jsonb_build_object('ok', true);
end $$;

-- The ping that feeds the organiser map also returns what the phone needs: newly discovered locations and teammates' positions.
create or replace function public.update_my_location(p_lat double precision, p_lng double precision, p_accuracy double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_found jsonb := '[]'::jsonb; v_mates jsonb := '[]'::jsonb;
begin
  if v_uid is null or p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return jsonb_build_object('discovered', v_found, 'mates', v_mates); end if;
  insert into player_locations (user_id, team_id, lat, lng, accuracy, updated_at)
  values (v_uid, current_team(v_uid), p_lat, p_lng, p_accuracy, now())
  on conflict (user_id) do update
    set team_id = excluded.team_id, lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = now()
    where player_locations.updated_at < now() - interval '3 seconds';
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if found and v_team.locked and game_error() is null and team_started(v_team.id) then
    v_found := discover_nearby(v_team.id, v_uid, p_lat, p_lng, p_accuracy);
  end if;
  if found and v_team.locked then
    select coalesce(jsonb_agg(jsonb_build_object('id', l.user_id, 'name', display_name(l.user_id), 'lat', l.lat, 'lng', l.lng,
             'avatar', coalesce((select avatar from profiles where id = l.user_id), 'male'), 'at', l.updated_at)), '[]'::jsonb) into v_mates
    from player_locations l where l.team_id = v_team.id and l.user_id <> v_uid and l.updated_at > now() - interval '2 minutes';
  end if;
  return jsonb_build_object('discovered', v_found, 'mates', v_mates);
end $$;

-- Teams that need an organiser: no activity for 10 minutes while the event runs, or 5+ wrong answers to one question in 15 minutes.
create or replace function public.admin_alerts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return (
    select coalesce(jsonb_agg(a order by (a ->> 'minutes')::int desc nulls last), '[]'::jsonb) from (
      select jsonb_build_object('kind', 'stalled', 'teamId', t.id, 'teamName', t.name,
               'minutes', floor(extract(epoch from now() - greatest(coalesce((select max(at) from events e where e.team_id = t.id), t.started_at), t.started_at)) / 60)::int) as a
      from teams t
      where t.locked and not t.is_test and t.started_at is not null and t.finished_at is null and game_status() = 'running'
        and greatest(coalesce((select max(at) from events e where e.team_id = t.id), t.started_at), t.started_at) < now() - interval '10 minutes'
      union all
      select jsonb_build_object('kind', 'struggling', 'teamId', t.id, 'teamName', t.name, 'stopId', e.stop_id, 'idx', e.idx,
               'title', (select title from puzzles p where p.stop_id = e.stop_id and p.idx = e.idx), 'wrong', count(*), 'minutes', 0)
      from events e join teams t on t.id = e.team_id
      where e.kind = 'flag' and e.ok = false and e.at > now() - interval '15 minutes' and e.detail is distinct from 'out_of_range'
        and not t.is_test and t.finished_at is null and e.stop_id is not null
      group by t.id, t.name, e.stop_id, e.idx having count(*) >= 5
    ) x);
end $$;

-- After the finish: the team's story. Times are for this team; rank is among real (non-test) finished teams.
create or replace function public.team_recap() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_rank int; v_total int;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or v_team.finished_at is null then return jerr('The recap appears once your team has finished.'); end if;
  select (r ->> 'rank')::int into v_rank from jsonb_array_elements(build_leaderboard()) r where (r ->> 'teamId')::uuid = v_team.id;
  select count(*) into v_total from teams where locked and not is_test and finished_at is not null;
  return jsonb_build_object(
    'team', jsonb_build_object('name', v_team.name, 'startedAt', v_team.started_at, 'finishedAt', v_team.finished_at,
        'elapsedSeconds', extract(epoch from v_team.finished_at - coalesce(v_team.started_at, v_team.locked_at, v_team.created_at))::int,
        'rank', v_rank, 'finishedTeams', v_total),
    'stops', (select coalesce(jsonb_agg(jsonb_build_object(
        'ord', s.ord, 'place', s.place, 'name', s.name, 'icon', s.icon,
        'discoveredAt', (select at from discoveries d where d.team_id = v_team.id and d.stop_id = s.id),
        'unlockedAt', (select at from unlocks k where k.team_id = v_team.id and k.stop_id = s.id),
        'clearedAt', (select max(at) from solves x where x.team_id = v_team.id and x.stop_id = s.id),
        'handedInAt', (select at from hub_flags h where h.team_id = v_team.id and h.stop_id = s.id),
        'wrong', (select count(*) from events e where e.team_id = v_team.id and e.stop_id = s.id and e.kind = 'flag' and e.ok = false and e.detail is distinct from 'out_of_range')
      ) order by s.ord), '[]'::jsonb) from stops s where s.role = 'stop'),
    'flags', (select count(*) from solves where team_id = v_team.id),
    'wrong', (select count(*) from events e where e.team_id = v_team.id and e.kind = 'flag' and e.ok = false and e.detail is distinct from 'out_of_range'),
    'members', (select coalesce(jsonb_agg(jsonb_build_object('name', display_name(m.user_id),
        'solves', (select count(*) from solves x where x.team_id = v_team.id and x.user_id = m.user_id)) order by m.joined_at), '[]'::jsonb)
      from team_members m where m.team_id = v_team.id),
    'fastest', (select jsonb_build_object('title', pz.title, 'seconds', extract(epoch from x.at - k.at)::int, 'by', display_name(x.user_id))
        from solves x join unlocks k on k.team_id = x.team_id and k.stop_id = x.stop_id
        join puzzles pz on pz.stop_id = x.stop_id and pz.idx = x.idx
        where x.team_id = v_team.id and x.at > k.at order by x.at - k.at limit 1));
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
    'startedAt', v_team.started_at, 'finishedAt', v_team.finished_at, 'isTest', v_team.is_test,
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

create or replace function public.admin_teams() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'code', t.code, 'isTest', t.is_test, 'locked', t.locked, 'lockedAt', t.locked_at,
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
      from teams t where t.locked and not t.is_test
    ) base
  ) ranked
$$;

create or replace function public.admin_live() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'now', now(),
    'registered', (select count(*) from auth.users),
    'teams', (select count(*) from teams where not is_test),
    'lockedTeams', (select count(*) from teams where locked and not is_test),
    'flagsSolved', (select count(*) from solves s join teams x on x.id = s.team_id where not x.is_test),
    'players', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.user_id, 'name', display_name(l.user_id), 'email', u.email,
        'avatar', coalesce(p.avatar, 'male'), 'teamId', l.team_id, 'teamName', t.name,
        'lat', l.lat, 'lng', l.lng, 'accuracy', l.accuracy, 'updatedAt', l.updated_at))
      from player_locations l
      join auth.users u on u.id = l.user_id
      left join profiles p on p.id = l.user_id
      left join teams t on t.id = l.team_id), '[]'::jsonb));
end $$;

grant execute on function public.admin_start_rehearsal() to authenticated;
grant execute on function public.admin_end_rehearsal() to authenticated;
grant execute on function public.admin_alerts() to authenticated;
grant execute on function public.team_recap() to authenticated;
grant execute on function public.my_progress() to authenticated;
grant execute on function public.admin_teams() to authenticated;
grant execute on function public.admin_live() to authenticated;
grant execute on function public.update_my_location(double precision, double precision, double precision) to authenticated;
grant execute on function public.game_error() to service_role;
