-- Organiser content management (locations, questions, answers) and photo verification storage.
-- Run after 0002.

-- ---------- photo tables ----------
-- Reference photos: ~10 shots of the real object, taken on campus. Files live in the private `puzzle-refs` bucket.
create table public.photo_refs (
  id uuid primary key default gen_random_uuid(),
  stop_id text not null,
  idx int not null,
  path text not null unique,
  created_at timestamptz not null default now(),
  foreign key (stop_id, idx) references public.puzzles on delete cascade
);
create index photo_refs_puzzle on public.photo_refs (stop_id, idx);

-- Every player photo, with the model's verdict. Files live in the private `submissions` bucket.
create table public.photo_submissions (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  user_id uuid not null,
  team_id uuid not null,
  stop_id text not null,
  idx int not null,
  path text not null,
  sha256 text not null,
  verdict text not null check (verdict in ('match', 'review', 'no_match', 'error')),
  confidence real,
  reason text,
  model text,
  status text not null check (status in ('approved', 'pending', 'rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz
);
create index photo_submissions_team on public.photo_submissions (team_id, stop_id, idx, at desc);
create index photo_submissions_hash on public.photo_submissions (sha256);
create index photo_submissions_status on public.photo_submissions (status, at desc);

alter table public.photo_refs enable row level security;
alter table public.photo_submissions enable row level security;
create policy "admins manage photo refs" on public.photo_refs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "admins read submissions" on public.photo_submissions for select to authenticated
  using (public.is_admin());
grant select, insert, delete on public.photo_refs to authenticated;
grant select on public.photo_submissions to authenticated;

-- ---------- storage buckets (private) ----------
insert into storage.buckets (id, name, public) values ('puzzle-refs', 'puzzle-refs', false), ('submissions', 'submissions', false)
on conflict (id) do nothing;
create policy "admins manage puzzle refs" on storage.objects for all to authenticated
  using (bucket_id = 'puzzle-refs' and public.is_admin()) with check (bucket_id = 'puzzle-refs' and public.is_admin());
create policy "admins read submissions" on storage.objects for select to authenticated
  using (bucket_id = 'submissions' and public.is_admin());

-- ---------- players: pending photo reviews ----------
create or replace function public.my_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_team teams;
  v_info jsonb;
begin
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found then
    return jsonb_build_object('team', null, 'unlocked', '[]'::jsonb, 'solved', '[]'::jsonb, 'solvedBy', '{}'::jsonb, 'clues', '{}'::jsonb, 'pending', '[]'::jsonb);
  end if;
  v_info := jsonb_build_object(
    'id', v_team.id, 'name', v_team.name, 'code', v_team.code, 'locked', v_team.locked,
    'leaderId', v_team.leader_id, 'me', v_uid, 'min', 2, 'max', 4,
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', m.user_id, 'name', display_name(m.user_id), 'isLeader', m.user_id = v_team.leader_id,
                  'avatar', coalesce((select avatar from profiles where id = m.user_id), 'male')) order by m.joined_at), '[]'::jsonb)
                from team_members m where m.team_id = v_team.id));
  if not v_team.locked then
    return jsonb_build_object('team', v_info, 'unlocked', '[]'::jsonb, 'solved', '[]'::jsonb, 'solvedBy', '{}'::jsonb, 'clues', '{}'::jsonb, 'pending', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'team', v_info,
    'unlocked', coalesce((select jsonb_agg(s.id) from stops s where stop_is_open(v_team.id, s.id)), '[]'::jsonb),
    'solved',   coalesce((select jsonb_agg(stop_id || ':' || idx) from solves where team_id = v_team.id), '[]'::jsonb),
    'solvedBy', coalesce((select jsonb_object_agg(stop_id || ':' || idx, user_id) from solves where team_id = v_team.id), '{}'::jsonb),
    'pending',  coalesce((select jsonb_agg(distinct stop_id || ':' || idx) from photo_submissions
                          where team_id = v_team.id and status = 'pending'), '[]'::jsonb),
    'clues',    coalesce((select jsonb_object_agg(s.id, jsonb_build_object('clue', x.next_clue, 'exitFlag', x.exit_flag))
                          from stops s join stop_secrets x on x.stop_id = s.id
                          where stop_is_clear(v_team.id, s.id)), '{}'::jsonb));
end $$;

