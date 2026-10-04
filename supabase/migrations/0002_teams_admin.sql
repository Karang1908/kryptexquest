-- Teams (shared progress), live locations, audit log and admin tooling.
-- Run after 0001. This REPLACES the per-user unlocks/solves/attempts tables from 0001 with
-- per-team ones, so it discards any progress recorded under 0001 (fine before launch, not after).

-- ---------- retire the per-user progress model ----------
drop function if exists public.my_progress();
drop function if exists public.unlock_stop(text, text, double precision, double precision);
drop function if exists public.submit_flag(text, int, text, double precision, double precision);
drop function if exists public.record_photo_solve(uuid, text, int);
drop function if exists public.stop_is_clear(uuid, text);
drop function if exists public.stop_is_open(uuid, text);
drop table if exists public.attempts;
drop table if exists public.solves;
drop table if exists public.unlocks;

-- ---------- teams ----------
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 24),
  code text not null unique,
  leader_id uuid not null,
  locked boolean not null default false,
  locked_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index teams_name_key on public.teams (lower(btrim(name)));

create table public.team_members (
  user_id uuid primary key references auth.users on delete cascade,   -- one team per player
  team_id uuid not null references public.teams on delete cascade,
  joined_at timestamptz not null default now()
);
create index team_members_team on public.team_members (team_id);

-- Progress belongs to the team; user_id records which member did it.
create table public.unlocks (
  team_id uuid not null references public.teams on delete cascade,
  stop_id text not null references public.stops on delete cascade,
  user_id uuid,
  at timestamptz not null default now(),
  primary key (team_id, stop_id)
);
create table public.solves (
  team_id uuid not null references public.teams on delete cascade,
  stop_id text not null,
  idx int not null,
  user_id uuid,
  at timestamptz not null default now(),
  primary key (team_id, stop_id, idx),
  foreign key (stop_id, idx) references public.puzzles on delete cascade
);

-- Everything that happens, for the admin log and for rate limiting.
create table public.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  team_id uuid,
  kind text not null,       -- team_created team_joined team_left team_kicked team_locked unlock flag photo stop_moved
  stop_id text,
  idx int,
  ok boolean,
  lat double precision,
  lng double precision,
  dist_m double precision,  -- distance from the stop when it was attempted
  detail text
);
create index events_at on public.events (at desc);
create index events_user_at on public.events (user_id, at desc);
create index events_team_at on public.events (team_id, at desc);

-- Latest position only (no trail).
create table public.player_locations (
  user_id uuid primary key references auth.users on delete cascade,
  team_id uuid,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  updated_at timestamptz not null default now()
);

create table public.admins (
  email text primary key check (email = lower(email))
);

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.unlocks enable row level security;
alter table public.solves enable row level security;
alter table public.events enable row level security;
alter table public.player_locations enable row level security;
alter table public.admins enable row level security;
-- No policies on any of these: clients reach them only through the functions below.

revoke all on all tables in schema public from anon, authenticated;
grant select on public.stops, public.puzzles to authenticated;
grant select, insert, update on public.profiles to authenticated;

-- ---------- admin check + stop editing ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where email = lower(coalesce(auth.jwt() ->> 'email', '')))
$$;

create policy "admins edit stops" on public.stops for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
grant update (name, place, lat, lng, radius_m) on public.stops to authenticated;

create or replace function public.log_stop_move() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.lat, new.lng, new.radius_m) is distinct from (old.lat, old.lng, old.radius_m) then
    insert into events (user_id, kind, stop_id, lat, lng, detail)
    values (auth.uid(), 'stop_moved', new.id, new.lat, new.lng,
            format('from %s,%s r=%s to %s,%s r=%s', old.lat, old.lng, old.radius_m, new.lat, new.lng, new.radius_m));
  end if;
  return new;
end $$;
create trigger log_stop_move after update on public.stops for each row execute function public.log_stop_move();

-- ---------- helpers ----------
create or replace function public.display_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(btrim((select display_name from profiles where id = p_user)), ''),
                  split_part((select email from auth.users where id = p_user), '@', 1))
$$;

