// verify-photo: a signed-in player sends { photo, stop, idx, lat, lng }. We check the team has unlocked the stop, then ask
// Gemma (Ollama Cloud) one question: does this photo show the same object as the organisers' reference photos?
// Confident yes -> the photo stage is cleared (the question is then revealed to the team). Unsure (or the model failed) ->
// saved for an organiser to review. No -> rejected.
// Every photo and verdict is stored, so organisers can audit and override.
//
// Secrets: OLLAMA_API_KEYS (required: up to 10 keys, comma or new-line separated; a key that fails is skipped and the next is tried;
// the old single OLLAMA_API_KEY still works). Optional: OLLAMA_MODEL (default gemma4:31b), OLLAMA_URL (default https://ollama.com/api/chat),
// PHOTO_APPROVE_AT (0.8), PHOTO_REVIEW_AT (0.5).
// DASHBOARD VERSION: index.ts + judge.ts + keypool.ts joined into one file for pasting into the Supabase dashboard editor.
// Generated; edit the three source files, not this one.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { encodeBase64 } from 'jsr:@std/encoding@1/base64';

// ---- judge.ts ----
// Pure helpers for photo verification (no I/O, so they can be unit-tested with plain Node).

type Verdict = { same: boolean; confidence: number; reason: string };
type Decision = 'match' | 'review' | 'no_match';

/** confidence = how sure the model is that the player's photo shows the SAME object (0 = surely different, 1 = surely same). */
const THRESHOLDS = { approve: 0.8, review: 0.5 };

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    same_object: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['same_object', 'confidence', 'reason'],
};

function buildPrompt(description: string | null, referenceCount: number): string {
  return [
    `The first ${referenceCount} image(s) are reference photos of ONE specific real object or spot on a university campus, taken from different angles.`,
    'The LAST image is a photo submitted by a player.',
    description ? `The object is described to players as: "${description}".` : '',
    'Question: does the LAST image show the same object, in the same place, as the reference photos?',
    'Rules: the same kind of object elsewhere does not count (a different fire alarm, a different tree). Ignore lighting, angle, distance and people in the frame.',
    'If the last image is a photo of a screen, a printed picture, or does not clearly show the object, answer false.',
    'Reply with JSON only: {"same_object": boolean, "confidence": number between 0 and 1, "reason": short sentence}.',
    'confidence is how sure you are that it IS the same object: 0 means surely different, 1 means surely the same.',
  ].filter(Boolean).join('\n');
}

/** Ollama /api/chat body. Images are base64 without the data: prefix; the player's photo goes last. */
function buildChatBody(model: string, prompt: string, referencesB64: string[], photoB64: string) {
  return {
    model,
    stream: false,
    format: VERDICT_SCHEMA,
    options: { temperature: 0 },
    messages: [{ role: 'user', content: prompt, images: [...referencesB64, photoB64] }],
  };
}

function parseVerdict(text: string): Verdict | null {
  const candidates = [text, text.match(/\{[\s\S]*\}/)?.[0] ?? ''];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(candidate);
      const same = typeof raw.same_object === 'boolean' ? raw.same_object : null;
      const confidence = Number(raw.confidence);
      if (same === null || !Number.isFinite(confidence)) continue;
      return { same, confidence: Math.min(1, Math.max(0, confidence)), reason: String(raw.reason ?? '').slice(0, 300) };
    } catch { /* try the next candidate */ }
  }
  return null;
}

function decide(verdict: Verdict, th = THRESHOLDS): Decision {
  if (verdict.same && verdict.confidence >= th.approve) return 'match';
  // A confident "yes" with a contradicting flag, or an unsure "yes", goes to a human.
  if (verdict.confidence >= th.review) return 'review';
  return 'no_match';
}

/** Up to `max` references, always varied between calls so one bad angle cannot decide every attempt. */
function pickReferences<T>(all: T[], max = 4, random = Math.random): T[] {
  const copy = [...all];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, max);
}

// ---- keypool.ts ----
// A pool of Ollama API keys (up to 10, from different accounts) so one exhausted or revoked key does not stop photo review.
// Pure logic with no Deno APIs, so it can be tested with `node --experimental-strip-types`.

