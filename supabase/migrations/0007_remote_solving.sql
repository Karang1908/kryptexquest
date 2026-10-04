-- 0007: once a team has UNLOCKED a location (which needs presence), its questions can be answered from anywhere.
-- Unlocking, discovering and the base still need the team to be there. Photo verification (edge function) follows suit.
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

grant execute on function public.submit_flag(text, int, text, double precision, double precision, double precision) to authenticated;
