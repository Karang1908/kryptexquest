-- Game flow v2: a base (hub) location, entry modes, photo-then-question puzzles, a bonus location unlocked from the
-- hub, event state (start / pause / end), broadcasts, leaderboard, QR proof of presence, help requests, admin tools.
-- Run after 0003.
--
-- All game data now reaches players ONLY through my_progress(): hints, questions and locations are revealed per team
-- according to the rules, so clients can no longer read the stops / puzzles tables directly.

-- ---------- schema ----------
alter table public.stops drop constraint if exists stops_ord_check;
alter table public.stops add constraint stops_ord_check check (ord >= 0);
alter table public.stops add column role text not null default 'stop' check (role in ('hub', 'stop', 'bonus'));
-- chain: the entry flag is the previous stop's handoff flag, typed at the stop.
-- hub:   the entry answer is earned by answering a basic question at the base.
-- open:  no gate.
alter table public.stops add column entry_mode text not null default 'chain' check (entry_mode in ('chain', 'hub', 'open'));
create unique index stops_one_hub on public.stops (role) where role = 'hub';

alter table public.stop_secrets alter column exit_flag drop not null;
alter table public.stop_secrets alter column next_clue drop not null;
alter table public.stop_secrets add column hint text not null default '';
alter table public.stop_secrets add column entry_question text;
alter table public.stop_secrets add column entry_answer text;
alter table public.stop_secrets add column qr_token text not null default substr(md5(random()::text || clock_timestamp()::text), 1, 12);

-- Photo puzzles: `puzzles.prompt` is the CLUE ("find the object that ..."); this is the question revealed after the photo.
alter table public.puzzle_secrets add column question text;

alter table public.teams add column started_at timestamptz;     -- first check-in at the base
alter table public.teams add column finished_at timestamptz;

create table public.game_state (
  id boolean primary key default true check (id),
  status text not null default 'lobby' check (status in ('lobby', 'running', 'paused', 'ended')),
  starts_at timestamptz,
  ends_at timestamptz,
  board_public boolean not null default false,
  hub_reveal text not null default 'all' check (hub_reveal in ('all', 'progressive')),
  bounds jsonb,                                  -- {lat,lng,radius}: the quest area
  no_go jsonb not null default '[]'::jsonb,      -- [{label,lat,lng,radius}]
  updated_at timestamptz not null default now()
);
insert into public.game_state default values;

create table public.announcements (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  team_id uuid,                                  -- null = everyone
  message text not null,
  level text not null default 'info' check (level in ('info', 'warn'))
);
create index announcements_at on public.announcements (at desc);

create table public.hub_flags (
  team_id uuid not null references public.teams on delete cascade,
  stop_id text not null references public.stops on delete cascade,
  user_id uuid,
  at timestamptz not null default now(),
  primary key (team_id, stop_id)
);

create table public.presence (                    -- "scanned the QR at this stop": counts as being in range for 15 min
  team_id uuid not null references public.teams on delete cascade,
  stop_id text not null references public.stops on delete cascade,
  user_id uuid,
  at timestamptz not null default now(),
  primary key (team_id, stop_id)
);

create table public.help_requests (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid not null,
  team_id uuid,
  lat double precision,
  lng double precision,
  message text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid,
  resolved_at timestamptz
);

alter table public.game_state enable row level security;
alter table public.announcements enable row level security;
alter table public.hub_flags enable row level security;
alter table public.presence enable row level security;
alter table public.help_requests enable row level security;

-- Clients no longer read content tables; admins use admin_content().
drop policy if exists "stops are readable" on public.stops;
drop policy if exists "puzzles are readable" on public.puzzles;
drop policy if exists "admins edit stops" on public.stops;
revoke all on public.stops, public.puzzles from authenticated;

-- ---------- helpers ----------
create or replace function public.jerr(p_text text) returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'error', p_text) $$;

