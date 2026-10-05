import { CONFIG } from './config.js';
import { DEMO_STOPS } from './data.js';
import * as demoAdmin from './demo-admin.js';
import * as engine from './demo-engine.js';
import { compressImage, blobToDataUrl } from './image.js';

// Two interchangeable backends behind one interface: Supabase (real) or localStorage (demo, rules in demo-engine.js).
// Everything a player may see arrives as one "view" (see my_progress() in supabase/migrations/0004_game_flow.sql):
//   { team, game, started, hub, stops: [{..., state, puzzles}], announcements }
// Every action resolves to { ok, error?, view } where `view` is the fresh state.
export const hasBackend = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

const KEYS = {
  user: 'kq-demo-user', team: 'kq-demo-team', loc: 'kq-demo-loc', content: 'kq-demo-content-v2', subs: 'kq-demo-subs',
  state: 'kq-demo-state-v4', game: 'kq-demo-game', announce: 'kq-demo-announce', help: 'kq-demo-help',
};
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
const demoContent = () => readJson(KEYS.content, null) || structuredClone(DEMO_STOPS);
const demoContentSave = (content) => writeJson(KEYS.content, content);
const demoState = () => ({ ...engine.emptyState(), ...readJson(KEYS.state, {}) });
const demoGame = () => ({ ...engine.defaultGame(), ...readJson(KEYS.game, {}) });
const demoTeam = () => readJson(KEYS.team, null);

function demoView() {
  const announcements = readJson(KEYS.announce, []).slice(-5).reverse();
  return engine.buildView({ content: demoContent(), state: demoState(), game: demoGame(), announcements, team: demoTeam() });
}
/** Run a rules-engine action against stored state, persist, and return { ...result, view }. */
function demoAct(action, pos, ...args) {
  const state = demoState();
  const result = action({ content: demoContent(), state, game: demoGame(), team: demoTeam(), pos, me: 'demo', now: Date.now() }, ...args);
  if (result.ok) writeJson(KEYS.state, state);
  return { ...result, view: demoView() };
}
const withView = (result) => ({ ...result, view: demoView() });
export function resetDemo() { Object.values(KEYS).forEach((key) => key !== KEYS.user && localStorage.removeItem(key)); }

// ---------- game ----------
export async function loadView() {
  if (!hasBackend) return demoView();
  const { data, error } = await (await supabase()).rpc('my_progress');
  if (error) throw error;
  return data;
}

/** A failure to reach the server at all (as opposed to the server saying no). */
const offlineish = (error) => (typeof navigator !== 'undefined' && navigator.onLine === false) || /failed to fetch|networkerror|network request failed|load failed/i.test(String(error?.message || ''));

async function rpc(name, args = {}) {
  const sb = await supabase();
  const { data, error } = await sb.rpc(name, args);
  if (error) return offlineish(error) ? { ok: false, offline: true, error: 'No connection.' } : { ok: false, error: error.message };
  return { ...(data || { ok: true }), view: (await sb.rpc('my_progress')).data };
}
const where = (pos) => ({ p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_acc: pos?.accuracy ?? 0 });

export const checkIn = async (pos) => (hasBackend ? rpc('hub_checkin', where(pos)) : demoAct(engine.checkIn, pos));
/** Unlock a discovered location by typing its entry flag there. */
export const unlock = async (stop, flag, pos) => (hasBackend ? rpc('unlock_stop', { p_stop: stop.id, p_flag: flag, ...where(pos) }) : demoAct(engine.unlockStop, pos, stop.id, flag));
export const hubFlag = async (flag, pos) => (hasBackend ? rpc('hub_submit_flag', { p_flag: flag, ...where(pos) }) : demoAct(engine.hubFlag, pos, flag));
export const submitFlag = async (stop, idx, flag, pos) => (hasBackend ? rpc('submit_flag', { p_stop: stop.id, p_idx: idx, p_flag: flag, ...where(pos) }) : demoAct(engine.submitFlag, pos, stop.id, idx, flag));
export const scanQr = async (stopId, token) => (hasBackend ? rpc('scan_qr', { p_stop: stopId, p_token: token }) : demoAct(engine.scanQr, null, stopId, token));

