-- 0014: two clearly separate question types.
--  * Flag question: a title, a link to the real question page, and the answer flag.
--  * Image question: players photograph a real object; the AI check (or an organiser) decides. No link, no flag.
-- A location's unlock question is one or the other too (entry_kind). Image unlocks keep their reference photos in entry_photo_refs.
alter table public.stop_secrets add column if not exists entry_kind text not null default 'flag' check (entry_kind in ('flag', 'photo'));

create table if not exists public.entry_photo_refs (
  id uuid primary key default gen_random_uuid(),
  stop_id text not null references public.stops (id) on delete cascade,
  path text not null unique,
  created_at timestamptz not null default now()
);
alter table public.entry_photo_refs enable row level security;
drop policy if exists "admins manage entry photo refs" on public.entry_photo_refs;
create policy "admins manage entry photo refs" on public.entry_photo_refs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- The edge function asks this before spending an AI call on an unlock photo: returns an error text, or null when allowed.
create or replace function public.unlock_photo_gate(p_user uuid, p_stop text, p_lat double precision, p_lng double precision, p_acc double precision) returns text
language plpgsql security definer set search_path = public as $$
declare v_team teams; v_err text;
begin
  select t.* into v_team from teams t where t.id = current_team(p_user);
  if not found or not v_team.locked then return 'Your team must be locked in before you can play.'; end if;
  v_err := game_error(); if v_err is not null then return v_err; end if;
  if not team_started(v_team.id) then return 'Check in at the base first.'; end if;
  if not exists (select 1 from stops s join stop_secrets x on x.stop_id = s.id where s.id = p_stop and s.role = 'stop' and x.entry_kind = 'photo') then return 'This location does not unlock with a photo.'; end if;
  if stop_open(v_team.id, p_stop) then return 'Already unlocked.'; end if;
  if not stop_released(v_team.id, p_stop) then return 'Locked. Hand in the previous location''s code at the base first.'; end if;
  if not in_range(v_team.id, p_stop, p_lat, p_lng, p_acc) then return 'You need to be at this location. Indoors? Scan the QR code posted there.'; end if;
  return null;
end $$;
grant execute on function public.unlock_photo_gate(uuid, text, double precision, double precision, double precision) to service_role;

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
      'needsFlag', x.entry_kind = 'flag' and x.entry_answer is not null,
      'entryKind', case when f.r then x.entry_kind end,
      'needsPhoto', x.entry_kind = 'photo',
      'entryPending', exists (select 1 from photo_submissions q where q.team_id = v_team.id and q.stop_id = s.id and q.idx = -1 and q.status = 'pending'),
      -- what a team has not discovered stays hidden: no name, no position
      'name', case when f.d then s.name end, 'place', case when f.d then s.place end, 'label', case when f.d then s.label end,
      'type', case when f.d then s.type end, 'icon', case when f.d then s.icon end,
      'lat', case when f.d then s.lat end, 'lng', case when f.d then s.lng end, 'radius', case when f.d then s.radius_m end,
      'description', case when f.d then s.description end,
      'hint', case when f.r then x.hint end,
      'entryQuestion', case when f.r then x.entry_question end,
      'entryUrl', case when f.r then x.entry_url end,
      'entryImages', case when f.r then x.entry_images end,
      'entryFlag', case when f.r and x.entry_kind = 'flag' and x.entry_question is null then x.entry_answer end,
      'prevOrd', (select p.ord from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1),
      'state', case when stop_is_clear(v_team.id, s.id) then 'cleared' when stop_open(v_team.id, s.id) then 'open' else 'locked' end,
      'puzzleCount', (select count(*) from puzzles where stop_id = s.id),
      'exitFlag', case when stop_is_clear(v_team.id, s.id) then x.exit_flag end,
      'nextClue', case when stop_is_clear(v_team.id, s.id) then x.next_clue end,
      'puzzles', case when stop_open(v_team.id, s.id) then (select coalesce(jsonb_agg(jsonb_build_object(
          'idx', p.idx, 'kind', p.kind, 'locked', question_locked(v_team.id, p.stop_id, p.idx),
          'title', case when question_locked(v_team.id, p.stop_id, p.idx) then null else p.title end,
          'prompt', case when question_locked(v_team.id, p.stop_id, p.idx) then null else p.prompt end,
          'questionUrl', case when not question_locked(v_team.id, p.stop_id, p.idx) and p.kind = 'flag' then ps.question_url end,
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

create or replace function public.admin_content() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', s.id, 'ord', s.ord, 'role', s.role, 'entryMode', s.entry_mode, 'name', s.name, 'place', s.place, 'label', s.label, 'type', s.type, 'icon', s.icon,
    'lat', s.lat, 'lng', s.lng, 'radius', s.radius_m, 'description', s.description,
    'hint', x.hint, 'entryQuestion', x.entry_question, 'entryUrl', x.entry_url, 'entryImages', x.entry_images, 'entryKind', x.entry_kind, 'entryRefs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'path', r.path) order by r.created_at), '[]'::jsonb) from entry_photo_refs r where r.stop_id = s.id), 'entryAnswer', x.entry_answer, 'qrToken', x.qr_token,
    'exitFlag', x.exit_flag, 'nextClue', x.next_clue,
    'puzzles', (select coalesce(jsonb_agg(jsonb_build_object(
        'idx', p.idx, 'title', p.title, 'prompt', p.prompt, 'kind', p.kind, 'flag', ps.flag, 'questionUrl', ps.question_url,
        'refs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'path', r.path) order by r.created_at), '[]'::jsonb)
                 from photo_refs r where r.stop_id = p.stop_id and r.idx = p.idx)) order by p.idx), '[]'::jsonb)
      from puzzles p left join puzzle_secrets ps on ps.stop_id = p.stop_id and ps.idx = p.idx where p.stop_id = s.id)
  ) order by s.ord) from stops s left join stop_secrets x on x.stop_id = s.id), '[]'::jsonb);