create or replace function public.game_status() returns text
language plpgsql stable security definer set search_path = public as $$
declare g game_state;
begin
  select * into g from game_state;
  if g.status = 'ended' or (g.status = 'running' and g.ends_at is not null and now() >= g.ends_at) then return 'ended'; end if;
  if g.status = 'running' and g.starts_at is not null and now() < g.starts_at then return 'lobby'; end if;
  return g.status;
end $$;

create or replace function public.game_error() returns text
language sql stable security definer set search_path = public as $$
  select case public.game_status()
    when 'lobby' then 'The quest has not started yet.'
    when 'paused' then 'The quest is paused. Wait for the organisers.'
    when 'ended' then 'The quest has ended.'
    else null end
$$;

create or replace function public.stop_open(p_team uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stops where id = p_stop and (role = 'hub' or (role = 'stop' and entry_mode = 'open')))
      or exists (select 1 from unlocks where team_id = p_team and stop_id = p_stop)
$$;

create or replace function public.hub_id() returns text
language sql stable security definer set search_path = public as $$ select id from stops where role = 'hub' $$;

-- A team may play once it has checked in at the base (or if no base exists).
create or replace function public.team_started(p_team uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from stops where role = 'hub') or coalesce((select started_at is not null from teams where id = p_team), false)
$$;

-- At the stop: within its radius (plus the phone's own accuracy, capped at 25 m), or scanned its QR in the last 15 min.
create or replace function public.in_range(p_team uuid, p_stop text, p_lat double precision, p_lng double precision, p_acc double precision)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
      select p_lat is not null and p_lng is not null
         and distance_m(p_lat, p_lng, s.lat, s.lng) <= s.radius_m + least(greatest(coalesce(p_acc, 0), 0), 25)
      from stops s where s.id = p_stop), false)
    or exists (select 1 from presence where team_id = p_team and stop_id = p_stop and at > now() - interval '15 minutes')
$$;

create or replace function public.photo_cleared(p_team uuid, p_stop text, p_idx int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from photo_submissions where team_id = p_team and stop_id = p_stop and idx = p_idx and status = 'approved')
$$;

