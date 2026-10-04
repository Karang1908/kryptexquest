-- Kryptex Quest schema. Clients can read public stop/puzzle info and their own progress.
-- Flags, handoff flags and clues live in *_secrets tables with RLS on and NO policies, so the
-- only way to touch them is through the security-definer functions below.

create extension if not exists pgcrypto with schema extensions;

-- ---------- only college accounts may exist ----------
create or replace function public.enforce_email_domain() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if lower(coalesce(new.email, '')) not like '%@dubai.bits-pilani.ac.in' then
    raise exception 'Only @dubai.bits-pilani.ac.in accounts can play Kryptex Quest';
  end if;
  return new;
end $$;

drop trigger if exists enforce_email_domain on auth.users;
create trigger enforce_email_domain before insert on auth.users
  for each row execute function public.enforce_email_domain();

-- ---------- content ----------
create table public.stops (
  id text primary key,
  ord int not null unique check (ord >= 1),
  name text not null,
  place text not null,
  label text not null,
  type text not null,
  icon text not null,
  lat double precision not null,
  lng double precision not null,
  radius_m int not null default 50 check (radius_m > 0),
  description text not null
);
create table public.stop_secrets (
  stop_id text primary key references public.stops on delete cascade,
  exit_flag text not null,   -- the handoff flag; also the password of the next stop
  next_clue text not null
);
create table public.puzzles (
  stop_id text not null references public.stops on delete cascade,
  idx int not null check (idx >= 0),
  title text not null,
  prompt text not null,
  kind text not null check (kind in ('flag', 'photo')),
  primary key (stop_id, idx)
);
create table public.puzzle_secrets (
  stop_id text not null,
  idx int not null,
  flag text,                 -- null for photo puzzles (solved by the verify-photo function)
  primary key (stop_id, idx),
  foreign key (stop_id, idx) references public.puzzles on delete cascade
);

-- ---------- players ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  avatar text not null default 'male' check (avatar in ('male', 'female')),
  created_at timestamptz not null default now()
);
create table public.unlocks (
  user_id uuid not null references auth.users on delete cascade,
  stop_id text not null references public.stops on delete cascade,
  at timestamptz not null default now(),
  primary key (user_id, stop_id)
);
create table public.solves (
  user_id uuid not null references auth.users on delete cascade,
  stop_id text not null,
  idx int not null,
  at timestamptz not null default now(),
  primary key (user_id, stop_id, idx),
  foreign key (stop_id, idx) references public.puzzles on delete cascade
);
create table public.attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  stop_id text not null,
  idx int not null,          -- -1 = unlock attempt
  ok boolean not null,
  lat double precision,
  lng double precision,
  at timestamptz not null default now()
);
create index attempts_user_at on public.attempts (user_id, at desc);

-- ---------- row level security ----------
alter table public.stops enable row level security;
alter table public.stop_secrets enable row level security;
alter table public.puzzles enable row level security;
alter table public.puzzle_secrets enable row level security;
alter table public.profiles enable row level security;
alter table public.unlocks enable row level security;
alter table public.solves enable row level security;
alter table public.attempts enable row level security;

create policy "stops are readable" on public.stops for select to authenticated using (true);
create policy "puzzles are readable" on public.puzzles for select to authenticated using (true);
create policy "own profile read" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own profile insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "own unlocks read" on public.unlocks for select to authenticated using (user_id = auth.uid());
create policy "own solves read" on public.solves for select to authenticated using (user_id = auth.uid());
-- no insert/update/delete policies on unlocks/solves/attempts/secrets: only the functions below write them.

-- ---------- helpers ----------
create or replace function public.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;

create or replace function public.norm_flag(t text) returns text
language sql immutable as $$ select upper(btrim(coalesce(t, ''))) $$;

create or replace function public.stop_is_clear(p_user uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from solves where user_id = p_user and stop_id = p_stop)
       = (select count(*) from puzzles where stop_id = p_stop)
     and exists (select 1 from puzzles where stop_id = p_stop)
$$;

create or replace function public.stop_is_open(p_user uuid, p_stop text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stops where id = p_stop and ord = 1)
      or exists (select 1 from unlocks where user_id = p_user and stop_id = p_stop)
$$;

-- ---------- player-facing API ----------
create or replace function public.my_progress() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'unlocked', coalesce((select jsonb_agg(id) from stops s where stop_is_open(auth.uid(), s.id)), '[]'::jsonb),
    'solved',   coalesce((select jsonb_agg(stop_id || ':' || idx) from solves where user_id = auth.uid()), '[]'::jsonb),
    'clues',    coalesce((select jsonb_object_agg(s.id, jsonb_build_object('clue', x.next_clue, 'exitFlag', x.exit_flag))
                          from stops s join stop_secrets x on x.stop_id = s.id
                          where stop_is_clear(auth.uid(), s.id)), '{}'::jsonb))
