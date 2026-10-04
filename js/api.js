import { CONFIG } from './config.js';
import { DEMO_STOPS } from './data.js';
import { distanceM } from './geo.js';
import * as demoAdmin from './demo-admin.js';

// Two interchangeable backends behind one interface: Supabase (real) or localStorage (demo).
// Progress shape: { team, unlocked: [stopId], solved: ['stopId:idx'], solvedBy: { 'stopId:idx': userId }, clues: { stopId: { clue, exitFlag } } }
export const hasBackend = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

const KEYS = { user: 'kq-demo-user', state: 'kq-demo-state-v3', team: 'kq-demo-team', stops: 'kq-demo-stops', loc: 'kq-demo-loc' };
const norm = (value) => String(value || '').trim().toUpperCase();
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));

let sbPromise;
export function supabase() {
  sbPromise ||= import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm').then(({ createClient }) =>
    createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } }));
  return sbPromise;
}

export function emailAllowed(email) {
  return norm(email).endsWith(`@${CONFIG.allowedEmailDomain.toUpperCase()}`);
}

/** Supabase redirects back with ?error_description=… when the signup trigger rejects an account. */
export function authErrorFromUrl() {
  const params = new URLSearchParams(location.search + '&' + location.hash.replace(/^#/, ''));
  const message = params.get('error_description');
  if (!message) return null;
  history.replaceState(null, '', location.pathname);
  return /database error|domain|only @/i.test(message) ? `Use your @${CONFIG.allowedEmailDomain} Google account to play.` : message;
}

// ---------- auth ----------
export async function getUser() {
  if (!hasBackend) return readJson(KEYS.user, null);
  const { data } = await (await supabase()).auth.getSession();
  const user = data.session?.user;
  return user ? { id: user.id, email: user.email, name: user.user_metadata?.full_name || user.email } : null;
}
export async function signInWithGoogle() {
  const { error } = await (await supabase()).auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname, queryParams: { hd: CONFIG.allowedEmailDomain, prompt: 'select_account' } },
  });
  if (error) throw error;
}
export function signInDemo() {
  const user = { id: 'demo', email: `explorer@${CONFIG.allowedEmailDomain}`, name: 'Demo Explorer' };
  writeJson(KEYS.user, user);
  return user;
}
export async function signOut() {
  if (hasBackend) await (await supabase()).auth.signOut();
  localStorage.removeItem(KEYS.user);
}

// ---------- profile ----------
export async function loadAvatar() {
  if (!hasBackend) return localStorage.getItem('kq-avatar');
  const { data } = await (await supabase()).from('profiles').select('avatar').maybeSingle();
  return data?.avatar || localStorage.getItem('kq-avatar');
}
/** Also how the player gets a visible name: teammates and admins see display_name. */
export async function saveProfile(user, avatar) {
  if (avatar) localStorage.setItem('kq-avatar', avatar);
  if (!hasBackend) return;
  const row = { id: user.id, display_name: user.name };
  if (avatar) row.avatar = avatar;
  await (await supabase()).from('profiles').upsert(row);
}

// ---------- demo backend ----------
const demoSolvedAll = (station, solved) => station.puzzles.every((_, idx) => solved.includes(`${station.id}:${idx}`));

function demoStops() {
  const edits = readJson(KEYS.stops, {});
  return DEMO_STOPS.map((s) => ({ ...s, ...edits[s.id] }));
}
function demoProgress() {
  const saved = readJson(KEYS.state, { unlocked: [], solved: [] });
  const team = readJson(KEYS.team, null);
  const empty = { team, unlocked: [], solved: [], solvedBy: {}, clues: {} };
  if (!team?.locked) return empty;
  const clues = {};
  DEMO_STOPS.forEach((s) => { if (demoSolvedAll(s, saved.solved)) clues[s.id] = { clue: s.nextClue, exitFlag: s.exitFlag }; });
  return {
    team, clues, solved: saved.solved,
    unlocked: ['lobby', ...saved.unlocked.filter((id) => id !== 'lobby')],
    solvedBy: Object.fromEntries(saved.solved.map((id) => [id, 'demo'])),
  };
}
function demoSave(mutate) {
  const saved = readJson(KEYS.state, { unlocked: [], solved: [] });
  mutate(saved);
  writeJson(KEYS.state, saved);
}
function demoGuard(station, pos) {
  if (!demoProgress().team?.locked) return 'Your team must be locked in before you can play.';
  if (!pos) return 'Waiting for your location…';
  if (distanceM(pos, station) > station.radius) return 'You need to be at this location.';
  return null;
}
const fresh = (result) => ({ ...result, progress: demoProgress() });
export function resetDemo() { Object.values(KEYS).forEach((key) => key !== KEYS.user && localStorage.removeItem(key)); }

