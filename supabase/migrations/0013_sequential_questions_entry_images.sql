-- 0013: (1) questions inside a location are answered in order; later ones show only their number and "locked".
-- (2) a location's unlock question can carry images (public bucket: they are meant to be seen by players who reach the base).
alter table public.stop_secrets add column if not exists entry_images text[] not null default '{}';

create or replace function public.question_locked(p_team uuid, p_stop text, p_idx int) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from puzzles p
    where p.stop_id = p_stop and p.idx < p_idx
      and not exists (select 1 from solves v where v.team_id = p_team and v.stop_id = p.stop_id and v.idx = p.idx))
$$;

insert into storage.buckets (id, name, public) values ('question-images', 'question-images', true) on conflict (id) do nothing;
drop policy if exists "admins manage question images" on storage.objects;
create policy "admins manage question images" on storage.objects for all to authenticated
  using (bucket_id = 'question-images' and public.is_admin()) with check (bucket_id = 'question-images' and public.is_admin());

create or replace function public.admin_set_entry_images(p_stop text, p_paths text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  if not exists (select 1 from stops where id = p_stop and role = 'stop') then return jerr('Unknown location.'); end if;
  if coalesce(array_length(p_paths, 1), 0) > 6 then return jerr('Up to 6 images per unlock question.'); end if;
  insert into stop_secrets (stop_id, entry_images) values (p_stop, coalesce(p_paths, '{}'))
  on conflict (stop_id) do update set entry_images = excluded.entry_images;
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.admin_set_entry_images(text, text[]) to authenticated;

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
      'entryImages', case when f.r then x.entry_images end,
      'entryFlag', case when f.r and x.entry_question is null then x.entry_answer end,
      'prevOrd', (select p.ord from stops p where p.role = 'stop' and p.ord < s.ord order by p.ord desc limit 1),
      'state', case when stop_is_clear(v_team.id, s.id) then 'cleared' when stop_open(v_team.id, s.id) then 'open' else 'locked' end,
      'puzzleCount', (select count(*) from puzzles where stop_id = s.id),
      'exitFlag', case when stop_is_clear(v_team.id, s.id) then x.exit_flag end,
      'nextClue', case when stop_is_clear(v_team.id, s.id) then x.next_clue end,
      'puzzles', case when stop_open(v_team.id, s.id) then (select coalesce(jsonb_agg(jsonb_build_object(
          'idx', p.idx, 'kind', p.kind, 'locked', question_locked(v_team.id, p.stop_id, p.idx),
          'title', case when question_locked(v_team.id, p.stop_id, p.idx) then null else p.title end,
          'prompt', case when question_locked(v_team.id, p.stop_id, p.idx) then null else p.prompt end,
          'questionUrl', case when not question_locked(v_team.id, p.stop_id, p.idx) and (p.kind = 'flag' or photo_cleared(v_team.id, p.stop_id, p.idx)) then ps.question_url end,
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
    'hint', x.hint, 'entryQuestion', x.entry_question, 'entryUrl', x.entry_url, 'entryImages', x.entry_images, 'entryAnswer', x.entry_answer, 'qrToken', x.qr_token,
    'exitFlag', x.exit_flag, 'nextClue', x.next_clue,
    'puzzles', (select coalesce(jsonb_agg(jsonb_build_object(
        'idx', p.idx, 'title', p.title, 'prompt', p.prompt, 'kind', p.kind, 'flag', ps.flag, 'questionUrl', ps.question_url,
        'refs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'path', r.path) order by r.created_at), '[]'::jsonb)
                 from photo_refs r where r.stop_id = p.stop_id and r.idx = p.idx)) order by p.idx), '[]'::jsonb)
      from puzzles p left join puzzle_secrets ps on ps.stop_id = p.stop_id and ps.idx = p.idx where p.stop_id = s.id)
  ) order by s.ord) from stops s left join stop_secrets x on x.stop_id = s.id), '[]'::jsonb);
end $$;

create or replace function public.submit_flag(p_stop text, p_idx int, p_flag text, p_lat double precision, p_lng double precision, p_acc double precision default 0) returns jsonb
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
  if question_locked(v_team.id, p_stop, p_idx) then return jerr('Solve the earlier questions first.'); end if;
  if v_kind = 'photo' and not photo_cleared(v_team.id, p_stop, p_idx) then return jerr('Photograph the object first. The question appears after the photo.'); end if;
  v_dist := case when p_lat is null or p_lng is null then null else distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) end;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  v_ok := norm_flag(p_flag) = norm_flag((select flag from puzzle_secrets where stop_id = p_stop and idx = p_idx));
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'flag', p_stop, p_idx, v_ok, p_lat, p_lng, v_dist, case when v_ok then null else left(btrim(coalesce(p_flag, '')), 60) end);
  if not v_ok then return jerr('That flag is not quite right. Check the clue and try again.'); end if;
  insert into solves (team_id, stop_id, idx, user_id) values (v_team.id, p_stop, p_idx, v_uid) on conflict do nothing;
  perform check_finish(v_team.id);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.record_photo_clear(p_user uuid, p_stop text, p_idx int, p_lat double precision, p_lng double precision) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_team teams; v_stop stops;
begin
  select t.* into v_team from teams t where t.id = current_team(p_user);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  if not exists (select 1 from puzzles where stop_id = p_stop and idx = p_idx and kind = 'photo') then return jerr('Unknown photo question.'); end if;
  if not stop_open(v_team.id, p_stop) then return jerr('Unlock this location first.'); end if;
  if question_locked(v_team.id, p_stop, p_idx) then return jerr('Solve the earlier questions first.'); end if;
  select * into v_stop from stops where id = p_stop;
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m)
  values (p_user, v_team.id, 'photo', p_stop, p_idx, true, p_lat, p_lng, distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng));
  return jsonb_build_object('ok', true);
end $$;