/** Sends the photo and location to the verify-photo edge function. Demo mode only simulates approval. */
export async function verifyPhoto(stop, idx, blob, pos) {
  if (hasBackend) {
    const body = new FormData();
    body.append('photo', blob, 'photo.jpg');
    body.append('stop', stop.id); body.append('idx', String(idx));
    body.append('lat', String(pos?.lat ?? '')); body.append('lng', String(pos?.lng ?? '')); body.append('acc', String(pos?.accuracy ?? 0));
    const sb = await supabase();
    const { data, error } = await sb.functions.invoke('verify-photo', { body });
    if (error) {
      const detail = await error.context?.json?.().catch(() => null);
      return { ok: false, error: detail?.error || 'Photo review is unavailable right now.' };
    }
    return { ...data, view: (await sb.rpc('my_progress')).data };
  }
  return demoAct(engine.photoClear, pos, stop.id, idx);
}

/**
 * Sends the latest position (the organisers' live map) and, in the same call, discovers hidden locations: the phone does
 * not know where they are, so the server checks. Resolves { discovered: [{ id, ord }] }.
 */
export async function sendLocation(fix) {
  if (!hasBackend) {
    writeJson(KEYS.loc, { lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, at: Date.now() });
    const state = demoState();
    const discovered = engine.discover({ content: demoContent(), state, game: demoGame(), team: demoTeam(), pos: fix, me: 'demo', now: Date.now() });
    if (discovered.length) writeJson(KEYS.state, state);
    // Demo teammates (invented) wander around you so the teammate dots can be seen.
    const t = Date.now() / 6000;
    const mates = (demoTeam()?.members || []).filter((m) => m.id !== 'demo' && m.id !== demoTeam()?.me).map((m, i) => ({
      id: m.id, name: m.name, avatar: m.avatar, lat: fix.lat + 0.00009 * Math.sin(t + i * 2), lng: fix.lng + 0.00012 * Math.cos(t + i * 2), at: new Date().toISOString(),
    }));
    return { discovered, mates };
  }
  const { data } = await (await supabase()).rpc('update_my_location', { p_lat: fix.lat, p_lng: fix.lng, p_accuracy: fix.accuracy ?? null });
  return data || { discovered: [], mates: [] };
}

/** The team's story after the finish: times per location, rank, fastest solve. Demo builds it from local state. */
export async function teamRecap() {
  if (!hasBackend) return engine.buildRecap({ content: demoContent(), state: demoState(), team: demoTeam() });
  const { data, error } = await (await supabase()).rpc('team_recap');
  return error ? { ok: false, error: error.message } : data;
}

/** Organisers only: play through the game as a one-person test team that never shows on the leaderboard. */
export async function rehearsalAvailable() {
  if (!hasBackend) return false;
  try { return await adminCheck(); } catch { return false; }
}
export async function startRehearsal() {
  if (!hasBackend) return { ok: false, error: 'Demo mode is already a rehearsal.' };
  const result = await adminRpc('admin_start_rehearsal', {});
  return { ...result, view: (await (await supabase()).rpc('my_progress')).data };
}
export async function endRehearsal() {
  if (!hasBackend) return { ok: false, error: 'Demo mode is already a rehearsal.' };
  const result = await adminRpc('admin_end_rehearsal', {});
  return { ...result, view: (await (await supabase()).rpc('my_progress')).data };
}

export async function leaderboard() {
  if (!hasBackend) return demoAdmin.leaderboard(demoTeam(), demoState(), demoContent(), demoGame());
  const { data, error } = await (await supabase()).rpc('leaderboard');
  if (error) throw error;
  return data;
}
/** Anonymous: the big-screen board. Returns { hidden: true } until organisers switch it on. */
export async function publicLeaderboard() {
  if (!hasBackend) {
    if (!demoGame().boardPublic) return { hidden: true };
    return { hidden: false, ...demoAdmin.leaderboard(demoTeam(), demoState(), demoContent(), demoGame()) };
  }
  const { data, error } = await (await supabase()).rpc('public_leaderboard');
  if (error) throw error;
  return data;
}