create or replace function public.current_team(p_user uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select team_id from team_members where user_id = p_user
$$;

create or replace function public.stop_is_open(p_team uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stops where id = p_stop and ord = 1)
      or exists (select 1 from unlocks where team_id = p_team and stop_id = p_stop)
$$;

create or replace function public.stop_is_clear(p_team uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from solves where team_id = p_team and stop_id = p_stop)
       = (select count(*) from puzzles where stop_id = p_stop)
     and exists (select 1 from puzzles where stop_id = p_stop)
$$;

create or replace function public.recent_wrong_guesses(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from events
  where user_id = p_user and ok = false and kind in ('unlock', 'flag')
    and detail is distinct from 'out_of_range' and at > now() - interval '1 minute'
$$;

-- ---------- team lifecycle (min 2, max 4 players) ----------
create or replace function public.create_team(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_code text;
  v_team uuid;
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if current_team(v_uid) is not null then return jsonb_build_object('ok', false, 'error', 'You are already in a team.'); end if;
  if char_length(v_name) < 2 or char_length(v_name) > 24 then
    return jsonb_build_object('ok', false, 'error', 'Team names are 2 to 24 characters.');
  end if;
  if exists (select 1 from teams where lower(btrim(name)) = lower(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'That team name is taken.');
  end if;
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * char_length(v_alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from teams where code = v_code);
  end loop;
  insert into teams (name, code, leader_id) values (v_name, v_code, v_uid) returning id into v_team;
  insert into team_members (user_id, team_id) values (v_uid, v_team);
  insert into events (user_id, team_id, kind, ok, detail) values (v_uid, v_team, 'team_created', true, v_name);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.join_team(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if current_team(v_uid) is not null then return jsonb_build_object('ok', false, 'error', 'You are already in a team.'); end if;
  select * into v_team from teams where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'No team has that code.'); end if;
  if v_team.locked then return jsonb_build_object('ok', false, 'error', 'That team is already locked in.'); end if;
  if (select count(*) from team_members where team_id = v_team.id) >= 4 then
    return jsonb_build_object('ok', false, 'error', 'That team is full (4 players).');
  end if;
  insert into team_members (user_id, team_id) values (v_uid, v_team.id);
  insert into events (user_id, team_id, kind, ok, detail) values (v_uid, v_team.id, 'team_joined', true, v_team.name);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.leave_team() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_next uuid;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t join team_members m on m.team_id = t.id where m.user_id = v_uid for update of t;
  if not found then return jsonb_build_object('ok', true); end if;
  if v_team.locked then return jsonb_build_object('ok', false, 'error', 'A locked team cannot be left.'); end if;
  delete from team_members where user_id = v_uid;
  insert into events (user_id, team_id, kind, ok, detail) values (v_uid, v_team.id, 'team_left', true, v_team.name);
  select user_id into v_next from team_members where team_id = v_team.id order by joined_at limit 1;
  if v_next is null then
    delete from teams where id = v_team.id;
  elsif v_team.leader_id = v_uid then
    update teams set leader_id = v_next where id = v_team.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.kick_member(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid) for update;
  if not found or v_team.leader_id <> v_uid then return jsonb_build_object('ok', false, 'error', 'Only the team leader can remove players.'); end if;
  if v_team.locked then return jsonb_build_object('ok', false, 'error', 'The team is locked.'); end if;
  if p_user = v_uid then return jsonb_build_object('ok', false, 'error', 'Use leave team instead.'); end if;
  delete from team_members where user_id = p_user and team_id = v_team.id;
  insert into events (user_id, team_id, kind, ok, detail) values (v_uid, v_team.id, 'team_kicked', true, display_name(p_user));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.lock_team() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_count int;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid) for update;
  if not found or v_team.leader_id <> v_uid then return jsonb_build_object('ok', false, 'error', 'Only the team leader can lock the team.'); end if;
  if v_team.locked then return jsonb_build_object('ok', true); end if;
  select count(*) into v_count from team_members where team_id = v_team.id;
  if v_count < 2 then return jsonb_build_object('ok', false, 'error', 'You need at least 2 players to lock in.'); end if;
  update teams set locked = true, locked_at = now() where id = v_team.id;
  insert into events (user_id, team_id, kind, ok, detail) values (v_uid, v_team.id, 'team_locked', true, v_count || ' players');
  return jsonb_build_object('ok', true);
end $$;

-- ---------- player state ----------
create or replace function public.my_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_info jsonb;
begin
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found then
    return jsonb_build_object('team', null, 'unlocked', '[]'::jsonb, 'solved', '[]'::jsonb, 'solvedBy', '{}'::jsonb, 'clues', '{}'::jsonb);
  end if;
  v_info := jsonb_build_object(
    'id', v_team.id, 'name', v_team.name, 'code', v_team.code, 'locked', v_team.locked,
    'leaderId', v_team.leader_id, 'me', v_uid, 'min', 2, 'max', 4,
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', m.user_id, 'name', display_name(m.user_id), 'isLeader', m.user_id = v_team.leader_id,
                  'avatar', coalesce((select avatar from profiles where id = m.user_id), 'male')) order by m.joined_at), '[]'::jsonb)
                from team_members m where m.team_id = v_team.id));
  if not v_team.locked then
    return jsonb_build_object('team', v_info, 'unlocked', '[]'::jsonb, 'solved', '[]'::jsonb, 'solvedBy', '{}'::jsonb, 'clues', '{}'::jsonb);
  end if;
  return jsonb_build_object(
    'team', v_info,
    'unlocked', coalesce((select jsonb_agg(s.id) from stops s where stop_is_open(v_team.id, s.id)), '[]'::jsonb),
    'solved',   coalesce((select jsonb_agg(stop_id || ':' || idx) from solves where team_id = v_team.id), '[]'::jsonb),
    'solvedBy', coalesce((select jsonb_object_agg(stop_id || ':' || idx, user_id) from solves where team_id = v_team.id), '{}'::jsonb),
    'clues',    coalesce((select jsonb_object_agg(s.id, jsonb_build_object('clue', x.next_clue, 'exitFlag', x.exit_flag))
                          from stops s join stop_secrets x on x.stop_id = s.id
                          where stop_is_clear(v_team.id, s.id)), '{}'::jsonb));