// ---------- game ----------
export async function loadGame() {
  if (!hasBackend) {
    return { stops: demoStops().map(({ exitFlag, nextClue, ...s }) => ({ ...s, puzzles: s.puzzles.map(({ flag, ...p }, idx) => ({ ...p, idx })) })), progress: demoProgress() };
  }
  const sb = await supabase();
  const [stops, puzzles, progress] = await Promise.all([
    sb.from('stops').select('*').order('ord'),
    sb.from('puzzles').select('*').order('idx'),
    sb.rpc('my_progress'),
  ]);
  const failed = stops.error || puzzles.error || progress.error;
  if (failed) throw failed;
  return {
    stops: stops.data.map((s) => ({ ...s, radius: s.radius_m, puzzles: puzzles.data.filter((p) => p.stop_id === s.id) })),
    progress: progress.data,
  };
}

export async function loadProgress() {
  if (!hasBackend) return demoProgress();
  const { data, error } = await (await supabase()).rpc('my_progress');
  if (error) throw error;
  return data;
}

async function rpc(name, args = {}) {
  const sb = await supabase();
  const { data, error } = await sb.rpc(name, args);
  if (error) return { ok: false, error: error.message };
  const progress = (await sb.rpc('my_progress')).data;
  return { ...(data || { ok: true }), progress };
}