end $$;

create or replace function public.admin_save_puzzle(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_stop text := p ->> 'stop';
  v_kind text := p ->> 'kind';
  v_idx int := (p ->> 'idx')::int;
  v_flag text := nullif(btrim(coalesce(p ->> 'flag', '')), '');
  v_url text := nullif(btrim(coalesce(p ->> 'questionUrl', '')), '');
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from stops where id = v_stop and role <> 'hub') then return jerr('Unknown location (the base has no questions).'); end if;
  if v_kind not in ('flag', 'photo') then return jerr('Question type must be flag or photo.'); end if;
  if btrim(coalesce(p ->> 'title', '')) = '' then return jerr('A question needs a title.'); end if;
  if v_kind = 'photo' and btrim(coalesce(p ->> 'prompt', '')) = '' then return jerr('An image question needs a clue describing the object to photograph.'); end if;
  if v_kind = 'flag' and v_flag is null then return jerr('A flag question needs its answer flag.'); end if;
  if v_kind = 'photo' then v_flag := null; v_url := null; end if;   -- image questions are solved by the photo check alone
  if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then return jerr('The question link must start with http:// or https://'); end if;
  if v_idx is null then select coalesce(max(idx), -1) + 1 into v_idx from puzzles where stop_id = v_stop; end if;
  insert into puzzles (stop_id, idx, title, prompt, kind) values (v_stop, v_idx, btrim(p ->> 'title'), btrim(coalesce(p ->> 'prompt', '')), v_kind)
  on conflict (stop_id, idx) do update set title = excluded.title, prompt = excluded.prompt, kind = excluded.kind;
  insert into puzzle_secrets (stop_id, idx, flag, question_url) values (v_stop, v_idx, v_flag, v_url)
  on conflict (stop_id, idx) do update set flag = excluded.flag, question_url = excluded.question_url;
  insert into events (user_id, kind, stop_id, idx, ok, detail) values (auth.uid(), 'content', v_stop, v_idx, true, 'question saved (' || v_kind || ')');
  return jsonb_build_object('ok', true, 'idx', v_idx);
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
  if nullif(btrim(coalesce(p ->> 'entryUrl', '')), '') is not null and btrim(p ->> 'entryUrl') !~* '^https?://[^[:space:]]+$' then return jerr('The unlock question link must start with http:// or https://'); end if;
  if coalesce(nullif(p ->> 'entryKind', ''), 'flag') not in ('flag', 'photo') then return jerr('Unlock type must be flag or photo.'); end if;
  if coalesce(nullif(p ->> 'entryKind', ''), 'flag') = 'photo' and v_role = 'stop' and btrim(coalesce(p ->> 'entryQuestion', '')) = '' then return jerr('An image unlock needs a clue describing what to photograph.'); end if;
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
  insert into stop_secrets (stop_id, exit_flag, next_clue, hint, entry_question, entry_url, entry_answer, entry_kind)
  values (v_id, nullif(btrim(p ->> 'exitFlag'), ''), nullif(btrim(p ->> 'nextClue'), ''), coalesce(btrim(p ->> 'hint'), ''), nullif(btrim(p ->> 'entryQuestion'), ''), nullif(btrim(p ->> 'entryUrl'), ''), case when coalesce(nullif(p ->> 'entryKind', ''), 'flag') = 'photo' then null else nullif(btrim(p ->> 'entryAnswer'), '') end, coalesce(nullif(p ->> 'entryKind', ''), 'flag'))
  on conflict (stop_id) do update set exit_flag = excluded.exit_flag, next_clue = excluded.next_clue, hint = excluded.hint,
    entry_question = excluded.entry_question, entry_url = excluded.entry_url, entry_answer = excluded.entry_answer, entry_kind = excluded.entry_kind;
  insert into events (user_id, kind, stop_id, ok, detail) values (auth.uid(), 'content', v_id, true, case when v_exists then 'location edited' else 'location created' end);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

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
  if (select entry_kind from stop_secrets where stop_id = p_stop) = 'photo' then return jerr('This location unlocks with a photo. Take it at the location.'); end if;
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