end $$;

create or replace function public.update_my_location(p_lat double precision, p_lng double precision, p_accuracy double precision)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then return; end if;
  insert into player_locations (user_id, team_id, lat, lng, accuracy, updated_at)
  values (v_uid, current_team(v_uid), p_lat, p_lng, p_accuracy, now())
  on conflict (user_id) do update
    set team_id = excluded.team_id, lat = excluded.lat, lng = excluded.lng, accuracy = excluded.accuracy, updated_at = now()
    where player_locations.updated_at < now() - interval '3 seconds';
end $$;

-- ---------- gameplay (team scoped, team must be locked) ----------
create or replace function public.unlock_stop(p_stop text, p_flag text, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_stop stops;
  v_prev stops;
  v_dist double precision;
  v_ok boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jsonb_build_object('ok', false, 'error', 'Your team must be locked in before you can play.'); end if;
  select * into v_stop from stops where id = p_stop;
  if not found then return jsonb_build_object('ok', false, 'error', 'Unknown location.'); end if;
  if stop_is_open(v_team.id, p_stop) then return jsonb_build_object('ok', true); end if;
  v_dist := case when p_lat is null or p_lng is null then null else distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) end;
  if v_dist is null or v_dist > v_stop.radius_m then
    insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'unlock', p_stop, false, p_lat, p_lng, v_dist, 'out_of_range');
    return jsonb_build_object('ok', false, 'error', 'You need to be at this location.');
  end if;
  if recent_wrong_guesses(v_uid) >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong attempts. Wait a minute and try again.');
  end if;
  select * into v_prev from stops where ord = v_stop.ord - 1;
  if not stop_is_clear(v_team.id, v_prev.id) then
    return jsonb_build_object('ok', false, 'error', 'Clear ' || v_prev.place || ' first.');
  end if;
  v_ok := norm_flag(p_flag) = norm_flag((select exit_flag from stop_secrets where stop_id = v_prev.id));
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'unlock', p_stop, v_ok, p_lat, p_lng, v_dist, case when v_ok then null else 'wrong password' end);
  if not v_ok then return jsonb_build_object('ok', false, 'error', 'Access denied. The previous stop holds this password.'); end if;
  insert into unlocks (team_id, stop_id, user_id) values (v_team.id, p_stop, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.submit_flag(p_stop text, p_idx int, p_flag text, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_stop stops;
  v_kind text;
  v_dist double precision;
  v_ok boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jsonb_build_object('ok', false, 'error', 'Your team must be locked in before you can play.'); end if;
  select * into v_stop from stops where id = p_stop;
  select kind into v_kind from puzzles where stop_id = p_stop and idx = p_idx;
  if v_stop.id is null or v_kind is null then return jsonb_build_object('ok', false, 'error', 'Unknown puzzle.'); end if;
  if v_kind <> 'flag' then return jsonb_build_object('ok', false, 'error', 'This puzzle needs a photo.'); end if;
  if not stop_is_open(v_team.id, p_stop) then return jsonb_build_object('ok', false, 'error', 'Unlock this location first.'); end if;
  v_dist := case when p_lat is null or p_lng is null then null else distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) end;
  if v_dist is null or v_dist > v_stop.radius_m then
    insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'flag', p_stop, p_idx, false, p_lat, p_lng, v_dist, 'out_of_range');
    return jsonb_build_object('ok', false, 'error', 'You need to be at this location.');
  end if;
  if recent_wrong_guesses(v_uid) >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong attempts. Wait a minute and try again.');
  end if;
  v_ok := norm_flag(p_flag) = norm_flag((select flag from puzzle_secrets where stop_id = p_stop and idx = p_idx));
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'flag', p_stop, p_idx, v_ok, p_lat, p_lng, v_dist, case when v_ok then null else left(btrim(coalesce(p_flag, '')), 60) end);
  if not v_ok then return jsonb_build_object('ok', false, 'error', 'That flag is not quite right. Check the clue and try again.'); end if;
  insert into solves (team_id, stop_id, idx, user_id) values (v_team.id, p_stop, p_idx, v_uid) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Service role only (verify-photo edge function).
