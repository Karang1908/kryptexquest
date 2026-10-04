// The game rules for LOCAL DEMO mode, mirroring supabase/migrations/0004_game_flow.sql (which is the real thing).
// Pure functions over (content, state, game): no storage here, so they can be unit-tested in Node.
import { distanceM } from './geo.js';

const norm = (value) => String(value || '').trim().toUpperCase();
const PRESENCE_MS = 15 * 60_000;

export const emptyState = () => ({ startedAt: null, finishedAt: null, unlocked: [], discovered: [], at: { discovered: {}, unlocked: {}, handed: {} }, wrong: {}, solved: {}, hubFlags: [], photoCleared: [], pending: [], presence: {} });
const stamp = (ctx, kind, id) => { ((ctx.state.at ||= {})[kind] ||= {})[id] = ctx.now; };
export const defaultGame = () => ({ status: 'running', startsAt: null, endsAt: null, boardPublic: false, hubReveal: 'all', bounds: null, noGo: [] });

const byId = (content, id) => content.find((s) => s.id === id);
const hubOf = (content) => content.find((s) => s.role === 'hub');
const stopsOf = (content) => content.filter((s) => s.role === 'stop').sort((a, b) => a.ord - b.ord);
const prevStop = (content, stop) => stopsOf(content).filter((s) => s.ord < stop.ord).at(-1) ?? null;
const sid = (stopId, idx) => `${stopId}:${idx}`;

export function gameStatus(game, now = Date.now()) {
  if (game.status === 'ended' || (game.status === 'running' && game.endsAt && now >= Date.parse(game.endsAt))) return 'ended';
  if (game.status === 'running' && game.startsAt && now < Date.parse(game.startsAt)) return 'lobby';
  return game.status;
}
export const gameError = (game, now) => ({ lobby: 'The quest has not started yet.', paused: 'The quest is paused. Wait for the organisers.', ended: 'The quest has ended.' }[gameStatus(game, now)] ?? null);

export const stopOpen = (content, state, id) => {
  const s = byId(content, id);
  return Boolean(s) && (s.role === 'hub' || (s.role === 'stop' && s.entryMode === 'open') || state.unlocked.includes(id));
};
export const stopClear = (content, state, id) => {
  const s = byId(content, id);
  return Boolean(s) && s.puzzles.length > 0 && s.puzzles.every((_, i) => state.solved[sid(id, i)]);
};
export const teamStarted = (content, state) => !hubOf(content) || Boolean(state.startedAt);

/** The team knows where this location is: it walked into it (or scanned its QR, or unlocked it). The base always is. */
export const discovered = (content, state, stop) => stop.role === 'hub' || (state.discovered || []).includes(stop.id) || state.unlocked.includes(stop.id);

/** The base has released this location's hint and entry question (previous code handed in; the first: after check-in). */
export function released(content, state, stop) {
  if (stop.role !== 'stop' || !teamStarted(content, state)) return false;
  if (stop.entryMode === 'open') return true;
  const prev = prevStop(content, stop);
  return !prev || state.hubFlags.includes(prev.id);
}

export function inRange(content, state, stopId, pos, now = Date.now()) {
  const s = byId(content, stopId);
  if (!s) return false;
  if (s.role === 'bonus') return true;   // the bonus question needs no location
  const near = Boolean(pos) && distanceM(pos, s) <= s.radius + Math.min(Math.max(pos.accuracy || 0, 0), 25);
  return near || now - (state.presence[stopId] || 0) < PRESENCE_MS;
}

// Finished = every location's code handed in. The bonus question is an extra and does not stop the clock.
function checkFinish(content, state, now) {
  const needed = stopsOf(content).length;
  if (needed > 0 && state.hubFlags.length >= needed && !state.finishedAt) state.finishedAt = now;
}

