import { CONFIG } from './config.js';
import { DEMO_STOPS } from './data.js';
import { distanceM } from './geo.js';

// Two interchangeable backends behind one interface: Supabase (real) or localStorage (demo).
// Progress shape: { unlocked: [stopId], solved: ['stopId:idx'], clues: { stopId: { clue, exitFlag } } }
export const hasBackend = Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

const DEMO_USER_KEY = 'kq-demo-user';
const DEMO_STATE_KEY = 'kq-demo-state-v2';
const norm = (value) => String(value || '').trim().toUpperCase();
const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };

let sbPromise;
function supabase() {
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
  if (!hasBackend) return readJson(DEMO_USER_KEY, null);
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
  localStorage.setItem(DEMO_USER_KEY, JSON.stringify(user));
  return user;
}
export async function signOut() {
  if (hasBackend) await (await supabase()).auth.signOut();
  localStorage.removeItem(DEMO_USER_KEY);
}

// ---------- profile ----------
export async function loadAvatar() {
  if (!hasBackend) return localStorage.getItem('kq-avatar');
  const sb = await supabase();
  const { data } = await sb.from('profiles').select('avatar').maybeSingle();
  return data?.avatar || localStorage.getItem('kq-avatar');
}
export async function saveAvatar(avatar, user) {
  localStorage.setItem('kq-avatar', avatar);
  if (!hasBackend) return;
  const sb = await supabase();
  await sb.from('profiles').upsert({ id: user.id, display_name: user.name, avatar });
}

// ---------- game ----------
function demoSolvedAll(station, solved) {
  return station.puzzles.every((_, idx) => solved.includes(`${station.id}:${idx}`));
}
function demoProgress() {
  const saved = readJson(DEMO_STATE_KEY, { unlocked: [], solved: [] });
  const clues = {};
  DEMO_STOPS.forEach((s) => { if (demoSolvedAll(s, saved.solved)) clues[s.id] = { clue: s.nextClue, exitFlag: s.exitFlag }; });
  return { unlocked: ['lobby', ...saved.unlocked.filter((id) => id !== 'lobby')], solved: saved.solved, clues };
}
function demoSave(mutate) {
  const saved = readJson(DEMO_STATE_KEY, { unlocked: [], solved: [] });
  mutate(saved);
  localStorage.setItem(DEMO_STATE_KEY, JSON.stringify(saved));
}
export function resetDemo() { localStorage.removeItem(DEMO_STATE_KEY); }

function demoGuard(station, pos) {
  if (!pos) return 'Waiting for your location…';
  if (distanceM(pos, station) > station.radius) return 'You need to be at this location.';
  return null;
}

export async function loadGame() {
  if (!hasBackend) {
    return { stops: DEMO_STOPS.map(({ exitFlag, nextClue, ...s }) => ({ ...s, puzzles: s.puzzles.map(({ flag, ...p }, idx) => ({ ...p, idx })) })), progress: demoProgress() };
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

async function rpc(name, args) {
  const { data, error } = await (await supabase()).rpc(name, args);
  if (error) return { ok: false, error: error.message };
  const progress = (await (await supabase()).rpc('my_progress')).data;
  return { ...data, progress };
}

export async function unlock(stop, flag, pos) {
  if (hasBackend) return rpc('unlock_stop', { p_stop: stop.id, p_flag: flag, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
  const demo = DEMO_STOPS.find((s) => s.id === stop.id);
  const prev = DEMO_STOPS[demo.ord - 2];
  const bad = demoGuard(demo, pos) || (prev && !demoSolvedAll(prev, demoProgress().solved) && `Clear ${prev.place} first.`);
  if (bad) return { ok: false, error: bad };
  if (prev && norm(flag) !== norm(prev.exitFlag)) return { ok: false, error: 'Access denied. The previous stop holds this password.' };
  demoSave((s) => { if (!s.unlocked.includes(stop.id)) s.unlocked.push(stop.id); });
  return { ok: true, progress: demoProgress() };
}

export async function submitFlag(stop, idx, flag, pos) {
  if (hasBackend) return rpc('submit_flag', { p_stop: stop.id, p_idx: idx, p_flag: flag, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
  const demo = DEMO_STOPS.find((s) => s.id === stop.id);
  const bad = demoGuard(demo, pos);
  if (bad) return { ok: false, error: bad };
  if (norm(flag) !== norm(demo.puzzles[idx].flag)) return { ok: false, error: 'That flag is not quite right. Check the clue and try again.' };
  demoSave((s) => { const id = `${stop.id}:${idx}`; if (!s.solved.includes(id)) s.solved.push(id); });
  return { ok: true, progress: demoProgress() };
}

/** Sends the photo and location to the verify-photo edge function. Demo mode only simulates approval. */
export async function verifyPhoto(stop, idx, blob, pos) {
  if (hasBackend) {
    const body = new FormData();
    body.append('photo', blob, 'photo.jpg');
    body.append('stop', stop.id); body.append('idx', String(idx));
    body.append('lat', String(pos?.lat ?? '')); body.append('lng', String(pos?.lng ?? ''));
    const { data, error } = await (await supabase()).functions.invoke('verify-photo', { body });
    if (error) {
      const detail = await error.context?.json?.().catch(() => null);
      return { ok: false, error: detail?.error || 'Photo review is unavailable right now.' };
    }
    const progress = (await (await supabase()).rpc('my_progress')).data;
    return { ...data, progress };
  }
  const demo = DEMO_STOPS.find((s) => s.id === stop.id);
  const bad = demoGuard(demo, pos);
  if (bad) return { ok: false, error: bad };
  demoSave((s) => { const id = `${stop.id}:${idx}`; if (!s.solved.includes(id)) s.solved.push(id); });
  return { ok: true, simulated: true, progress: demoProgress() };
}