create or replace function public.record_photo_solve(p_user uuid, p_stop text, p_idx int, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_team teams;
  v_stop stops;
begin
  select t.* into v_team from teams t where t.id = current_team(p_user);
  if not found or not v_team.locked then return jsonb_build_object('ok', false, 'error', 'Your team must be locked in before you can play.'); end if;
  if not exists (select 1 from puzzles where stop_id = p_stop and idx = p_idx and kind = 'photo') then
    return jsonb_build_object('ok', false, 'error', 'Unknown photo puzzle.');
  end if;
  if not stop_is_open(v_team.id, p_stop) then return jsonb_build_object('ok', false, 'error', 'Unlock this location first.'); end if;
  select * into v_stop from stops where id = p_stop;
  insert into solves (team_id, stop_id, idx, user_id) values (v_team.id, p_stop, p_idx, p_user) on conflict do nothing;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m)
  values (p_user, v_team.id, 'photo', p_stop, p_idx, true, p_lat, p_lng, distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.log_photo_miss(p_user uuid, p_stop text, p_idx int, p_lat double precision, p_lng double precision, p_dist double precision, p_detail text)
returns void language sql security definer set search_path = public as $$
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail)
  values (p_user, current_team(p_user), 'photo', p_stop, p_idx, false, p_lat, p_lng, p_dist, p_detail)
$$;

-- ---------- admin API (every function checks is_admin) ----------
create or replace function public.am_i_admin() returns boolean
language sql stable security definer set search_path = public as $$ select public.is_admin() $$;

create or replace function public.admin_live() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return jsonb_build_object(
    'now', now(),
    'registered', (select count(*) from auth.users),
    'teams', (select count(*) from teams),
    'lockedTeams', (select count(*) from teams where locked),
    'flagsSolved', (select count(*) from solves),
    'players', coalesce((select jsonb_agg(jsonb_build_object(
        'id', l.user_id, 'name', display_name(l.user_id), 'email', u.email,
        'avatar', coalesce(p.avatar, 'male'), 'teamId', l.team_id, 'teamName', t.name,
        'lat', l.lat, 'lng', l.lng, 'accuracy', l.accuracy, 'updatedAt', l.updated_at))
      from player_locations l
      join auth.users u on u.id = l.user_id
      left join profiles p on p.id = l.user_id
      left join teams t on t.id = l.team_id), '[]'::jsonb));