create or replace function public.check_finish(p_team uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_stops int; v_flags int; v_bonus int; v_bonus_clear boolean;
begin
  select count(*) into v_stops from stops where role = 'stop';
  select count(*) into v_flags from hub_flags where team_id = p_team;
  select count(*) into v_bonus from stops where role = 'bonus';
  select coalesce(bool_and(stop_is_clear(p_team, id)), true) into v_bonus_clear from stops where role = 'bonus';
  if v_flags >= v_stops and (v_bonus = 0 or v_bonus_clear) then
    update teams set finished_at = now() where id = p_team and finished_at is null;
    if found then insert into events (team_id, kind, ok, detail) values (p_team, 'finished', true, 'quest complete'); end if;
  end if;
end $$;

-- ---------- player: the one source of truth ----------
drop function if exists public.my_progress();
create function public.my_progress() returns jsonb
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

-- ---------- player: actions ----------
create or replace function public.hub_checkin(p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_hub text := hub_id(); v_err text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if v_team.started_at is not null then return jsonb_build_object('ok', true); end if;
  if v_hub is not null and not in_range(v_team.id, v_hub, p_lat, p_lng, p_acc) then return jerr('Go to the base (the vending machine area) to check in.'); end if;
  update teams set started_at = now() where id = v_team.id;
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng) values (v_uid, v_team.id, 'checkin', v_hub, true, p_lat, p_lng);
  return jsonb_build_object('ok', true);
end $$;

-- Entry for a "chain" stop: type the previous stop's handoff flag while standing at this stop.
drop function if exists public.unlock_stop(text, text, double precision, double precision);
create function public.unlock_stop(p_stop text, p_flag text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_prev stops; v_err text; v_ok boolean; v_dist double precision;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  select * into v_stop from stops where id = p_stop;
  if not found or v_stop.role <> 'stop' then return jerr('Unknown location.'); end if;
  if stop_open(v_team.id, p_stop) then return jsonb_build_object('ok', true); end if;
  if v_stop.entry_mode = 'hub' then return jerr('This location is unlocked at the base: answer its question there.'); end if;
  v_dist := case when p_lat is null or p_lng is null then null else distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) end;
  if not in_range(v_team.id, p_stop, p_lat, p_lng, p_acc) then
    insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'unlock', p_stop, false, p_lat, p_lng, v_dist, 'out_of_range');
    return jerr('You need to be at this location. Indoors? Scan the QR code posted there.');
  end if;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  select * into v_prev from stops where role = 'stop' and ord < v_stop.ord order by ord desc limit 1;
  if v_prev.id is not null and not stop_is_clear(v_team.id, v_prev.id) then return jerr('Clear ' || v_prev.place || ' first.'); end if;
  v_ok := v_prev.id is null or norm_flag(p_flag) = norm_flag((select exit_flag from stop_secrets where stop_id = v_prev.id));
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'unlock', p_stop, v_ok, p_lat, p_lng, v_dist, case when v_ok then null else 'wrong password' end);
  if not v_ok then return jerr('Access denied. The previous stop holds this password.'); end if;
  insert into unlocks (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Entry for a "hub" stop: answer its basic question while standing at the base.
create or replace function public.hub_answer(p_stop text, p_answer text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_err text; v_ok boolean; v_hub text := hub_id();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  select * into v_stop from stops where id = p_stop and role = 'stop' and entry_mode = 'hub';
  if not found then return jerr('That location is not unlocked with a base question.'); end if;
  if stop_open(v_team.id, p_stop) then return jsonb_build_object('ok', true); end if;
  if v_hub is not null and not in_range(v_team.id, v_hub, p_lat, p_lng, p_acc) then return jerr('Answer base questions at the base (the vending machine area).'); end if;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  v_ok := norm_flag(p_answer) = norm_flag((select entry_answer from stop_secrets where stop_id = p_stop));
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, detail) values (v_uid, v_team.id, 'unlock', p_stop, v_ok, p_lat, p_lng, case when v_ok then 'base question' else left(btrim(coalesce(p_answer, '')), 60) end);
  if not v_ok then return jerr('Not quite. Check the hint and try again.'); end if;
  insert into unlocks (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- At the base: hand in a location's handoff flag. When all are in, the bonus location unlocks.
create or replace function public.hub_submit_flag(p_flag text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_err text; v_hub text := hub_id(); v_have int; v_need int;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  if v_hub is not null and not in_range(v_team.id, v_hub, p_lat, p_lng, p_acc) then return jerr('Hand in flags at the base (the vending machine area).'); end if;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  select s.* into v_stop from stops s join stop_secrets x on x.stop_id = s.id where s.role = 'stop' and norm_flag(x.exit_flag) = norm_flag(p_flag);
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, detail) values (v_uid, v_team.id, 'hub_flag', v_stop.id, v_stop.id is not null, p_lat, p_lng, case when v_stop.id is null then left(btrim(coalesce(p_flag, '')), 60) end);
  if v_stop.id is null then return jerr('That is not a location flag. Check it and try again.'); end if;
  insert into hub_flags (team_id, stop_id, user_id) values (v_team.id, v_stop.id, v_uid) on conflict do nothing;
  select count(*) into v_have from hub_flags where team_id = v_team.id;
  select count(*) into v_need from stops where role = 'stop';
  if v_have >= v_need then
    insert into unlocks (team_id, stop_id, user_id) select v_team.id, id, v_uid from stops where role = 'bonus' on conflict do nothing;
  end if;
  perform check_finish(v_team.id);
  return jsonb_build_object('ok', true, 'place', v_stop.place, 'have', v_have, 'need', v_need);
end $$;

-- A flag answer. Photo puzzles need the photo stage cleared first (the question is hidden until then).
drop function if exists public.submit_flag(text, int, text, double precision, double precision);
create function public.submit_flag(p_stop text, p_idx int, p_flag text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_kind text; v_err text; v_ok boolean; v_dist double precision;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  select * into v_stop from stops where id = p_stop;
  select kind into v_kind from puzzles where stop_id = p_stop and idx = p_idx;
  if v_stop.id is null or v_kind is null or v_stop.role = 'hub' then return jerr('Unknown question.'); end if;
  if not stop_open(v_team.id, p_stop) then return jerr('Unlock this location first.'); end if;
  if v_kind = 'photo' and not photo_cleared(v_team.id, p_stop, p_idx) then return jerr('Photograph the object first. The question appears after the photo.'); end if;
  v_dist := case when p_lat is null or p_lng is null then null else distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) end;
  if not in_range(v_team.id, p_stop, p_lat, p_lng, p_acc) then
    insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'flag', p_stop, p_idx, false, p_lat, p_lng, v_dist, 'out_of_range');
    return jerr('You need to be at this location. Indoors? Scan the QR code posted there.');
  end if;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  v_ok := norm_flag(p_flag) = norm_flag((select flag from puzzle_secrets where stop_id = p_stop and idx = p_idx));
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'flag', p_stop, p_idx, v_ok, p_lat, p_lng, v_dist, case when v_ok then null else left(btrim(coalesce(p_flag, '')), 60) end);
  if not v_ok then return jerr('That flag is not quite right. Check the clue and try again.'); end if;
  insert into solves (team_id, stop_id, idx, user_id) values (v_team.id, p_stop, p_idx, v_uid) on conflict do nothing;
  perform check_finish(v_team.id);
  return jsonb_build_object('ok', true);