export async function requestHelp(pos, message) {
  if (hasBackend) return rpc('request_help', { p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null, p_message: message });
  const list = readJson(KEYS.help, []);
  list.push({ id: Date.now(), at: new Date().toISOString(), name: 'Demo Explorer', teamName: demoTeam()?.name ?? null, lat: pos?.lat ?? null, lng: pos?.lng ?? null, message, status: 'open' });
  writeJson(KEYS.help, list);
  return withView({ ok: true });
}

// ---------- teams ----------
export async function createTeam(name) {
  if (hasBackend) return rpc('create_team', { p_name: name });
  const clean = String(name || '').trim();
  if (demoTeam()) return withView({ ok: false, error: 'You are already in a team.' });
  if (clean.length < 2 || clean.length > 24) return withView({ ok: false, error: 'Team names are 2 to 24 characters.' });
  const user = readJson(KEYS.user, { name: 'Demo Explorer' });
  const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
  writeJson(KEYS.team, { id: 'demo-team', name: clean, code, locked: false, leaderId: 'demo', me: 'demo', min: 2, max: 4, members: [{ id: 'demo', name: user.name, isLeader: true, avatar: localStorage.getItem('kq-avatar') || 'male' }] });
  return withView({ ok: true });
}
export async function joinTeam(code) {
  if (hasBackend) return rpc('join_team', { p_code: code });
  if (demoTeam()) return withView({ ok: false, error: 'You are already in a team.' });
  if (norm(code) !== 'DEMO42') return withView({ ok: false, error: 'No team has that code. (Demo mode: try DEMO42)' });
  const user = readJson(KEYS.user, { name: 'Demo Explorer' });
  writeJson(KEYS.team, { id: 'demo-team', name: 'Demo Squad', code: 'DEMO42', locked: false, leaderId: 'mate1', me: 'demo', min: 2, max: 4, members: [
    { id: 'mate1', name: 'Priya (demo)', isLeader: true, avatar: 'female' },
    { id: 'demo', name: user.name, isLeader: false, avatar: localStorage.getItem('kq-avatar') || 'male' }] });
  return withView({ ok: true });
}
export async function leaveTeam() {
  if (hasBackend) return rpc('leave_team');
  if (demoTeam()?.locked) return withView({ ok: false, error: 'A locked team cannot be left.' });
  localStorage.removeItem(KEYS.team);
  return withView({ ok: true });
}
export async function kickMember(userId) {
  if (hasBackend) return rpc('kick_member', { p_user: userId });
  const team = demoTeam();
  if (team && !team.locked) { team.members = team.members.filter((m) => m.id !== userId); writeJson(KEYS.team, team); }
  return withView({ ok: true });
}
export async function lockTeam() {
  if (hasBackend) return rpc('lock_team');
  const team = demoTeam();
  if (!team || team.leaderId !== 'demo') return withView({ ok: false, error: 'Only the team leader can lock the team.' });
  if (team.members.length < 2) return withView({ ok: false, error: 'You need at least 2 players to lock in.' });
  team.locked = true; writeJson(KEYS.team, team);
  return withView({ ok: true });
}
/** Demo only: pretend a friend joined using your code. */
export function demoAddTeammate() {
  const team = demoTeam();
  if (!team || team.locked || team.members.length >= 4) return withView({ ok: false, error: 'Cannot add a teammate.' });
  const n = team.members.length;
  team.members.push({ id: `mate${n}`, name: ['Sam', 'Noor', 'Arjun'][n - 1] || `Mate ${n}`, isLeader: false, avatar: n % 2 ? 'female' : 'male' });
  writeJson(KEYS.team, team);
  return withView({ ok: true });
}

// ---------- admin: access ----------
export async function adminCheck() {
  if (!hasBackend) return true;
  const { data } = await (await supabase()).rpc('am_i_admin');
  return data === true;
}
async function adminRpc(name, args) {
  const { data, error } = await (await supabase()).rpc(name, args);
  return error ? { ok: false, error: error.message } : data;
}