export async function unlock(stop, flag, pos) {
  if (hasBackend) return rpc('unlock_stop', { p_stop: stop.id, p_flag: flag, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
  const demo = demoStops().find((s) => s.id === stop.id);
  const prev = DEMO_STOPS[demo.ord - 2];
  const solved = readJson(KEYS.state, { solved: [] }).solved;
  const bad = demoGuard(demo, pos) || (prev && !demoSolvedAll(prev, solved) && `Clear ${prev.place} first.`);
  if (bad) return fresh({ ok: false, error: bad });
  if (prev && norm(flag) !== norm(prev.exitFlag)) return fresh({ ok: false, error: 'Access denied. The previous stop holds this password.' });
  demoSave((s) => { if (!s.unlocked.includes(stop.id)) s.unlocked.push(stop.id); });
  return fresh({ ok: true });
}

export async function submitFlag(stop, idx, flag, pos) {
  if (hasBackend) return rpc('submit_flag', { p_stop: stop.id, p_idx: idx, p_flag: flag, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
  const demo = demoStops().find((s) => s.id === stop.id);
  const bad = demoGuard(demo, pos);
  if (bad) return fresh({ ok: false, error: bad });
  if (norm(flag) !== norm(demo.puzzles[idx].flag)) return fresh({ ok: false, error: 'That flag is not quite right. Check the clue and try again.' });
  demoSave((s) => { const id = `${stop.id}:${idx}`; if (!s.solved.includes(id)) s.solved.push(id); });
  return fresh({ ok: true });
}

/** Sends the photo and location to the verify-photo edge function. Demo mode only simulates approval. */
export async function verifyPhoto(stop, idx, blob, pos) {
  if (hasBackend) {
    const body = new FormData();
    body.append('photo', blob, 'photo.jpg');
    body.append('stop', stop.id); body.append('idx', String(idx));
    body.append('lat', String(pos?.lat ?? '')); body.append('lng', String(pos?.lng ?? ''));
    const sb = await supabase();
    const { data, error } = await sb.functions.invoke('verify-photo', { body });
    if (error) {
      const detail = await error.context?.json?.().catch(() => null);
      return { ok: false, error: detail?.error || 'Photo review is unavailable right now.' };
    }
    return { ...data, progress: (await sb.rpc('my_progress')).data };
  }
  const demo = demoStops().find((s) => s.id === stop.id);
  const bad = demoGuard(demo, pos);
  if (bad) return fresh({ ok: false, error: bad });
  demoSave((s) => { const id = `${stop.id}:${idx}`; if (!s.solved.includes(id)) s.solved.push(id); });
  return fresh({ ok: true, simulated: true });
}

/** Latest position for the organisers' live map. Fire and forget. */
export async function sendLocation(fix) {
  if (!hasBackend) { writeJson(KEYS.loc, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, at: Date.now() }); return; }
  await (await supabase()).rpc('update_my_location', { p_lat: fix.lat, p_lng: fix.lng, p_accuracy: fix.accuracy ?? null });
}

// ---------- teams ----------
export async function createTeam(name) {
  if (hasBackend) return rpc('create_team', { p_name: name });
  const clean = String(name || '').trim();
  if (readJson(KEYS.team, null)) return fresh({ ok: false, error: 'You are already in a team.' });
  if (clean.length < 2 || clean.length > 24) return fresh({ ok: false, error: 'Team names are 2 to 24 characters.' });
  const user = readJson(KEYS.user, { name: 'Demo Explorer' });
  const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
  writeJson(KEYS.team, { id: 'demo-team', name: clean, code, locked: false, leaderId: 'demo', me: 'demo', min: 2, max: 4, members: [{ id: 'demo', name: user.name, isLeader: true, avatar: localStorage.getItem('kq-avatar') || 'male' }] });
  return fresh({ ok: true });
}
export async function joinTeam(code) {
  if (hasBackend) return rpc('join_team', { p_code: code });
  if (readJson(KEYS.team, null)) return fresh({ ok: false, error: 'You are already in a team.' });
  if (norm(code) !== 'DEMO42') return fresh({ ok: false, error: 'No team has that code. (Demo mode: try DEMO42)' });
  const user = readJson(KEYS.user, { name: 'Demo Explorer' });
  writeJson(KEYS.team, { id: 'demo-team', name: 'Demo Squad', code: 'DEMO42', locked: false, leaderId: 'mate1', me: 'demo', min: 2, max: 4, members: [
    { id: 'mate1', name: 'Priya (demo)', isLeader: true, avatar: 'female' },
    { id: 'demo', name: user.name, isLeader: false, avatar: localStorage.getItem('kq-avatar') || 'male' }] });
  return fresh({ ok: true });
}
export async function leaveTeam() {
  if (hasBackend) return rpc('leave_team');
  const team = readJson(KEYS.team, null);
  if (team?.locked) return fresh({ ok: false, error: 'A locked team cannot be left.' });
  localStorage.removeItem(KEYS.team);
  return fresh({ ok: true });
}
export async function kickMember(userId) {
  if (hasBackend) return rpc('kick_member', { p_user: userId });
  const team = readJson(KEYS.team, null);
  if (team && !team.locked) { team.members = team.members.filter((m) => m.id !== userId); writeJson(KEYS.team, team); }
  return fresh({ ok: true });
}
export async function lockTeam() {
  if (hasBackend) return rpc('lock_team');
  const team = readJson(KEYS.team, null);
  if (!team || team.leaderId !== 'demo') return fresh({ ok: false, error: 'Only the team leader can lock the team.' });
  if (team.members.length < 2) return fresh({ ok: false, error: 'You need at least 2 players to lock in.' });
  team.locked = true; writeJson(KEYS.team, team);
  return fresh({ ok: true });
}
/** Demo only: pretend a friend joined using your code. */
export function demoAddTeammate() {
  const team = readJson(KEYS.team, null);
  if (!team || team.locked || team.members.length >= 4) return fresh({ ok: false, error: 'Cannot add a teammate.' });
  const n = team.members.length;
  team.members.push({ id: `mate${n}`, name: ['Sam', 'Noor', 'Arjun'][n - 1] || `Mate ${n}`, isLeader: false, avatar: n % 2 ? 'female' : 'male' });
  writeJson(KEYS.team, team);
  return fresh({ ok: true });
}

// ---------- admin ----------
export async function adminCheck() {
  if (!hasBackend) return true;
  const { data } = await (await supabase()).rpc('am_i_admin');
  return data === true;
}
export async function adminStops() {
  if (!hasBackend) return demoStops().map(({ exitFlag, nextClue, puzzles, ...s }) => ({ ...s, puzzles: puzzles.map((p, idx) => ({ idx, title: p.title, kind: p.kind })) }));
  const sb = await supabase();
  const [stops, puzzles] = await Promise.all([sb.from('stops').select('*').order('ord'), sb.from('puzzles').select('stop_id,idx,title,kind').order('idx')]);
  if (stops.error || puzzles.error) throw stops.error || puzzles.error;
  return stops.data.map((s) => ({ ...s, radius: s.radius_m, puzzles: puzzles.data.filter((p) => p.stop_id === s.id) }));
}
export async function adminSaveStop(id, patch) {
  if (!hasBackend) {
    const edits = readJson(KEYS.stops, {});
    edits[id] = { ...edits[id], ...patch };
    writeJson(KEYS.stops, edits);
    return { ok: true };
  }
  const row = {};
  if (patch.lat != null) row.lat = patch.lat;
  if (patch.lng != null) row.lng = patch.lng;
  if (patch.radius != null) row.radius_m = Math.round(patch.radius);
  if (patch.place != null) row.place = patch.place;
  if (patch.name != null) row.name = patch.name;
  const { data, error } = await (await supabase()).from('stops').update(row).eq('id', id).select();
  if (error) return { ok: false, error: error.message };
  return data.length ? { ok: true } : { ok: false, error: 'Nothing was saved. Is this account an admin?' };
}
export async function adminLive() {
  if (!hasBackend) return demoAdmin.live(readJson(KEYS.team, null), readJson(KEYS.loc, null), readJson(KEYS.state, { solved: [] }));
  const { data, error } = await (await supabase()).rpc('admin_live');
  if (error) throw error;
  return data;
}
export async function adminTeams() {
  if (!hasBackend) return demoAdmin.teams(readJson(KEYS.team, null), readJson(KEYS.state, { solved: [] }));
  const { data, error } = await (await supabase()).rpc('admin_teams');
  if (error) throw error;
  return data;
}
export async function adminEvents({ limit = 100, before = null, team = null, kind = null } = {}) {
  if (!hasBackend) return demoAdmin.events({ limit, before, team, kind }, readJson(KEYS.team, null), readJson(KEYS.state, { solved: [] }));
  const { data, error } = await (await supabase()).rpc('admin_events', { p_limit: limit, p_before: before, p_team: team, p_kind: kind });
  if (error) throw error;
  return data;
}