end $$;

-- QR proof of presence (the QR encodes a link; the game calls this with the stop id and token).
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
  insert into events (user_id, team_id, kind, stop_id, ok, detail) values (v_uid, v_team.id, 'qr', p_stop, true, 'scanned');
  return jsonb_build_object('ok', true, 'place', v_stop.place);
end $$;

-- Service role (verify-photo): a photo was approved, which clears the photo stage. Solving needs the flag too.
drop function if exists public.record_photo_solve(uuid, text, int, double precision, double precision);
create function public.record_photo_clear(p_user uuid, p_stop text, p_idx int, p_lat double precision, p_lng double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_team teams; v_stop stops;
begin
  select t.* into v_team from teams t where t.id = current_team(p_user);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  if not exists (select 1 from puzzles where stop_id = p_stop and idx = p_idx and kind = 'photo') then return jerr('Unknown photo question.'); end if;
  if not stop_open(v_team.id, p_stop) then return jerr('Unlock this location first.'); end if;
  select * into v_stop from stops where id = p_stop;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m)
  values (p_user, v_team.id, 'photo', p_stop, p_idx, true, p_lat, p_lng, distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.request_help(p_lat double precision, p_lng double precision, p_message text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if exists (select 1 from help_requests where user_id = v_uid and status = 'open' and at > now() - interval '2 minutes') then return jerr('Help is already on the way. Hold on.'); end if;
  insert into help_requests (user_id, team_id, lat, lng, message) values (v_uid, current_team(v_uid), p_lat, p_lng, left(coalesce(p_message, ''), 300));
  insert into events (user_id, team_id, kind, ok, lat, lng, detail) values (v_uid, current_team(v_uid), 'help', false, p_lat, p_lng, left(coalesce(p_message, ''), 120));
  return jsonb_build_object('ok', true);
end $$;

-- ---------- leaderboard ----------
create or replace function public.build_leaderboard() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'rank', rn, 'teamId', id, 'name', name, 'players', players, 'flags', flags, 'stopsCleared', cleared, 'hubFlags', hubflags,
      'startedAt', started_at, 'finishedAt', finished_at, 'elapsedSeconds', elapsed, 'lastSolveAt', last_solve) order by rn), '[]'::jsonb)
  from (
    select row_number() over (order by (finished_at is null), elapsed asc nulls last, flags desc, last_solve asc nulls last, created_at) as rn, *
    from (
      select t.id, t.name, t.created_at, t.started_at, t.finished_at,
             (select count(*) from team_members m where m.team_id = t.id) as players,
             (select count(*) from solves s where s.team_id = t.id) as flags,
             (select count(*) from stops st where st.role <> 'hub' and stop_is_clear(t.id, st.id)) as cleared,
             (select count(*) from hub_flags h where h.team_id = t.id) as hubflags,
             (select max(s.at) from solves s where s.team_id = t.id) as last_solve,
             case when t.finished_at is not null then extract(epoch from t.finished_at - coalesce(t.started_at, t.locked_at, t.created_at)) end as elapsed
      from teams t where t.locked
    ) base
  ) ranked