// ---------- admin: content (locations, questions, answers) ----------
export async function adminContent() {
  if (!hasBackend) return demoContent().map((s) => ({ ...s, puzzles: s.puzzles.map((p, idx) => ({ idx, ...p, refs: (p.refs || []).map((r) => ({ id: r.id, path: r.path })) })) }));
  const { data, error } = await (await supabase()).rpc('admin_content');
  if (error) throw error;
  return data;
}
/** Locations for the live map (positions, radius, names). */
export async function adminStops() {
  return (await adminContent()).map(({ exitFlag, nextClue, entryAnswer, qrToken, ...s }) => ({ ...s, puzzles: s.puzzles.map(({ idx, title, kind }) => ({ idx, title, kind })) }));
}
export async function adminSaveStop(id, patch) {
  if (!hasBackend) {
    const content = demoContent();
    const stop = content.find((s) => s.id === id);
    if (!stop) return { ok: false, error: 'Unknown location.' };
    Object.assign(stop, Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null)));
    demoContentSave(content);
    return { ok: true };
  }
  return adminRpc('admin_move_stop', { p_id: id, p: patch });
}
export async function adminSaveLocation(stop) {
  if (hasBackend) return adminRpc('admin_save_stop', { p: stop });
  const id = String(stop.id || '').trim().toLowerCase();
  const role = stop.role || 'stop';
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(id)) return { ok: false, error: 'Location id: 2-30 characters, a-z 0-9 - _' };
  if (!['hub', 'stop', 'bonus'].includes(role) || !['chain', 'open'].includes(stop.entryMode || 'chain')) return { ok: false, error: 'Unknown role or entry mode.' };
  const lat = Number(stop.lat); const lng = Number(stop.lng); const radius = stop.radius === '' || stop.radius == null ? 50 : Number(stop.radius);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, error: 'Latitude / longitude are not valid.' };
  if (!Number.isFinite(radius) || radius < 5 || radius > 500) return { ok: false, error: 'Radius must be 5 to 500 m.' };
  if (!stop.place?.trim() || !stop.name?.trim()) return { ok: false, error: 'Place name and quest title are required.' };
  if (role === 'stop' && (!stop.exitFlag?.trim() || !stop.nextClue?.trim())) return { ok: false, error: 'A location needs its handoff flag and a next clue.' };
  const content = demoContent();
  if (role === 'hub' && content.some((s) => s.role === 'hub' && s.id !== id)) return { ok: false, error: 'There is already a base location.' };
  const at = content.findIndex((s) => s.id === id);
  const fields = {
    id, role, entryMode: stop.entryMode || 'chain', name: stop.name.trim(), place: stop.place.trim(), label: stop.label || 'NEW STOP', type: stop.type || (role === 'hub' ? 'hub' : 'custom'),
    icon: stop.icon || (role === 'hub' ? '⌂' : '◆'), lat, lng, radius, description: stop.description || '',
    hint: stop.hint || '', entryQuestion: stop.entryQuestion?.trim() || null, entryAnswer: stop.entryAnswer?.trim() || null, exitFlag: stop.exitFlag?.trim() || null, nextClue: stop.nextClue?.trim() || null,
  };
  if (at >= 0) content[at] = { ...content[at], ...fields };
  else content.push({ ...fields, ord: role === 'hub' ? 0 : Math.max(0, ...content.map((s) => s.ord)) + 1, qrToken: Math.random().toString(36).slice(2, 10), puzzles: [] });
  content.sort((a, b) => a.ord - b.ord);
  demoContentSave(content);
  return { ok: true, id };
}
export async function adminDeleteLocation(id) {
  if (hasBackend) return adminRpc('admin_delete_stop', { p_id: id });
  const kept = demoContent().filter((s) => s.id !== id);
  kept.filter((s) => s.role !== 'hub').forEach((s, i) => { s.ord = i + 1; });
  demoContentSave(kept);
  return { ok: true };
}
export async function adminReorderLocations(ids) {
  if (hasBackend) return adminRpc('admin_reorder_stops', { p_ids: ids });
  const content = demoContent();
  const by = Object.fromEntries(content.map((s) => [s.id, s]));
  ids.forEach((id, i) => { by[id].ord = i + 1; });
  demoContentSave(content.sort((a, b) => a.ord - b.ord));
  return { ok: true };
}
export async function adminSaveQuestion(q) {
  if (hasBackend) return adminRpc('admin_save_puzzle', { p: q });
  if (!q.title?.trim() || !q.prompt?.trim()) return { ok: false, error: 'Title and clue / question text are required.' };
  if (!q.flag?.trim()) return { ok: false, error: 'Every question needs its answer flag.' };
  if (q.kind === 'photo' && !q.question?.trim()) return { ok: false, error: 'A photo question needs the question that appears after the photo.' };
  const content = demoContent();
  const stop = content.find((s) => s.id === q.stop && s.role !== 'hub');
  if (!stop) return { ok: false, error: 'Unknown location.' };
  const row = { title: q.title.trim(), prompt: q.prompt.trim(), kind: q.kind, flag: q.flag.trim(), question: q.kind === 'photo' ? q.question.trim() : null };
  let idx = q.idx;
  if (idx == null) { stop.puzzles.push({ ...row, refs: [] }); idx = stop.puzzles.length - 1; }
  else stop.puzzles[idx] = { ...stop.puzzles[idx], ...row };
  demoContentSave(content);
  return { ok: true, idx };
}
export async function adminDeleteQuestion(stopId, idx) {
  if (hasBackend) {
    const result = await adminRpc('admin_delete_puzzle', { p_stop: stopId, p_idx: idx });
    if (result.ok && result.paths?.length) await (await supabase()).storage.from('puzzle-refs').remove(result.paths);
    return result;
  }
  const content = demoContent();
  content.find((s) => s.id === stopId)?.puzzles.splice(idx, 1);
  demoContentSave(content);
  return { ok: true };
}
/** Teams that need an organiser: stalled for 10+ minutes, or stuck on one question. */
export async function adminAlerts() {
  if (!hasBackend) return demoAdmin.alerts();
  const { data, error } = await (await supabase()).rpc('admin_alerts');
  if (error) throw error;
  return data;
}

