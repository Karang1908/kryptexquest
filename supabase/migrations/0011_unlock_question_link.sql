-- 0011: a location's unlock question can carry a link to the real question page, like every other question.
alter table public.stop_secrets add column if not exists entry_url text;

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
                      from (select * from announcements where at > now() - interval '8 hours' and (team_id is null or team_id = v_team.id) order by id desc limit 5) a));
end $$;

create or replace function public.admin_content() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'forbidden'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id', s.id, 'ord', s.ord, 'role', s.role, 'entryMode', s.entry_mode, 'name', s.name, 'place', s.place, 'label', s.label, 'type', s.type, 'icon', s.icon,
    'lat', s.lat, 'lng', s.lng, 'radius', s.radius_m, 'description', s.description,
    'hint', x.hint, 'entryQuestion', x.entry_question, 'entryUrl', x.entry_url, 'entryAnswer', x.entry_answer, 'qrToken', x.qr_token,
    'exitFlag', x.exit_flag, 'nextClue', x.next_clue,
    'puzzles', (select coalesce(jsonb_agg(jsonb_build_object(
        'idx', p.idx, 'title', p.title, 'prompt', p.prompt, 'kind', p.kind, 'flag', ps.flag, 'questionUrl', ps.question_url,
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
  if v_role not in ('hub', 'stop', 'bonus') or v_mode not in ('chain', 'open') then return jerr('Unknown role or entry mode.'); end if;
  if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then return jerr('Latitude / longitude are not valid.'); end if;
  if nullif(btrim(coalesce(p ->> 'entryUrl', '')), '') is not null and btrim(p ->> 'entryUrl') !~* '^https?://[^[:space:]]+$' then return jerr('The unlock question link must start with http:// or https://'); end if;
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
  insert into stop_secrets (stop_id, exit_flag, next_clue, hint, entry_question, entry_url, entry_answer)
  values (v_id, nullif(btrim(p ->> 'exitFlag'), ''), nullif(btrim(p ->> 'nextClue'), ''), coalesce(btrim(p ->> 'hint'), ''), nullif(btrim(p ->> 'entryQuestion'), ''), nullif(btrim(p ->> 'entryUrl'), ''), nullif(btrim(p ->> 'entryAnswer'), ''))
  on conflict (stop_id) do update set exit_flag = excluded.exit_flag, next_clue = excluded.next_clue, hint = excluded.hint,
    entry_question = excluded.entry_question, entry_url = excluded.entry_url, entry_answer = excluded.entry_answer;
  insert into events (user_id, kind, stop_id, ok, detail) values (auth.uid(), 'content', v_id, true, case when v_exists then 'location edited' else 'location created' end);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