$$;

create or replace function public.leaderboard() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  return jsonb_build_object('status', game_status(), 'now', now(), 'me', current_team(auth.uid()), 'rows', build_leaderboard());
end $$;

create or replace function public.public_leaderboard() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (select board_public from game_state) then return jsonb_build_object('hidden', true); end if;
  return jsonb_build_object('hidden', false, 'status', game_status(), 'now', now(), 'startsAt', (select starts_at from game_state), 'endsAt', (select ends_at from game_state),
    'stops', (select count(*) from stops where role <> 'hub'),
    'rows', (select coalesce(jsonb_agg(r - 'teamId'), '[]'::jsonb) from jsonb_array_elements(build_leaderboard()) r));
end $$;

-- ---------- admin: content (replaces the 0003 versions) ----------
create or replace function public.admin_content() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', s.id, 'ord', s.ord, 'role', s.role, 'entryMode', s.entry_mode, 'name', s.name, 'place', s.place, 'label', s.label, 'type', s.type, 'icon', s.icon,
    'lat', s.lat, 'lng', s.lng, 'radius', s.radius_m, 'description', s.description,
    'hint', x.hint, 'entryQuestion', x.entry_question, 'entryAnswer', x.entry_answer, 'qrToken', x.qr_token,
    'exitFlag', x.exit_flag, 'nextClue', x.next_clue,
    'puzzles', (select coalesce(jsonb_agg(jsonb_build_object(
        'idx', p.idx, 'title', p.title, 'prompt', p.prompt, 'kind', p.kind, 'flag', ps.flag, 'question', ps.question,
        'refs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'path', r.path) order by r.created_at), '[]'::jsonb)
                 from photo_refs r where r.stop_id = p.stop_id and r.idx = p.idx)) order by p.idx), '[]'::jsonb)
      from puzzles p left join puzzle_secrets ps on ps.stop_id = p.stop_id and ps.idx = p.idx where p.stop_id = s.id)
  ) order by s.ord) from stops s left join stop_secrets x on x.stop_id = s.id), '[]'::jsonb);
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
  if v_role not in ('hub', 'stop', 'bonus') or v_mode not in ('chain', 'hub', 'open') then return jerr('Unknown role or entry mode.'); end if;
  if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then return jerr('Latitude / longitude are not valid.'); end if;
  if v_radius < 5 or v_radius > 500 then return jerr('Radius must be 5 to 500 m.'); end if;
  if btrim(coalesce(p ->> 'place', '')) = '' or btrim(coalesce(p ->> 'name', '')) = '' then return jerr('Place name and quest title are required.'); end if;
  if v_role = 'stop' and (btrim(coalesce(p ->> 'exitFlag', '')) = '' or btrim(coalesce(p ->> 'nextClue', '')) = '') then return jerr('A location needs its handoff flag and a next clue.'); end if;
  if v_role = 'bonus' and btrim(coalesce(p ->> 'exitFlag', '')) = '' then return jerr('The bonus location needs a final flag.'); end if;
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