const MAX_KEYS = 10;

/** `OLLAMA_API_KEYS` holds the keys separated by commas, spaces or new lines; the old single `OLLAMA_API_KEY` still works. */
function parseKeys(many: string | undefined, single: string | undefined): string[] {
  const all = [...(many ?? '').split(/[\s,]+/), (single ?? '').trim()].map((k) => k.trim()).filter(Boolean);
  return [...new Set(all)].slice(0, MAX_KEYS);
}

class KeyError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) { super(message); this.status = status; }
}

type Kind = 'dead' | 'limited' | 'transient' | 'fatal';
/** What a failed call says about the key. `fatal` means the request itself is wrong, so another key will not help. */
function classify(status: number | null): Kind {
  if (status === null || status === 408 || status >= 500) return 'transient';   // timeout, network, server trouble
  if (status === 401 || status === 402 || status === 403) return 'dead';        // bad, revoked or unpaid key
  if (status === 429) return 'limited';                                           // quota or rate limit
  return 'fatal';
}
const COOLDOWN_MS: Record<Exclude<Kind, 'fatal'>, number> = { dead: 10 * 60_000, limited: 60_000, transient: 15_000 };

class KeyPool {
  keys: string[];
  coolUntil: number[];
  now: () => number;
  random: () => number;
  constructor(keys: string[], now = () => Date.now(), random = Math.random) {
    this.keys = keys; this.coolUntil = keys.map(() => 0); this.now = now; this.random = random;
  }
  /** Indexes to try, in order: ready keys starting at a random one (spreads the load), then cooling keys, soonest first. */
  order(): number[] {
    const t = this.now();
    const ready = this.keys.map((_, i) => i).filter((i) => this.coolUntil[i] <= t);
    const start = ready.length ? Math.floor(this.random() * ready.length) : 0;
    const rotated = [...ready.slice(start), ...ready.slice(0, start)];
    const cooling = this.keys.map((_, i) => i).filter((i) => this.coolUntil[i] > t).sort((a, b) => this.coolUntil[a] - this.coolUntil[b]);
    return [...rotated, ...cooling];
  }
  mark(index: number, kind: Exclude<Kind, 'fatal'>) { this.coolUntil[index] = this.now() + COOLDOWN_MS[kind]; }
}

class AllKeysFailed extends Error {
  failures: string[];
  constructor(failures: string[]) { super(`All keys failed: ${failures.join('; ')}`); this.failures = failures; }
}

/** Run `call` with keys from the pool until one works, trying at most `maxAttempts` keys. Position (1-based) is for logs only; never log keys. */
async function withKeys<T>(
  pool: KeyPool, maxAttempts: number, call: (key: string, position: number) => Promise<T>,
): Promise<{ value: T; position: number; failures: string[] }> {
  const failures: string[] = [];
  for (const index of pool.order().slice(0, maxAttempts)) {
    try {
      return { value: await call(pool.keys[index], index + 1), position: index + 1, failures };
    } catch (error) {
      const status = error instanceof KeyError ? error.status : null;
      const kind = error instanceof KeyError ? classify(status) : 'fatal';
      if (kind === 'fatal') throw error;
      pool.mark(index, kind);
      failures.push(`key ${index + 1}: ${status ?? 'no response'}`);
    }
  }
  throw new AllKeysFailed(failures);
}