-- ---------- admin: content ----------
create or replace function public.admin_content() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', s.id, 'ord', s.ord, 'name', s.name, 'place', s.place, 'label', s.label, 'type', s.type, 'icon', s.icon,
    'lat', s.lat, 'lng', s.lng, 'radius', s.radius_m, 'description', s.description,
    'exitFlag', x.exit_flag, 'nextClue', x.next_clue,
    'puzzles', (select coalesce(jsonb_agg(jsonb_build_object(
        'idx', p.idx, 'title', p.title, 'prompt', p.prompt, 'kind', p.kind, 'flag', ps.flag,
        'refs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'path', r.path) order by r.created_at), '[]'::jsonb)
                 from photo_refs r where r.stop_id = p.stop_id and r.idx = p.idx)) order by p.idx), '[]'::jsonb)
      from puzzles p left join puzzle_secrets ps on ps.stop_id = p.stop_id and ps.idx = p.idx where p.stop_id = s.id)
  ) order by s.ord) from stops s left join stop_secrets x on x.stop_id = s.id), '[]'::jsonb);
end $$;

create or replace function public.admin_save_stop(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id text := lower(btrim(coalesce(p ->> 'id', '')));
  v_exists boolean;
  v_lat double precision := (p ->> 'lat')::double precision;
  v_lng double precision := (p ->> 'lng')::double precision;
  v_radius int := coalesce((p ->> 'radius')::int, 50);
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if v_id !~ '^[a-z0-9][a-z0-9_-]{1,29}$' then return jsonb_build_object('ok', false, 'error', 'Location id: 2-30 characters, a-z 0-9 - _'); end if;
  if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then return jsonb_build_object('ok', false, 'error', 'Latitude / longitude are not valid.'); end if;
  if v_radius < 5 or v_radius > 500 then return jsonb_build_object('ok', false, 'error', 'Radius must be 5 to 500 m.'); end if;
  if btrim(coalesce(p ->> 'place', '')) = '' or btrim(coalesce(p ->> 'name', '')) = '' then return jsonb_build_object('ok', false, 'error', 'Place name and quest title are required.'); end if;
  if btrim(coalesce(p ->> 'exitFlag', '')) = '' or btrim(coalesce(p ->> 'nextClue', '')) = '' then return jsonb_build_object('ok', false, 'error', 'The handoff flag and next clue are required.'); end if;
  select exists (select 1 from stops where id = v_id) into v_exists;
  if v_exists then
    update stops set name = btrim(p ->> 'name'), place = btrim(p ->> 'place'), label = coalesce(nullif(btrim(p ->> 'label'), ''), label),
      type = coalesce(nullif(btrim(p ->> 'type'), ''), type), icon = coalesce(nullif(btrim(p ->> 'icon'), ''), icon),
      lat = v_lat, lng = v_lng, radius_m = v_radius, description = coalesce(p ->> 'description', '')
    where id = v_id;
  else
    insert into stops (id, ord, name, place, label, type, icon, lat, lng, radius_m, description)
    values (v_id, coalesce((select max(ord) from stops), 0) + 1, btrim(p ->> 'name'), btrim(p ->> 'place'),
            coalesce(nullif(btrim(p ->> 'label'), ''), 'NEW STOP'), coalesce(nullif(btrim(p ->> 'type'), ''), 'custom'),
            coalesce(nullif(btrim(p ->> 'icon'), ''), '◆'), v_lat, v_lng, v_radius, coalesce(p ->> 'description', ''));
  end if;
  insert into stop_secrets (stop_id, exit_flag, next_clue) values (v_id, btrim(p ->> 'exitFlag'), btrim(p ->> 'nextClue'))
  on conflict (stop_id) do update set exit_flag = excluded.exit_flag, next_clue = excluded.next_clue;
  insert into events (user_id, kind, stop_id, ok, detail) values (auth.uid(), 'content', v_id, true, case when v_exists then 'location edited' else 'location created' end);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.admin_delete_stop(p_id text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  delete from stops where id = p_id;
  -- close the gap in the order (two phases: ord is unique)
  update stops set ord = ord + 1000;
  update stops s set ord = r.rn from (select id, row_number() over (order by ord) as rn from stops) r where s.id = r.id;
  insert into events (user_id, kind, stop_id, ok, detail) values (auth.uid(), 'content', p_id, true, 'location deleted');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_reorder_stops(p_ids text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if (select count(*) from stops) <> coalesce(array_length(p_ids, 1), 0)
     or exists (select 1 from unnest(p_ids) i where not exists (select 1 from stops where id = i)) then
    return jsonb_build_object('ok', false, 'error', 'The list does not match the existing locations.');
  end if;
  update stops set ord = ord + 1000;
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
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from stops where id = v_stop) then return jsonb_build_object('ok', false, 'error', 'Unknown location.'); end if;
  if v_kind not in ('flag', 'photo') then return jsonb_build_object('ok', false, 'error', 'Question type must be flag or photo.'); end if;
  if btrim(coalesce(p ->> 'title', '')) = '' or btrim(coalesce(p ->> 'prompt', '')) = '' then return jsonb_build_object('ok', false, 'error', 'Title and question text are required.'); end if;
  if v_kind = 'flag' and v_flag is null then return jsonb_build_object('ok', false, 'error', 'A flag question needs its answer.'); end if;
  if v_kind = 'photo' then v_flag := null; end if;
  if v_idx is null then select coalesce(max(idx), -1) + 1 into v_idx from puzzles where stop_id = v_stop; end if;
  insert into puzzles (stop_id, idx, title, prompt, kind) values (v_stop, v_idx, btrim(p ->> 'title'), btrim(p ->> 'prompt'), v_kind)
  on conflict (stop_id, idx) do update set title = excluded.title, prompt = excluded.prompt, kind = excluded.kind;
  insert into puzzle_secrets (stop_id, idx, flag) values (v_stop, v_idx, v_flag)
  on conflict (stop_id, idx) do update set flag = excluded.flag;
  insert into events (user_id, kind, stop_id, idx, ok, detail) values (auth.uid(), 'content', v_stop, v_idx, true, 'question saved (' || v_kind || ')');
  return jsonb_build_object('ok', true, 'idx', v_idx);
end $$;

-- Returns the storage paths of the reference photos so the browser can delete the files too.
create or replace function public.admin_delete_puzzle(p_stop text, p_idx int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_paths jsonb;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select coalesce(jsonb_agg(path), '[]'::jsonb) into v_paths from photo_refs where stop_id = p_stop and idx = p_idx;
  delete from puzzles where stop_id = p_stop and idx = p_idx;
  insert into events (user_id, kind, stop_id, idx, ok, detail) values (auth.uid(), 'content', p_stop, p_idx, true, 'question deleted');
  return jsonb_build_object('ok', true, 'paths', v_paths);
end $$;

-- ---------- admin: photo review ----------
create or replace function public.admin_photo_submissions(p_status text default null, p_limit int default 60) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.at desc) from (
    select s.id, s.at, s.verdict, s.confidence, s.reason, s.model, s.status, s.path,
           t.name as "teamName", display_name(s.user_id) as "userName",
           s.stop_id as "stopId", st.place as "stopPlace", s.idx, pz.title as "puzzleTitle", pz.prompt as "puzzlePrompt",
           (select coalesce(jsonb_agg(rp.path), '[]'::jsonb) from (select path from photo_refs where stop_id = s.stop_id and idx = s.idx order by created_at limit 3) rp) as "refPaths"
    from photo_submissions s
    left join teams t on t.id = s.team_id
    left join stops st on st.id = s.stop_id
    left join puzzles pz on pz.stop_id = s.stop_id and pz.idx = s.idx
    where p_status is null or s.status = p_status
    order by s.at desc
    limit least(greatest(coalesce(p_limit, 60), 1), 200)
  ) r), '[]'::jsonb);