$$;

create or replace function public.unlock_stop(p_stop text, p_flag text, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_stop stops;
  v_prev stops;
  v_ok boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_stop from stops where id = p_stop;
  if not found then return jsonb_build_object('ok', false, 'error', 'Unknown location.'); end if;
  if stop_is_open(v_uid, p_stop) then return jsonb_build_object('ok', true); end if;
  if p_lat is null or p_lng is null or distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) > v_stop.radius_m then
    return jsonb_build_object('ok', false, 'error', 'You need to be at this location.');
  end if;
  if (select count(*) from attempts where user_id = v_uid and not ok and at > now() - interval '1 minute') >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong attempts. Wait a minute and try again.');
  end if;
  select * into v_prev from stops where ord = v_stop.ord - 1;
  if not stop_is_clear(v_uid, v_prev.id) then
    return jsonb_build_object('ok', false, 'error', 'Clear ' || v_prev.place || ' first.');
  end if;
  v_ok := norm_flag(p_flag) = norm_flag((select exit_flag from stop_secrets where stop_id = v_prev.id));
  insert into attempts (user_id, stop_id, idx, ok, lat, lng) values (v_uid, p_stop, -1, v_ok, p_lat, p_lng);
  if not v_ok then return jsonb_build_object('ok', false, 'error', 'Access denied. The previous stop holds this password.'); end if;
  insert into unlocks (user_id, stop_id) values (v_uid, p_stop) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.submit_flag(p_stop text, p_idx int, p_flag text, p_lat double precision, p_lng double precision)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_stop stops;
  v_kind text;
  v_ok boolean;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select * into v_stop from stops where id = p_stop;
  select kind into v_kind from puzzles where stop_id = p_stop and idx = p_idx;
  if v_stop.id is null or v_kind is null then return jsonb_build_object('ok', false, 'error', 'Unknown puzzle.'); end if;
  if v_kind <> 'flag' then return jsonb_build_object('ok', false, 'error', 'This puzzle needs a photo.'); end if;
  if not stop_is_open(v_uid, p_stop) then return jsonb_build_object('ok', false, 'error', 'Unlock this location first.'); end if;
  if p_lat is null or p_lng is null or distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) > v_stop.radius_m then
    return jsonb_build_object('ok', false, 'error', 'You need to be at this location.');
  end if;
  if (select count(*) from attempts where user_id = v_uid and not ok and at > now() - interval '1 minute') >= 8 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong attempts. Wait a minute and try again.');
  end if;
  v_ok := norm_flag(p_flag) = norm_flag((select flag from puzzle_secrets where stop_id = p_stop and idx = p_idx));
  insert into attempts (user_id, stop_id, idx, ok, lat, lng) values (v_uid, p_stop, p_idx, v_ok, p_lat, p_lng);
  if not v_ok then return jsonb_build_object('ok', false, 'error', 'That flag is not quite right. Check the clue and try again.'); end if;
  insert into solves (user_id, stop_id, idx) values (v_uid, p_stop, p_idx) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- Called only by the verify-photo edge function (service role) after the photo and location pass.
create or replace function public.record_photo_solve(p_user uuid, p_stop text, p_idx int)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from puzzles where stop_id = p_stop and idx = p_idx and kind = 'photo') then
    return jsonb_build_object('ok', false, 'error', 'Unknown photo puzzle.');
  end if;
  if not stop_is_open(p_user, p_stop) then return jsonb_build_object('ok', false, 'error', 'Unlock this location first.'); end if;
  insert into solves (user_id, stop_id, idx) values (p_user, p_stop, p_idx) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- function privileges ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.my_progress() to authenticated;
grant execute on function public.unlock_stop(text, text, double precision, double precision) to authenticated;
grant execute on function public.submit_flag(text, int, text, double precision, double precision) to authenticated;
grant execute on function public.record_photo_solve(uuid, text, int) to service_role;
-- helpers used inside RLS-free security-definer functions need no client grant.

-- ---------- table privileges (defence in depth on top of RLS) ----------
revoke all on all tables in schema public from anon, authenticated;
grant select on public.stops, public.puzzles, public.unlocks, public.solves to authenticated;
grant select, insert, update on public.profiles to authenticated;