// ---- index.ts ----
// verify-photo: a signed-in player sends { photo, stop, idx, lat, lng }. We check the team has unlocked the stop, then ask
// Gemma (Ollama Cloud) one question: does this photo show the same object as the organisers' reference photos?
// Confident yes -> the photo stage is cleared (the question is then revealed to the team). Unsure (or the model failed) ->
// saved for an organiser to review. No -> rejected.
// Every photo and verdict is stored, so organisers can audit and override.
//
// Secrets: OLLAMA_API_KEYS (required: up to 10 keys, comma or new-line separated; a key that fails is skipped and the next is tried;
// the old single OLLAMA_API_KEY still works). Optional: OLLAMA_MODEL (default gemma4:31b), OLLAMA_URL (default https://ollama.com/api/chat),
// PHOTO_APPROVE_AT (0.8), PHOTO_REVIEW_AT (0.5).

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const rad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function sha256Hex(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ATTEMPT_MS = 20_000;     // per key: a stuck key must not hold the player's photo for long
const MAX_ATTEMPTS = 3;        // keys tried per photo

let pool: KeyPool | null = null;
let poolFor = '';
/** One pool per function instance, so a key that just failed is skipped by the next photos on the same instance. */
function keyPool(): KeyPool {
  const keys = parseKeys(Deno.env.get('OLLAMA_API_KEYS'), Deno.env.get('OLLAMA_API_KEY'));
  const id = keys.join('\n');
  if (!pool || poolFor !== id) { pool = new KeyPool(keys); poolFor = id; }
  return pool;
}

async function askModel(photo: Uint8Array, refs: Uint8Array[], description: string | null) {
  const model = Deno.env.get('OLLAMA_MODEL') ?? 'gemma4:31b';
  const body = JSON.stringify(buildChatBody(model, buildPrompt(description, refs.length), refs.map(encodeBase64), encodeBase64(photo)));
  const { value: verdict, position, failures } = await withKeys(keyPool(), MAX_ATTEMPTS, async (key) => {
    let response: Response;
    try {
      response = await fetch(Deno.env.get('OLLAMA_URL') ?? 'https://ollama.com/api/chat', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(ATTEMPT_MS),
      });
    } catch {
      throw new KeyError('no response', null);           // timeout or network error: try the next key
    }
    if (!response.ok) throw new KeyError(`Ollama ${response.status}: ${(await response.text()).slice(0, 200)}`, response.status);
    const parsed = parseVerdict(String((await response.json())?.message?.content ?? ''));
    if (!parsed) throw new Error('Unparseable model answer');   // the model's answer, not the key: no rotation
    return parsed;
  });
  if (failures.length) console.warn(`photo check: key ${position} answered after ${failures.join(', ')}`);
  return { verdict, model };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  if (!parseKeys(Deno.env.get('OLLAMA_API_KEYS'), Deno.env.get('OLLAMA_API_KEY')).length) return json({ ok: false, error: 'Photo review is not set up yet. Ask an organiser.' }, 501);

  const url = Deno.env.get('SUPABASE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: auth } = await asUser.auth.getUser();
  if (!auth.user) return json({ ok: false, error: 'Sign in first.' }, 401);
  const userId = auth.user.id;

  const form = await req.formData();
  const photo = form.get('photo');
  const stopId = String(form.get('stop') ?? '');
  const idx = Number(form.get('idx'));
  const lat = Number(form.get('lat'));
  const lng = Number(form.get('lng'));
  const acc = Number(form.get('acc')) || 0;
  if (!(photo instanceof File) || !stopId || !Number.isInteger(idx) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return json({ ok: false, error: 'Missing photo or location.' }, 400);
  }
  if (!photo.type.startsWith('image/') || photo.size > 6 * 1024 * 1024) return json({ ok: false, error: 'Send a photo under 6 MB.' }, 400);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: gameError } = await admin.rpc('game_error');
  if (gameError) return json({ ok: false, error: gameError });
  const { data: membership } = await admin.from('team_members').select('team_id, teams(locked)').eq('user_id', userId).maybeSingle();
  // deno-lint-ignore no-explicit-any
  if (!membership || !(membership as any).teams?.locked) return json({ ok: false, error: 'Your team must be locked in before you can play.' });
  const teamId = membership.team_id as string;

  const { data: stop } = await admin.from('stops').select('lat,lng,radius_m,role').eq('id', stopId).maybeSingle();
  const { data: puzzle } = await admin.from('puzzles').select('prompt,kind').eq('stop_id', stopId).eq('idx', idx).maybeSingle();
  if (!stop || !puzzle || puzzle.kind !== 'photo') return json({ ok: false, error: 'Unknown photo puzzle.' }, 400);
  const dist = distanceM(lat, lng, stop.lat, stop.lng);
  const miss = (detail: string) =>
    admin.rpc('log_photo_miss', { p_user: userId, p_stop: stopId, p_idx: idx, p_lat: lat, p_lng: lng, p_dist: dist, p_detail: detail });
  // Once a team has unlocked a location (which needed presence) its questions can be answered from anywhere,
  // so the only gate is that the location is unlocked. record_photo_clear checks that too.
  const { data: unlockedRow } = await admin.from('unlocks').select('stop_id').eq('team_id', teamId).eq('stop_id', stopId).maybeSingle();
  if (!unlockedRow && stop.role !== 'bonus' && stop.role !== 'hub') {
    const { data: openStop } = await admin.from('stops').select('entry_mode').eq('id', stopId).maybeSingle();
    if (openStop?.entry_mode !== 'open') {
      await miss('locked');
      return json({ ok: false, error: 'Unlock this location first.' });
    }
  }

  // Cost and abuse limits.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count: recent } = await admin.from('photo_submissions').select('id', { count: 'exact', head: true })
    .eq('team_id', teamId).eq('stop_id', stopId).eq('idx', idx).gte('at', since);
  if ((recent ?? 0) >= 6) return json({ ok: false, error: 'Too many photo attempts. Wait a few minutes and try again.' }, 429);

  const bytes = new Uint8Array(await photo.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const { data: reused } = await admin.from('photo_submissions').select('id').eq('sha256', hash).neq('team_id', teamId).limit(1);
  if (reused?.length) {
    await miss('photo already used by another team');
    return json({ ok: false, error: 'That exact photo was already submitted. Take your own.' });
  }

  const { data: refRows } = await admin.from('photo_refs').select('path').eq('stop_id', stopId).eq('idx', idx);
  if (!refRows?.length) return json({ ok: false, error: 'This question has no reference photos yet. Tell an organiser.' }, 503);
  const chosen = pickReferences(refRows, 4);
  const refs: Uint8Array[] = [];
  for (const row of chosen) {
    const { data } = await admin.storage.from('puzzle-refs').download(row.path);
    if (data) refs.push(new Uint8Array(await data.arrayBuffer()));
  }
  if (!refs.length) return json({ ok: false, error: 'Reference photos could not be loaded. Tell an organiser.' }, 503);

  let verdictKind: 'match' | 'review' | 'no_match' | 'error';
  let confidence: number | null = null;
  let reason = '';
  let model = Deno.env.get('OLLAMA_MODEL') ?? 'gemma4:31b';
  try {
    const result = await askModel(bytes, refs, puzzle.prompt);
    model = result.model; confidence = result.verdict.confidence; reason = result.verdict.reason;
    verdictKind = decide(result.verdict, {
      approve: Number(Deno.env.get('PHOTO_APPROVE_AT') ?? THRESHOLDS.approve),
      review: Number(Deno.env.get('PHOTO_REVIEW_AT') ?? THRESHOLDS.review),
    });
  } catch (error) {
    console.error(error instanceof AllKeysFailed ? `photo check: every key tried failed (${error.failures.join(', ')})` : error);
    verdictKind = 'error'; reason = String((error as Error).message).slice(0, 300);
  }

  const status = verdictKind === 'match' ? 'approved' : verdictKind === 'no_match' ? 'rejected' : 'pending';
  const path = `${teamId}/${stopId}-${idx}-${crypto.randomUUID()}.jpg`;
  await admin.storage.from('submissions').upload(path, bytes, { contentType: 'image/jpeg' });
  await admin.from('photo_submissions').insert({
    user_id: userId, team_id: teamId, stop_id: stopId, idx, path, sha256: hash,
    verdict: verdictKind, confidence, reason, model, status,
  });

  if (status === 'approved') {
    const { data, error } = await admin.rpc('record_photo_clear', { p_user: userId, p_stop: stopId, p_idx: idx, p_lat: lat, p_lng: lng });
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ...data, status, cleared: true });
  }
  if (status === 'pending') {
    await miss(verdictKind === 'error' ? 'review: model unavailable' : 'review: unsure');
    return json({ ok: true, pending: true, message: 'Not sure yet. An organiser will check your photo shortly.' });
  }
  await miss('photo did not match');
  return json({ ok: false, error: "That doesn't look like the right object. Try another angle." });
});