-- Photo approved (by the AI check): an image question is solved, an unlock photo (idx -1) unlocks the location.
create or replace function public.record_photo_clear(p_user uuid, p_stop text, p_idx int, p_lat double precision, p_lng double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_team teams; v_stop stops;
begin
  select t.* into v_team from teams t where t.id = current_team(p_user);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  select * into v_stop from stops where id = p_stop;
  if p_idx = -1 then
    if not exists (select 1 from stop_secrets where stop_id = p_stop and entry_kind = 'photo') then return jerr('This location does not unlock with a photo.'); end if;
    insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail)
    values (p_user, v_team.id, 'unlock', p_stop, -1, true, p_lat, p_lng, distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng), 'photo');
    insert into discoveries (team_id, stop_id, user_id) values (v_team.id, p_stop, p_user) on conflict do nothing;
    insert into unlocks (team_id, stop_id, user_id) values (v_team.id, p_stop, p_user) on conflict do nothing;
    return jsonb_build_object('ok', true, 'place', v_stop.place);
  end if;
  if not exists (select 1 from puzzles where stop_id = p_stop and idx = p_idx and kind = 'photo') then return jerr('Unknown image question.'); end if;
  if not stop_open(v_team.id, p_stop) then return jerr('Unlock this location first.'); end if;
  if question_locked(v_team.id, p_stop, p_idx) then return jerr('Solve the earlier questions first.'); end if;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m)
  values (p_user, v_team.id, 'photo', p_stop, p_idx, true, p_lat, p_lng, distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng));
  insert into solves (team_id, stop_id, idx, user_id) values (v_team.id, p_stop, p_idx, p_user) on conflict do nothing;
  perform check_finish(v_team.id);
  return jsonb_build_object('ok', true);
end $$;

-- An organiser approving a pending photo has the same effect as the AI approving it.
create or replace function public.admin_review_photo(p_id uuid, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sub photo_submissions;
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  select * into v_sub from photo_submissions where id = p_id for update;
  if not found then return jerr('Unknown submission.'); end if;
  update photo_submissions set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = auth.uid(), reviewed_at = now() where id = p_id;
  if p_approve then
    if v_sub.idx = -1 then
      insert into discoveries (team_id, stop_id, user_id) values (v_sub.team_id, v_sub.stop_id, v_sub.user_id) on conflict do nothing;
      insert into unlocks (team_id, stop_id, user_id) values (v_sub.team_id, v_sub.stop_id, v_sub.user_id) on conflict do nothing;
    else
      insert into solves (team_id, stop_id, idx, user_id) values (v_sub.team_id, v_sub.stop_id, v_sub.idx, v_sub.user_id) on conflict do nothing;
      perform check_finish(v_sub.team_id);
    end if;
  end if;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, detail)
  values (auth.uid(), v_sub.team_id, 'photo_review', v_sub.stop_id, v_sub.idx, p_approve, case when p_approve then 'approved by organiser' else 'rejected by organiser' end);
  return jsonb_build_object('ok', true);
end $$;

-- The photo review list also shows unlock photos (idx -1) with their reference photos.
create or replace function public.admin_photo_submissions(p_status text default null, p_limit int default 60) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.at desc) from (
    select s.id, s.at, s.verdict, s.confidence, s.reason, s.model, s.status, s.path,
           t.name as "teamName", display_name(s.user_id) as "userName",
           s.stop_id as "stopId", st.place as "stopPlace", s.idx, coalesce(pz.title, case when s.idx = -1 then 'Unlock photo' end) as "puzzleTitle", coalesce(pz.prompt, case when s.idx = -1 then (select x.entry_question from stop_secrets x where x.stop_id = s.stop_id) end) as "puzzlePrompt",
           (select coalesce(jsonb_agg(rp.path), '[]'::jsonb) from (select path from (select path, created_at from photo_refs where stop_id = s.stop_id and idx = s.idx and s.idx >= 0 union all select path, created_at from entry_photo_refs where stop_id = s.stop_id and s.idx = -1) u order by created_at limit 3) rp) as "refPaths"
    from photo_submissions s
    left join teams t on t.id = s.team_id
    left join stops st on st.id = s.stop_id
    left join puzzles pz on pz.stop_id = s.stop_id and pz.idx = s.idx
    where p_status is null or s.status = p_status
    order by s.at desc
    limit least(greatest(coalesce(p_limit, 60), 1), 200)
  ) r), '[]'::jsonb);
end $$;