/** The same JSON shape the database's my_progress() returns. */
export function buildView({ content, state, game, announcements = [], team, now = Date.now() }) {
  if (!team?.locked) return { team: team ?? null, game: { status: gameStatus(game, now), now: new Date(now).toISOString() }, stops: [], announcements: [] };
  const started = teamStarted(content, state);
  const hub = hubOf(content);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  team = { ...team, startedAt: iso(state.startedAt), finishedAt: iso(state.finishedAt) };
  const stops = content.filter((s) => s.role === 'hub' || s.role === 'stop' || stopOpen(content, state, s.id)).sort((a, b) => a.ord - b.ord).map((s) => {
    const cleared = stopClear(content, state, s.id);
    const open = stopOpen(content, state, s.id);
    const d = discovered(content, state, s);
    const r = released(content, state, s);
    const hide = (value) => (d ? value : null);   // what a team has not discovered stays hidden: no name, no position
    return {
      id: s.id, ord: s.ord, role: s.role, entryMode: s.entryMode, discovered: d, released: r, needsFlag: Boolean(s.entryAnswer),
      name: hide(s.name), place: hide(s.place), label: hide(s.label), type: hide(s.type), icon: hide(s.icon), lat: hide(s.lat), lng: hide(s.lng), radius: hide(s.radius),
      description: hide(s.description),
      hint: r ? s.hint || '' : null, entryQuestion: r ? s.entryQuestion || null : null, entryFlag: r && !s.entryQuestion ? s.entryAnswer || null : null,
      prevOrd: prevStop(content, s)?.ord ?? null,
      state: cleared ? 'cleared' : open ? 'open' : 'locked', puzzleCount: s.puzzles.length,
      exitFlag: cleared ? s.exitFlag : null, nextClue: cleared ? s.nextClue : null,
      puzzles: open ? s.puzzles.map((p, idx) => {
        const photoCleared = p.kind === 'photo' && state.photoCleared.includes(sid(s.id, idx));
        const solved = state.solved[sid(s.id, idx)];
        return {
          idx, title: p.title, kind: p.kind, prompt: p.prompt, question: photoCleared ? p.question : null, photoCleared,
          pending: state.pending.includes(sid(s.id, idx)), solved: Boolean(solved), solvedBy: solved?.by ?? null,
        };
      }) : [],
    };
  });
  return {
    team, started, game: { status: gameStatus(game, now), startsAt: game.startsAt, endsAt: game.endsAt, now: new Date(now).toISOString(), hubReveal: game.hubReveal, bounds: game.bounds, noGo: game.noGo, boardPublic: game.boardPublic },
    hub: { id: hub?.id ?? null, entered: state.hubFlags, needed: stopsOf(content).length },
    stops, announcements,
  };
}

// ----- actions: each returns { ok, error? } and mutates `state` -----
function guard(ctx, { needStarted = true } = {}) {
  if (!ctx.team?.locked) return 'Your team must be locked in before you can play.';
  const err = gameError(ctx.game, ctx.now); if (err) return err;
  if (needStarted && !teamStarted(ctx.content, ctx.state)) return 'Check in at the base first.';
  return null;
}
const fail = (error) => ({ ok: false, error });

export function checkIn(ctx) {
  const err = guard(ctx, { needStarted: false }); if (err) return fail(err);
  if (ctx.state.startedAt) return { ok: true };
  const hub = hubOf(ctx.content);
  if (hub && !inRange(ctx.content, ctx.state, hub.id, ctx.pos, ctx.now)) return fail('Go to the base (the vending machine area) to check in.');
  ctx.state.startedAt = ctx.now;
  return { ok: true };
}

/** Walking into a hidden location discovers it. Called with every location ping. Returns the newly discovered ones. */
export function discover(ctx) {
  if (!ctx.team?.locked || gameError(ctx.game, ctx.now) || !teamStarted(ctx.content, ctx.state) || !ctx.pos) return [];
  ctx.state.discovered ||= [];
  const found = [];
  ctx.content.filter((s) => s.role === 'stop' && !discovered(ctx.content, ctx.state, s) && inRange(ctx.content, ctx.state, s.id, ctx.pos, ctx.now)).forEach((s) => {
    ctx.state.discovered.push(s.id);
    stamp(ctx, 'discovered', s.id);
    found.push({ id: s.id, ord: s.ord });
  });
  return found;
}

/** Unlock a discovered location by typing its entry flag there (no flag set: it unlocks once released). */
export function unlockStop(ctx, stopId, flag) {
  const err = guard(ctx); if (err) return fail(err);
  const stop = byId(ctx.content, stopId);
  if (!stop || stop.role !== 'stop') return fail('Unknown location.');
  if (stopOpen(ctx.content, ctx.state, stopId)) return { ok: true, already: true };
  if (!inRange(ctx.content, ctx.state, stopId, ctx.pos, ctx.now)) return fail('You need to be at this location. Indoors? Scan the QR code posted there.');
  if (!released(ctx.content, ctx.state, stop)) {
    const prev = prevStop(ctx.content, stop);
    return fail(`Locked. Unlock the locations in order: hand in the code from Location ${prev?.ord ?? '?'} at the base to get this one's hint and entry question.`);
  }
  if (stop.entryAnswer && norm(flag) !== norm(stop.entryAnswer)) return fail("That is not this location's entry flag. Check the hint and question you got at the base.");
  ctx.state.discovered ||= [];
  if (!ctx.state.discovered.includes(stopId)) ctx.state.discovered.push(stopId);
  ctx.state.unlocked.push(stopId);
  stamp(ctx, 'unlocked', stopId);
  return { ok: true, place: stop.place };
}

export function hubFlag(ctx, flag) {
  const err = guard(ctx); if (err) return fail(err);
  const hub = hubOf(ctx.content);
  if (hub && !inRange(ctx.content, ctx.state, hub.id, ctx.pos, ctx.now)) return fail('Hand in flags at the base (the vending machine area).');
  const stop = stopsOf(ctx.content).find((s) => norm(s.exitFlag) === norm(flag));
  if (!stop) return fail('That is not a location flag. Check it and try again.');
  if (!ctx.state.hubFlags.includes(stop.id)) { ctx.state.hubFlags.push(stop.id); stamp(ctx, 'handed', stop.id); }
  const need = stopsOf(ctx.content).length;
  if (ctx.state.hubFlags.length >= need) {
    ctx.content.filter((s) => s.role === 'bonus').forEach((s) => { if (!ctx.state.unlocked.includes(s.id)) ctx.state.unlocked.push(s.id); });
  }
  checkFinish(ctx.content, ctx.state, ctx.now);
  return { ok: true, place: stop.place, have: ctx.state.hubFlags.length, need };
}

