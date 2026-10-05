-- 0009: questions live on an external page. The game keeps a title, a link and the answer flag; photo questions reveal the link
-- after the photo is verified. Organisers can also just open a location for a team.
alter table public.puzzle_secrets add column if not exists question_url text;

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
    'hint', x.hint, 'entryQuestion', x.entry_question, 'entryAnswer', x.entry_answer, 'qrToken', x.qr_token,
    'exitFlag', x.exit_flag, 'nextClue', x.next_clue,
    'puzzles', (select coalesce(jsonb_agg(jsonb_build_object(
        'idx', p.idx, 'title', p.title, 'prompt', p.prompt, 'kind', p.kind, 'flag', ps.flag, 'questionUrl', ps.question_url,
        'refs', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'path', r.path) order by r.created_at), '[]'::jsonb)
                 from photo_refs r where r.stop_id = p.stop_id and r.idx = p.idx)) order by p.idx), '[]'::jsonb)
      from puzzles p left join puzzle_secrets ps on ps.stop_id = p.stop_id and ps.idx = p.idx where p.stop_id = s.id)
  ) order by s.ord) from stops s left join stop_secrets x on x.stop_id = s.id), '[]'::jsonb);
end $$;

-- A question is: a title, an optional clue (photo questions), a LINK to the real question page, and the answer flag.
-- Players answer on the external page and type the flag here. Photo questions reveal the link only after the photo is verified.
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
  if v_kind = 'photo' and btrim(coalesce(p ->> 'prompt', '')) = '' then return jerr('A photo question needs a clue describing the object to find.'); end if;
  if v_flag is null then return jerr('Every question needs its answer flag.'); end if;
  if v_url is not null and v_url !~* '^https?://[^[:space:]]+$' then return jerr('The question link must start with http:// or https://'); end if;
  if v_idx is null then select coalesce(max(idx), -1) + 1 into v_idx from puzzles where stop_id = v_stop; end if;
  insert into puzzles (stop_id, idx, title, prompt, kind) values (v_stop, v_idx, btrim(p ->> 'title'), btrim(coalesce(p ->> 'prompt', '')), v_kind)
  on conflict (stop_id, idx) do update set title = excluded.title, prompt = excluded.prompt, kind = excluded.kind;
  insert into puzzle_secrets (stop_id, idx, flag, question_url) values (v_stop, v_idx, v_flag, v_url)
  on conflict (stop_id, idx) do update set flag = excluded.flag, question_url = excluded.question_url;
  insert into events (user_id, kind, stop_id, idx, ok, detail) values (auth.uid(), 'content', v_stop, v_idx, true, 'question saved (' || v_kind || ')');
  return jsonb_build_object('ok', true, 'idx', v_idx);
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
    when 'open_stop' then    -- just open a location for the team (unlock it) without solving anything
      if not exists (select 1 from stops where id = v_stop and role in ('stop', 'bonus')) then return jerr('Unknown location.'); end if;
      insert into unlocks (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
      insert into discoveries (team_id, stop_id, user_id) values (v_team, v_stop, auth.uid()) on conflict do nothing;
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

grant execute on function public.my_progress() to authenticated;
grant execute on function public.admin_content() to authenticated;
grant execute on function public.admin_save_puzzle(jsonb) to authenticated;
grant execute on function public.admin_team_action(jsonb) to authenticated;
