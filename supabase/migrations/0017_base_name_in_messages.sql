-- 0017: player messages named "the vending machine area" as the base; the base is configurable (now "Lobby").

-- They now use the base's own place name. Typing a flag on an image question gets the right message.

-- Generated from the live definitions (pg_get_functiondef); only the message texts change.

CREATE OR REPLACE FUNCTION public.hub_checkin(p_lat double precision, p_lng double precision, p_acc double precision DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_team teams; v_hub text := hub_id(); v_err text;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if v_team.started_at is not null then return jsonb_build_object('ok', true); end if;
  if v_hub is not null and not in_range(v_team.id, v_hub, p_lat, p_lng, p_acc) then return jerr('Go to the base (' || (select place from stops where role = 'hub' order by ord limit 1) || ') to check in.'); end if;
  update teams set started_at = now() where id = v_team.id;
  insert into events (user_id, team_id, kind, stop_id, ok, lat, lng) values (v_uid, v_team.id, 'checkin', v_hub, true, p_lat, p_lng);
  return jsonb_build_object('ok', true);
end $function$;

CREATE OR REPLACE FUNCTION public.hub_submit_flag(p_flag text, p_lat double precision, p_lng double precision, p_acc double precision DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_team teams; v_stop stops; v_err text; v_hub text := hub_id(); v_have int; v_need int;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select t.* into v_team from teams t where t.id = current_team(v_uid);
  if not found or not v_team.locked then return jerr('Your team must be locked in before you can play.'); end if;
  v_err := game_error(); if v_err is not null then return jerr(v_err); end if;
  if not team_started(v_team.id) then return jerr('Check in at the base first.'); end if;
  if v_hub is not null and not in_range(v_team.id, v_hub, p_lat, p_lng, p_acc) then return jerr('Hand in codes at the base (' || (select place from stops where role = 'hub' order by ord limit 1) || ').'); end if;
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
end $function$;

CREATE OR REPLACE FUNCTION public.submit_flag(p_stop text, p_idx integer, p_flag text, p_lat double precision, p_lng double precision, p_acc double precision DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_kind = 'photo' and not photo_cleared(v_team.id, p_stop, p_idx) then return jerr('This one is solved with a photo, not a flag. Take the photo instead.'); end if;
  v_dist := case when p_lat is null or p_lng is null then null else distance_m(p_lat, p_lng, v_stop.lat, v_stop.lng) end;
  if recent_wrong_guesses(v_uid) >= 8 then return jerr('Too many wrong attempts. Wait a minute and try again.'); end if;
  v_ok := norm_flag(p_flag) = norm_flag((select flag from puzzle_secrets where stop_id = p_stop and idx = p_idx));
  insert into events (user_id, team_id, kind, stop_id, idx, ok, lat, lng, dist_m, detail) values (v_uid, v_team.id, 'flag', p_stop, p_idx, v_ok, p_lat, p_lng, v_dist, case when v_ok then null else left(btrim(coalesce(p_flag, '')), 60) end);
  if not v_ok then return jerr('That flag is not quite right. Check the clue and try again.'); end if;
  insert into solves (team_id, stop_id, idx, user_id) values (v_team.id, p_stop, p_idx, v_uid) on conflict do nothing;
  perform check_finish(v_team.id);
  return jsonb_build_object('ok', true);
end $function$;
