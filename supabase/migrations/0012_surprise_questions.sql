-- 0012: surprise questions. An organiser drops one mid-event: it is announced on every phone and appears at the base,
-- where each team answers it once. Flags stay in a table players cannot read.
create table if not exists public.surprises (
  id bigint generated always as identity primary key,
  title text not null,
  url text,
  flag text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create table if not exists public.surprise_solves (
  surprise_id bigint not null references public.surprises (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid,
  at timestamptz not null default now(),
  primary key (surprise_id, team_id)
);
alter table public.surprises enable row level security;
alter table public.surprise_solves enable row level security;

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
    'leaderId', v_team.leader_id, 'me', v_uid, 'min', 1, 'max', 4,
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
      'entryUrl', case when f.r then x.entry_url end,
      'entryFlag', case when f.r and x.entry_question is null then x.entry_answer end,
      'prevOrd', (select p.ord from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1),
      'state', case when stop_is_clear(v_team.id, s.id) then 'cleared' when stop_open(v_team.id, s.id) then 'open' else 'locked' end,
      'puzzleCount', (select count(*) from puzzles where stop_id = s.id),
      'exitFlag', case when stop_is_clear(v_team.id, s.id) then x.exit_flag end,
      'nextClue', case when stop_is_clear(v_team.id, s.id) then x.next_clue end,
      'puzzles', case when stop_open(v_team.id, s.id) then (select coalesce(jsonb_agg(jsonb_build_object(
          'idx', p.idx, 'title', p.title, 'kind', p.kind, 'prompt', p.prompt,
          'questionUrl', case when p.kind = 'flag' or photo_cleared(v_team.id, p.stop_id, p.idx) then ps.question_url end,
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
                      from (select * from announcements where at > now() - interval '8 hours' and (team_id is null or team_id = v_team.id) order by id desc limit 5) a),
    'surprise', (select jsonb_build_object('id', q.id, 'title', q.title, 'url', q.url, 'at', q.created_at,
                   'solved', exists (select 1 from surprise_solves ss where ss.surprise_id = q.id and ss.team_id = v_team.id))
                 from surprises q where q.closed_at is null order by q.id desc limit 1));
end $$;

create or replace function public.admin_save_surprise(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_url text := nullif(btrim(coalesce(p ->> 'url', '')), ''); v_id bigint;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if btrim(coalesce(p ->> 'title', '')) = '' then return jerr('A surprise question needs a title.'); end if;
  if btrim(coalesce(p ->> 'flag', '')) = '' then return jerr('A surprise question needs its answer flag.'); end if;
  if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then return jerr('The question link must start with http:// or https://'); end if;
  update surprises set closed_at = now() where closed_at is null;
  insert into surprises (title, url, flag) values (left(btrim(p ->> 'title'), 300), v_url, btrim(p ->> 'flag')) returning id into v_id;
  insert into announcements (team_id, message, level) values (null, left(coalesce(nullif(btrim(p ->> 'announce'), ''), 'Surprise question! Head to the base to answer it.'), 280), 'warn');
  insert into events (user_id, kind, ok, detail) values (auth.uid(), 'broadcast', true, 'surprise question dropped');
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.admin_close_surprise(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update surprises set closed_at = now() where id = p_id and closed_at is null;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_surprises() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'title', q.title, 'url', q.url, 'flag', q.flag, 'at', q.created_at, 'closedAt', q.closed_at,
    'solvedBy', (select coalesce(jsonb_agg(t.name order by ss.at), '[]'::jsonb) from surprise_solves ss join teams t on t.id = ss.team_id where ss.surprise_id = q.id)) order by q.id desc)
    from surprises q), '[]'::jsonb);
end $$;

create or replace function public.submit_surprise(p_id bigint, p_flag text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_err text; v_ok boolean; v_flag text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  select flag into v_flag from surprises where id = p_id and closed_at is null;
  if v_flag is null then return jerr('This surprise question is closed.'); end if;
  if exists (select 1 from surprise_solves where surprise_id = p_id and team_id = v_team.id) then return jerr('Your team already answered this one.'); end if;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  v_ok := norm_flag(p_flag) = norm_flag(v_flag);
  insert into events (user_id, team_id, kind, ok, detail) values (v_uid, v_team.id, 'flag', v_ok, case when v_ok then 'surprise question' else 'surprise: ' || left(btrim(coalesce(p_flag, '')), 80) end);
  if not v_ok then return jerr('That flag is not quite right. Check the question and try again.'); end if;
  insert into surprise_solves (surprise_id, team_id, user_id) values (p_id, v_team.id, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.submit_surprise(bigint, text) to authenticated;
grant execute on function public.admin_save_surprise(jsonb) to authenticated;
grant execute on function public.admin_close_surprise(bigint) to authenticated;
grant execute on function public.admin_surprises() to authenticated;