export async function adminQuestionStats() {
  if (!hasBackend) return [];
  const { data } = await (await supabase()).rpc('admin_question_stats');
  return data || [];
}

// ---------- admin: reference photos ----------
/** Reference photos are small on purpose (<= 1024 px): the model is shown several at once. */
export async function adminUploadRefs(stopId, idx, files) {
  const results = [];
  for (const file of files) {
    const blob = await compressImage(file, 1024, 0.8);
    if (!hasBackend) {
      const small = await compressImage(file, 480, 0.7);
      const content = demoContent();
      const puzzle = content.find((s) => s.id === stopId)?.puzzles[idx];
      if (!puzzle) return { ok: false, error: 'Save the question first.' };
      (puzzle.refs ||= []).push({ id: crypto.randomUUID(), path: await blobToDataUrl(small) });
      demoContentSave(content);
      results.push(true);
      continue;
    }
    const sb = await supabase();
    const path = `${stopId}/${idx}/${crypto.randomUUID()}.jpg`;
    const up = await sb.storage.from('puzzle-refs').upload(path, blob, { contentType: 'image/jpeg' });
    if (up.error) return { ok: false, error: up.error.message };
    const row = await sb.from('photo_refs').insert({ stop_id: stopId, idx, path });
    if (row.error) { await sb.storage.from('puzzle-refs').remove([path]); return { ok: false, error: row.error.message }; }
    results.push(true);
  }
  return { ok: true, count: results.length };
}
export async function adminDeleteRef(stopId, idx, ref) {
  if (!hasBackend) {
    const content = demoContent();
    const puzzle = content.find((s) => s.id === stopId)?.puzzles[idx];
    if (puzzle) puzzle.refs = (puzzle.refs || []).filter((r) => r.id !== ref.id);
    demoContentSave(content);
    return { ok: true };
  }
  const sb = await supabase();
  await sb.storage.from('puzzle-refs').remove([ref.path]);
  const { error } = await sb.from('photo_refs').delete().eq('id', ref.id);
  return error ? { ok: false, error: error.message } : { ok: true };
}
export async function adminRemoveFiles(paths, bucket = 'puzzle-refs') {
  if (hasBackend && paths.length) await (await supabase()).storage.from(bucket).remove(paths);
}
/** Short-lived URLs for private files (demo mode stores data: URLs directly). */
export async function signedUrls(bucket, paths) {
  const list = paths.filter(Boolean);
  if (!hasBackend || !list.length) return Object.fromEntries(list.map((p) => [p, p]));
  const { data } = await (await supabase()).storage.from(bucket).createSignedUrls(list, 3600);
  return Object.fromEntries((data || []).map((d) => [d.path, d.signedUrl]));
}