end $$;

create or replace function public.admin_review_photo(p_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sub photo_submissions;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into v_sub from photo_submissions where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'Unknown submission.'); end if;
  update photo_submissions set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  if p_approve then
    insert into solves (team_id, stop_id, idx, user_id) values (v_sub.team_id, v_sub.stop_id, v_sub.idx, v_sub.user_id) on conflict do nothing;
  end if;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, detail)
  values (auth.uid(), v_sub.team_id, 'photo_review', v_sub.stop_id, v_sub.idx, p_approve, case when p_approve then 'approved by organiser' else 'rejected by organiser' end);
  return jsonb_build_object('ok', true);
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
grant execute on function public.unlock_stop(text, text, double precision, double precision) to authenticated;
grant execute on function public.submit_flag(text, int, text, double precision, double precision) to authenticated;
grant execute on function public.admin_live() to authenticated;
grant execute on function public.admin_teams() to authenticated;
grant execute on function public.admin_events(int, bigint, uuid, text) to authenticated;
grant execute on function public.admin_content() to authenticated;
grant execute on function public.admin_save_stop(jsonb) to authenticated;
grant execute on function public.admin_delete_stop(text) to authenticated;
grant execute on function public.admin_reorder_stops(text[]) to authenticated;
grant execute on function public.admin_save_puzzle(jsonb) to authenticated;
grant execute on function public.admin_delete_puzzle(text, int) to authenticated;
grant execute on function public.admin_photo_submissions(text, int) to authenticated;
grant execute on function public.admin_review_photo(uuid, boolean) to authenticated;
grant execute on function public.record_photo_solve(uuid, text, int, double precision, double precision) to service_role;
grant execute on function public.log_photo_miss(uuid, text, int, double precision, double precision, double precision, text) to service_role;
