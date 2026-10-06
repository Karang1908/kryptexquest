-- 0015: signed-out visitors (the public anon key) may call exactly one function: public_leaderboard (the big-screen board).
-- Everything else checks the signed-in user (or admin) inside, but Supabase grants EXECUTE on new functions to anon by default,
-- and migrations 0009+ did not revoke it. Service-role-only helpers are also closed to signed-in players.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname <> 'public_leaderboard'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;

revoke execute on function public.unlock_photo_gate(uuid, text, double precision, double precision, double precision) from authenticated;
revoke execute on function public.record_photo_clear(uuid, text, int, double precision, double precision) from authenticated;
grant execute on function public.public_leaderboard() to anon, authenticated;