// ---------- admin: photo review ----------
const placeholder = (label, color) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='320' height='240'><rect width='320' height='240' fill='${color}'/><text x='160' y='128' font-size='22' text-anchor='middle' fill='white' font-family='sans-serif'>${label}</text></svg>`)}`;
export async function adminPhotoSubmissions(status = null) {
  if (!hasBackend) {
    const stored = readJson(KEYS.subs, null) || [
      { id: 's1', at: new Date(Date.now() - 4 * 60000).toISOString(), verdict: 'review', confidence: 0.62, reason: 'Looks like the same alarm but the angle hides the label.', model: 'gemma4:31b (demo)', status: 'pending', path: placeholder('player photo', '#4285F4'), teamName: 'Byte Me', userName: 'Zayd', stopId: 'lobby', stopPlace: 'Main Lobby', idx: 0, puzzleTitle: 'Emergency eyes', refPaths: [placeholder('reference 1', '#34A853'), placeholder('reference 2', '#FBBC05')] },
      { id: 's2', at: new Date(Date.now() - 20 * 60000).toISOString(), verdict: 'match', confidence: 0.93, reason: 'Same red fire alarm next to the stairs.', model: 'gemma4:31b (demo)', status: 'approved', path: placeholder('player photo', '#EA4335'), teamName: 'Night Owls', userName: 'Amira', stopId: 'lobby', stopPlace: 'Main Lobby', idx: 0, puzzleTitle: 'Emergency eyes', refPaths: [placeholder('reference 1', '#34A853')] },
    ];
    writeJson(KEYS.subs, stored);
    return stored.filter((x) => !status || x.status === status);
  }
  const { data, error } = await (await supabase()).rpc('admin_photo_submissions', { p_status: status, p_limit: 80 });
  if (error) throw error;
  return data;
}
export async function adminReviewPhoto(id, approve) {
  if (hasBackend) return adminRpc('admin_review_photo', { p_id: id, p_approve: approve });
  const subs = readJson(KEYS.subs, []);
  const sub = subs.find((x) => x.id === id);
  if (sub) sub.status = approve ? 'approved' : 'rejected';
  writeJson(KEYS.subs, subs);
  return { ok: true };
}

// ---------- admin: live view, teams, log ----------
export async function adminLive() {
  if (!hasBackend) return demoAdmin.live(demoTeam(), readJson(KEYS.loc, null), demoState());
  const { data, error } = await (await supabase()).rpc('admin_live');
  if (error) throw error;
  return data;
}
export async function adminTeams() {
  if (!hasBackend) return demoAdmin.teams(demoTeam(), demoState());
  const { data, error } = await (await supabase()).rpc('admin_teams');
  if (error) throw error;
  return data;
}
export async function adminEvents({ limit = 100, before = null, team = null, kind = null } = {}) {
  if (!hasBackend) return demoAdmin.events({ limit, before, team, kind }, demoTeam(), demoState());
  const { data, error } = await (await supabase()).rpc('admin_events', { p_limit: limit, p_before: before, p_team: team, p_kind: kind });
  if (error) throw error;
  return data;
}