end $$;

create or replace function public.admin_teams() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name, 'code', t.code, 'locked', t.locked, 'lockedAt', t.locked_at,
    'createdAt', t.created_at, 'leaderId', t.leader_id,
    'lastActivity', (select max(at) from events e where e.team_id = t.id),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', m.user_id, 'name', display_name(m.user_id), 'email', u.email, 'isLeader', m.user_id = t.leader_id,
        'joinedAt', m.joined_at,
        'solves', (select count(*) from solves s where s.team_id = t.id and s.user_id = m.user_id),
        'unlocks', (select count(*) from unlocks k where k.team_id = t.id and k.user_id = m.user_id),
        'wrong', (select count(*) from events e where e.team_id = t.id and e.user_id = m.user_id and e.ok = false
                    and e.kind in ('flag', 'unlock') and e.detail is distinct from 'out_of_range'),
        'lastSeen', (select updated_at from player_locations l where l.user_id = m.user_id)
      ) order by m.joined_at), '[]'::jsonb)
      from team_members m join auth.users u on u.id = m.user_id where m.team_id = t.id),
    'solved', (select coalesce(jsonb_agg(jsonb_build_object(
        'stopId', s.stop_id, 'idx', s.idx, 'title', pz.title, 'kind', pz.kind,
        'userId', s.user_id, 'userName', display_name(s.user_id), 'at', s.at) order by s.at), '[]'::jsonb)
      from solves s join puzzles pz on pz.stop_id = s.stop_id and pz.idx = s.idx where s.team_id = t.id),
    'unlocked', (select coalesce(jsonb_agg(jsonb_build_object(
        'stopId', k.stop_id, 'userName', display_name(k.user_id), 'at', k.at) order by k.at), '[]'::jsonb)
      from unlocks k where k.team_id = t.id)
  ) order by t.created_at) from teams t), '[]'::jsonb);
end $$;

create or replace function public.admin_events(p_limit int default 100, p_before bigint default null, p_team uuid default null, p_kind text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.id desc) from (
    select e.id, e.at, e.kind, e.ok, e.team_id as "teamId", t.name as "teamName", e.user_id as "userId",
           case when e.user_id is null then null else display_name(e.user_id) end as "userName",
           e.stop_id as "stopId", s.place as "stopPlace", e.idx, e.lat, e.lng, e.dist_m as "distM", e.detail
    from events e
    left join teams t on t.id = e.team_id
    left join stops s on s.id = e.stop_id
    where (p_before is null or e.id < p_before)
      and (p_team is null or e.team_id = p_team)
      and (p_kind is null or e.kind = p_kind)
    order by e.id desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) r), '[]'::jsonb);
end $$;

-- ---------- function privileges ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;       -- used inside RLS policies
grant execute on function public.am_i_admin() to authenticated;
grant execute on function public.my_progress() to authenticated;
grant execute on function public.create_team(text) to authenticated;
grant execute on function public.join_team(text) to authenticated;
grant execute on function public.leave_team() to authenticated;
grant execute on function public.kick_member(uuid) to authenticated;
grant execute on function public.lock_team() to authenticated;
grant execute on function public.update_my_location(double precision, double precision, double precision) to authenticated;
grant execute on function public.unlock_stop(text, text, double precision, double precision) to authenticated;
grant execute on function public.submit_flag(text, int, text, double precision, double precision) to authenticated;
grant execute on function public.admin_live() to authenticated;
grant execute on function public.admin_teams() to authenticated;
grant execute on function public.admin_events(int, bigint, uuid, text) to authenticated;
grant execute on function public.record_photo_solve(uuid, text, int, double precision, double precision) to service_role;
grant execute on function public.log_photo_miss(uuid, text, int, double precision, double precision, double precision, text) to service_role;

-- To make someone an admin (SQL editor, as project owner):
--   insert into public.admins (email) values ('you@dubai.bits-pilani.ac.in');
