import { CONFIG } from './config.js';
import { DEMO_STOPS } from './data.js';
import { distanceM } from './geo.js';
import * as demoAdmin from './demo-admin.js';
import { compressImage, blobToDataUrl } from './image.js';

// Two interchangeable backends behind one interface: Supabase (real) or localStorage (demo).
// Progress shape: { team, unlocked: [stopId], solved: ['stopId:idx'], solvedBy: { 'stopId:idx': userId }, clues: { stopId: { clue, exitFlag } } }
export const hasBackend = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

const KEYS = { user: 'kq-demo-user', state: 'kq-demo-state-v3', team: 'kq-demo-team', stops: 'kq-demo-stops', loc: 'kq-demo-loc', content: 'kq-demo-content', subs: 'kq-demo-subs' };
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

// Demo content lives in localStorage once an organiser edits it; until then it is the sample data.
const demoContent = () => readJson(KEYS.content, null) || structuredClone(DEMO_STOPS);
const demoContentSave = (content) => { content.forEach((s, i) => { s.ord = i + 1; }); writeJson(KEYS.content, content); };
function demoStops() {
  const edits = readJson(KEYS.stops, {});
  return demoContent().map((s) => ({ ...s, ...edits[s.id] }));
}
function demoProgress() {
  const saved = readJson(KEYS.state, { unlocked: [], solved: [] });
  const team = readJson(KEYS.team, null);
  const empty = { team, unlocked: [], solved: [], solvedBy: {}, clues: {} };
  if (!team?.locked) return empty;
  const clues = {};
  demoStops().forEach((s) => { if (demoSolvedAll(s, saved.solved)) clues[s.id] = { clue: s.nextClue, exitFlag: s.exitFlag }; });
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
  const prev = demoStops()[demo.ord - 2];
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
  if (norm(flag) !== norm(demo.puzzles[idx]?.flag)) return fresh({ ok: false, error: 'That flag is not quite right. Check the clue and try again.' });
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
    const content = demoContent();
    const stop = content.find((s) => s.id === id);
    if (!stop) return { ok: false, error: 'Unknown location.' };
    Object.assign(stop, Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null)));
    demoContentSave(content);
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

// ---------- admin: content (locations, questions, answers) ----------
export async function adminContent() {
  if (!hasBackend) {
    return demoContent().map((s) => ({ ...s, radius: s.radius, puzzles: s.puzzles.map((p, idx) => ({ idx, title: p.title, prompt: p.prompt, kind: p.kind, flag: p.flag, refs: (p.refs || []).map((r) => ({ id: r.id, path: r.path })) })) }));
  }
  const { data, error } = await (await supabase()).rpc('admin_content');
  if (error) throw error;
  return data;
}
async function adminRpc(name, args) {
  const { data, error } = await (await supabase()).rpc(name, args);
  return error ? { ok: false, error: error.message } : data;
}
export async function adminSaveLocation(stop) {
  if (hasBackend) return adminRpc('admin_save_stop', { p: stop });
  const id = String(stop.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(id)) return { ok: false, error: 'Location id: 2-30 characters, a-z 0-9 - _' };
  if (!stop.place?.trim() || !stop.name?.trim()) return { ok: false, error: 'Place name and quest title are required.' };
  if (!stop.exitFlag?.trim() || !stop.nextClue?.trim()) return { ok: false, error: 'The handoff flag and next clue are required.' };
  const content = demoContent();
  const fields = { id, name: stop.name.trim(), place: stop.place.trim(), label: stop.label || 'NEW STOP', type: stop.type || 'custom', icon: stop.icon || '◆', lat: Number(stop.lat), lng: Number(stop.lng), radius: Number(stop.radius) || 50, description: stop.description || '', exitFlag: stop.exitFlag.trim(), nextClue: stop.nextClue.trim() };
  const at = content.findIndex((s) => s.id === id);
  if (at >= 0) content[at] = { ...content[at], ...fields }; else content.push({ ...fields, puzzles: [] });
  demoContentSave(content);
  return { ok: true, id };
}
export async function adminDeleteLocation(id) {
  if (hasBackend) return adminRpc('admin_delete_stop', { p_id: id });
  demoContentSave(demoContent().filter((s) => s.id !== id));
  return { ok: true };
}
export async function adminReorderLocations(ids) {
  if (hasBackend) return adminRpc('admin_reorder_stops', { p_ids: ids });
  const by = Object.fromEntries(demoContent().map((s) => [s.id, s]));
  demoContentSave(ids.map((id) => by[id]));
  return { ok: true };
}
export async function adminSaveQuestion(q) {
  if (hasBackend) return adminRpc('admin_save_puzzle', { p: q });
  if (!q.title?.trim() || !q.prompt?.trim()) return { ok: false, error: 'Title and question text are required.' };
  if (q.kind === 'flag' && !q.flag?.trim()) return { ok: false, error: 'A flag question needs its answer.' };
  const content = demoContent();
  const stop = content.find((s) => s.id === q.stop);
  if (!stop) return { ok: false, error: 'Unknown location.' };
  const row = { title: q.title.trim(), prompt: q.prompt.trim(), kind: q.kind, flag: q.kind === 'photo' ? null : q.flag.trim() };
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
export async function adminRemoveFiles(paths) {
  if (hasBackend && paths.length) await (await supabase()).storage.from('puzzle-refs').remove(paths);
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
      { id: 's1', at: new Date(Date.now() - 4 * 60000).toISOString(), verdict: 'review', confidence: 0.62, reason: 'Looks like the same alarm but the angle hides the label.', model: 'gemma4:31b (demo)', status: 'pending', path: placeholder('player photo', '#4285F4'), teamName: 'Byte Me', userName: 'Zayd', stopId: 'lobby', stopPlace: 'Main Lobby', idx: 1, puzzleTitle: 'Emergency eyes', refPaths: [placeholder('reference 1', '#34A853'), placeholder('reference 2', '#FBBC05')] },
      { id: 's2', at: new Date(Date.now() - 20 * 60000).toISOString(), verdict: 'match', confidence: 0.93, reason: 'Same red fire alarm next to the stairs.', model: 'gemma4:31b (demo)', status: 'approved', path: placeholder('player photo', '#EA4335'), teamName: 'Night Owls', userName: 'Amira', stopId: 'lobby', stopPlace: 'Main Lobby', idx: 1, puzzleTitle: 'Emergency eyes', refPaths: [placeholder('reference 1', '#34A853')] },
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