// ---------- admin: event control ----------
export async function adminGame() {
  if (!hasBackend) { const g = demoGame(); return { ...g, effective: engine.gameStatus(g), now: new Date().toISOString() }; }
  const { data, error } = await (await supabase()).rpc('admin_game');
  if (error) throw error;
  return data;
}
export async function adminSetGame(patch) {
  if (hasBackend) return adminRpc('admin_set_game', { p: patch });
  writeJson(KEYS.game, { ...demoGame(), ...patch });
  return { ok: true };
}
export async function adminBroadcast(message, teamId = null, level = 'info') {
  if (hasBackend) return adminRpc('admin_broadcast', { p_message: message, p_team: teamId, p_level: level });
  if (!message?.trim()) return { ok: false, error: 'Write a message first.' };
  const list = readJson(KEYS.announce, []);
  list.push({ id: Date.now(), at: new Date().toISOString(), message: message.trim(), level });
  writeJson(KEYS.announce, list);
  return { ok: true };
}
export async function adminHelpRequests() {
  if (!hasBackend) return readJson(KEYS.help, []).slice().reverse();
  const { data, error } = await (await supabase()).rpc('admin_help_requests');
  if (error) throw error;
  return data;
}
export async function adminResolveHelp(id) {
  if (hasBackend) return adminRpc('admin_resolve_help', { p_id: id });
  writeJson(KEYS.help, readJson(KEYS.help, []).map((h) => (h.id === id ? { ...h, status: 'resolved' } : h)));
  return { ok: true };
}
export async function adminLeaderboard() { return leaderboard(); }

/** Actions on a team: see admin_team_action() in the migration. In demo mode they apply to the local team only. */
export async function adminTeamAction(p) {
  if (hasBackend) return adminRpc('admin_team_action', { p });
  const team = demoTeam();
  if (!team || p.team !== team.id) return { ok: true, note: 'Demo: the invented teams are not editable.' };
  const state = demoState();
  const content = demoContent();
  const stop = content.find((s) => s.id === p.stop);
  const key = (idx) => `${p.stop}:${idx}`;
  switch (p.action) {
    case 'unlock_team': team.locked = false; break;
    case 'lock_team': team.locked = true; break;
    case 'rename': team.name = p.name; break;
    case 'remove_member': team.members = team.members.filter((m) => m.id !== p.user); break;
    case 'disband': localStorage.removeItem(KEYS.team); localStorage.removeItem(KEYS.state); return { ok: true };
    case 'reset_progress': writeJson(KEYS.state, engine.emptyState()); return { ok: true };
    case 'check_in': state.startedAt ||= Date.now(); break;
    case 'clear_finish': state.finishedAt = null; break;
    case 'grant_stop': if (stop) { if (!state.unlocked.includes(stop.id)) state.unlocked.push(stop.id); if (!(state.discovered ||= []).includes(stop.id)) state.discovered.push(stop.id); stop.puzzles.forEach((_, i) => { state.solved[key(i)] ||= { by: null, at: Date.now() }; }); } break;
    case 'grant_puzzle': if (stop) { if (!state.unlocked.includes(stop.id)) state.unlocked.push(stop.id); if (!(state.discovered ||= []).includes(stop.id)) state.discovered.push(stop.id); state.solved[key(p.idx)] ||= { by: null, at: Date.now() }; } break;
    case 'revoke_puzzle': delete state.solved[key(p.idx)]; state.finishedAt = null; break;
    case 'grant_hub_flag': if (stop && !state.hubFlags.includes(stop.id)) state.hubFlags.push(stop.id); break;
    case 'move_member': return { ok: true, note: 'Demo: moving players between teams is not simulated.' };
    default: return { ok: false, error: 'Unknown action.' };
  }
  writeJson(KEYS.team, team); writeJson(KEYS.state, state);
  return { ok: true };
}

/** 'locations' | 'photos'. Photo files in storage are removed too. */
export async function adminPurge(what) {
  if (!hasBackend) { if (what === 'locations') localStorage.removeItem(KEYS.loc); return { ok: true }; }
  const result = await adminRpc('admin_purge', { p_what: what });
  if (result.ok && result.paths?.length) await adminRemoveFiles(result.paths, 'submissions');
  return result;
}