export function submitFlag(ctx, stopId, idx, flag) {
  const err = guard(ctx); if (err) return fail(err);
  const stop = byId(ctx.content, stopId);
  const puzzle = stop?.puzzles[idx];
  if (!stop || !puzzle || stop.role === 'hub') return fail('Unknown question.');
  if (!stopOpen(ctx.content, ctx.state, stopId)) return fail('Unlock this location first.');
  if (puzzle.kind === 'photo' && !ctx.state.photoCleared.includes(sid(stopId, idx))) return fail('Photograph the object first. The question appears after the photo.');
  if (norm(flag) !== norm(puzzle.flag)) { ((ctx.state.wrong ||= {})[stopId] ||= 0); ctx.state.wrong[stopId]++; return fail('That flag is not quite right. Check the clue and try again.'); }
  ctx.state.solved[sid(stopId, idx)] = { by: ctx.me, at: ctx.now };
  checkFinish(ctx.content, ctx.state, ctx.now);
  return { ok: true };
}

/** Demo has no AI: the photo stage clears on any photo, and says so. */
export function photoClear(ctx, stopId, idx) {
  const err = guard(ctx); if (err) return fail(err);
  const stop = byId(ctx.content, stopId);
  if (!stop?.puzzles[idx] || stop.puzzles[idx].kind !== 'photo') return fail('Unknown photo question.');
  if (!stopOpen(ctx.content, ctx.state, stopId)) return fail('Unlock this location first.');
  const key = sid(stopId, idx);
  if (!ctx.state.photoCleared.includes(key)) ctx.state.photoCleared.push(key);
  return { ok: true, cleared: true, simulated: true };
}

export function scanQr(ctx, stopId, token) {
  if (!ctx.team?.locked) return fail('Join and lock a team first, then scan again.');
  const err = gameError(ctx.game, ctx.now); if (err) return fail(err);
  const stop = byId(ctx.content, stopId);
  if (!stop || stop.qrToken !== String(token || '').trim()) return fail('That QR code is not valid.');
  ctx.state.presence[stopId] = ctx.now;
  ctx.state.discovered ||= [];
  if (stop.role === 'stop' && !ctx.state.discovered.includes(stopId)) { ctx.state.discovered.push(stopId); stamp(ctx, 'discovered', stopId); }
  return { ok: true, place: stop.place };
}

/** Same shape as the database's team_recap(). Demo has no other teams, so rank is 1 of 1. */
export function buildRecap({ content, state, team, me = 'demo' }) {
  if (!state.finishedAt) return { ok: false, error: 'The recap appears once your team has finished.' };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const at = state.at || {};
  const stops = stopsOf(content).map((s) => {
    const solves = s.puzzles.map((_, i) => state.solved[sid(s.id, i)]?.at).filter(Boolean);
    return {
      ord: s.ord, place: s.place, name: s.name, icon: s.icon,
      discoveredAt: iso(at.discovered?.[s.id]), unlockedAt: iso(at.unlocked?.[s.id]), clearedAt: iso(solves.length ? Math.max(...solves) : null),
      handedInAt: iso(at.handed?.[s.id]), wrong: state.wrong?.[s.id] || 0,
    };
  });
  const solvedList = Object.entries(state.solved).map(([key, v]) => {
    const [stopId, idx] = key.split(':');
    const unlockedAt = at.unlocked?.[stopId];
    return { title: byId(content, stopId)?.puzzles[Number(idx)]?.title, by: v.by, seconds: unlockedAt ? Math.round((v.at - unlockedAt) / 1000) : null };
  }).filter((x) => x.seconds != null && x.seconds >= 0).sort((a, b) => a.seconds - b.seconds);
  const fastest = solvedList[0] ? { title: solvedList[0].title, seconds: solvedList[0].seconds, by: team?.members?.find((m) => m.id === solvedList[0].by)?.name ?? 'You' } : null;
  const flags = Object.keys(state.solved).length;
  return {
    ok: true,
    team: { name: team?.name ?? 'Your team', startedAt: iso(state.startedAt), finishedAt: iso(state.finishedAt), elapsedSeconds: Math.round((state.finishedAt - (state.startedAt || state.finishedAt)) / 1000), rank: 1, finishedTeams: 1 },
    stops, flags, wrong: Object.values(state.wrong || {}).reduce((n, x) => n + x, 0),
    members: (team?.members || []).map((m) => ({ name: m.name, solves: Object.values(state.solved).filter((v) => v.by === m.id).length })), fastest,
  };
}