-- Quick edit from the live map (position, radius, names).
create or replace function public.admin_move_stop(p_id text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update stops set lat = coalesce((p ->> 'lat')::double precision, lat), lng = coalesce((p ->> 'lng')::double precision, lng),
    radius_m = coalesce((p ->> 'radius')::int, radius_m), place = coalesce(nullif(btrim(p ->> 'place'), ''), place), name = coalesce(nullif(btrim(p ->> 'name'), ''), name)
  where id = p_id;
  if not found then return jerr('Unknown location.'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_delete_stop(p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  delete from stops where id = p_id;
  update stops set ord = ord + 1000 where ord >= 1;
  update stops s set ord = r.rn from (select id, row_number() over (order by ord) as rn from stops where ord >= 1000) r where s.id = r.id;
  insert into events (user_id, kind, stop_id, ok, detail) values (auth.uid(), 'content', p_id, true, 'location deleted');
  return jsonb_build_object('ok', true);
end $$;

-- p_ids: every non-base location, in play order (the base always stays at 0).
create or replace function public.admin_reorder_stops(p_ids text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if (select count(*) from stops where role <> 'hub') <> coalesce(array_length(p_ids, 1), 0)
     or exists (select 1 from unnest(p_ids) i where not exists (select 1 from stops where id = i and role <> 'hub')) then
    return jerr('The list does not match the existing locations.');
  end if;
  update stops set ord = ord + 1000 where ord >= 1;
  update stops s set ord = t.n from (select id, ordinality as n from unnest(p_ids) with ordinality as u(id, ordinality)) t where s.id = t.id;
  insert into events (user_id, kind, ok, detail) values (auth.uid(), 'content', true, 'locations reordered');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_save_puzzle(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_stop text := p ->> 'stop';
  v_kind text := p ->> 'kind';
  v_idx int := (p ->> 'idx')::int;
  v_flag text := nullif(btrim(coalesce(p ->> 'flag', '')), '');
  v_question text := nullif(btrim(coalesce(p ->> 'question', '')), '');
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from stops where id = v_stop and role <> 'hub') then return jerr('Unknown location (the base has no questions).'); end if;
  if v_kind not in ('flag', 'photo') then return jerr('Question type must be flag or photo.'); end if;
  if btrim(coalesce(p ->> 'title', '')) = '' or btrim(coalesce(p ->> 'prompt', '')) = '' then return jerr('Title and clue / question text are required.'); end if;
  if v_flag is null then return jerr('Every question needs its answer flag.'); end if;
  if v_kind = 'photo' and v_question is null then return jerr('A photo question needs the question that appears after the photo.'); end if;
  if v_kind = 'flag' then v_question := null; end if;
  if v_idx is null then select coalesce(max(idx), -1) + 1 into v_idx from puzzles where stop_id = v_stop; end if;
  insert into puzzles (stop_id, idx, title, prompt, kind) values (v_stop, v_idx, btrim(p ->> 'title'), btrim(p ->> 'prompt'), v_kind)
  on conflict (stop_id, idx) do update set title = excluded.title, prompt = excluded.prompt, kind = excluded.kind;
  insert into puzzle_secrets (stop_id, idx, flag, question) values (v_stop, v_idx, v_flag, v_question)
  on conflict (stop_id, idx) do update set flag = excluded.flag, question = excluded.question;
  insert into events (user_id, kind, stop_id, idx, ok, detail) values (auth.uid(), 'content', v_stop, v_idx, true, 'question saved (' || v_kind || ')');
  return jsonb_build_object('ok', true, 'idx', v_idx);
end $$;

-- ---------- admin: review (a photo approval now only clears the photo stage) ----------
create or replace function public.admin_review_photo(p_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sub photo_submissions;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into v_sub from photo_submissions where id = p_id for update;
  if not found then return jerr('Unknown submission.'); end if;
  update photo_submissions set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, detail)
  values (auth.uid(), v_sub.team_id, 'photo_review', v_sub.stop_id, v_sub.idx, p_approve, case when p_approve then 'approved by organiser' else 'rejected by organiser' end);
  return jsonb_build_object('ok', true);
end $$;

-- ---------- admin: event control ----------
create or replace function public.admin_game() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return (select jsonb_build_object('status', status, 'effective', game_status(), 'startsAt', starts_at, 'endsAt', ends_at, 'boardPublic', board_public,
                                    'hubReveal', hub_reveal, 'bounds', bounds, 'noGo', no_go, 'now', now()) from game_state);
end $$;

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
    updated_at = now();
  insert into events (user_id, kind, ok, detail) values (auth.uid(), 'game', true, left(p::text, 200));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_broadcast(p_message text, p_team uuid, p_level text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if btrim(coalesce(p_message, '')) = '' then return jerr('Write a message first.'); end if;
  insert into announcements (team_id, message, level) values (p_team, left(btrim(p_message), 280), case when p_level = 'warn' then 'warn' else 'info' end);
  insert into events (user_id, team_id, kind, ok, detail) values (auth.uid(), p_team, 'broadcast', true, left(btrim(p_message), 120));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_help_requests() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'at', h.at, 'name', display_name(h.user_id), 'teamName', t.name, 'lat', h.lat, 'lng', h.lng,
           'message', h.message, 'status', h.status) order by (h.status = 'open') desc, h.at desc)
         from (select * from help_requests order by at desc limit 50) h left join teams t on t.id = h.team_id), '[]'::jsonb);
end $$;

create or replace function public.admin_resolve_help(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  update help_requests set status = 'resolved', resolved_by = auth.uid(), resolved_at = now() where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- admin: team actions ----------
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
      delete from presence where team_id = v_team; delete from photo_submissions where team_id = v_team;
      update teams set started_at = null, finished_at = null where id = v_team;
    when 'check_in' then update teams set started_at = coalesce(started_at, now()) where id = v_team;
    when 'clear_finish' then update teams set finished_at = null where id = v_team;
    when 'grant_stop' then   -- bypass a blocked location: unlock it and mark all its questions solved
      insert into unlocks (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      insert into solves (team_id, stop_id, idx, user_id) select v_team, stop_id, idx, null from puzzles where stop_id = v_stop on conflict do nothing;
      perform check_finish(v_team);
    when 'grant_puzzle' then
      insert into unlocks (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
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

-- ---------- admin: teams view (replaces 0002 version), stats, purge ----------
create or replace function public.admin_teams() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'code', t.code, 'locked', t.locked, 'lockedAt', t.locked_at,
    'createdAt', t.created_at, 'leaderId', t.leader_id, 'startedAt', t.started_at, 'finishedAt', t.finished_at,
    'lastActivity', (select max(at) from events e where e.team_id = t.id),
    'hubFlags', (select coalesce(jsonb_agg(stop_id), '[]'::jsonb) from hub_flags h where h.team_id = t.id),
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

create or replace function public.admin_question_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'stopId', p.stop_id, 'idx', p.idx,
    'teamsSolved', (select count(*) from solves s where s.stop_id = p.stop_id and s.idx = p.idx),
    'avgSeconds', (select round(avg(extract(epoch from s.at - k.at)))::int from solves s join unlocks k on k.team_id = s.team_id and k.stop_id = s.stop_id
                   where s.stop_id = p.stop_id and s.idx = p.idx and s.at > k.at),
    'wrongGuesses', (select count(*) from events e where e.kind = 'flag' and e.ok = false and e.stop_id = p.stop_id and e.idx = p.idx and e.detail is distinct from 'out_of_range'),
    'photoMisses', (select count(*) from photo_submissions q where q.stop_id = p.stop_id and q.idx = p.idx and q.status = 'rejected'),
    'photoReviews', (select count(*) from photo_submissions q where q.stop_id = p.stop_id and q.idx = p.idx and q.status = 'pending')
  )) from puzzles p), '[]'::jsonb);
end $$;

-- 'locations' | 'photos'. For photos the caller deletes the returned storage paths too.
create or replace function public.admin_purge(p_what text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_paths jsonb := '[]'::jsonb;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if p_what = 'locations' then
    delete from player_locations;
    update events set lat = null, lng = null where lat is not null;
    update help_requests set lat = null, lng = null;
  elsif p_what = 'photos' then
    select coalesce(jsonb_agg(path), '[]'::jsonb) into v_paths from photo_submissions;
    delete from photo_submissions;
  else return jerr('Unknown purge.');
  end if;
  insert into events (user_id, kind, ok, detail) values (auth.uid(), 'content', true, 'purged ' || p_what);
  return jsonb_build_object('ok', true, 'paths', v_paths);
end $$;

-- ---------- privileges ----------
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
grant execute on function public.unlock_stop(text, text, double precision, double precision, double precision) to authenticated;
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
