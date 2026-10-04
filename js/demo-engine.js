// The game rules for LOCAL DEMO mode, mirroring supabase/migrations/0004_game_flow.sql (which is the real thing).
// Pure functions over (content, state, game): no storage here, so they can be unit-tested in Node.
import { distanceM } from './geo.js';

const norm = (value) => String(value || '').trim().toUpperCase();
const PRESENCE_MS = 15 * 60_000;

export const emptyState = () => ({ startedAt: null, finishedAt: null, unlocked: [], solved: {}, hubFlags: [], photoCleared: [], pending: [], presence: {} });
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

export function inRange(content, state, stopId, pos, now = Date.now()) {
  const s = byId(content, stopId);
  if (!s) return false;
  const near = Boolean(pos) && distanceM(pos, s) <= s.radius + Math.min(Math.max(pos.accuracy || 0, 0), 25);
  return near || now - (state.presence[stopId] || 0) < PRESENCE_MS;
}

function checkFinish(content, state, now) {
  const needed = stopsOf(content).length;
  const bonus = content.filter((s) => s.role === 'bonus');
  const bonusClear = bonus.every((s) => stopClear(content, state, s.id));
  if (state.hubFlags.length >= needed && (bonus.length === 0 || bonusClear) && !state.finishedAt) state.finishedAt = now;
}

/** The same JSON shape the database's my_progress() returns. */
export function buildView({ content, state, game, announcements = [], team, now = Date.now() }) {
  if (!team?.locked) return { team: team ?? null, game: { status: gameStatus(game, now), now: new Date(now).toISOString() }, stops: [], announcements: [] };
  const started = teamStarted(content, state);
  const hub = hubOf(content);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  team = { ...team, startedAt: iso(state.startedAt), finishedAt: iso(state.finishedAt) };
  const stops = content.filter((s) => {
    if (s.role === 'hub' || stopOpen(content, state, s.id)) return true;
    if (s.role !== 'stop' || !started) return false;
    const prev = prevStop(content, s);
    return game.hubReveal === 'all' || !prev || stopClear(content, state, prev.id);
  }).sort((a, b) => a.ord - b.ord).map((s) => {
    const cleared = stopClear(content, state, s.id);
    const open = stopOpen(content, state, s.id);
    return {
      id: s.id, ord: s.ord, name: s.name, place: s.place, label: s.label, type: s.type, icon: s.icon, lat: s.lat, lng: s.lng, radius: s.radius,
      description: s.description, role: s.role, entryMode: s.entryMode, hint: s.hint || '', entryQuestion: s.entryQuestion || null,
      prevPlace: prevStop(content, s)?.place ?? null,
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

export function unlockChain(ctx, stopId, flag) {
  const err = guard(ctx); if (err) return fail(err);
  const stop = byId(ctx.content, stopId);
  if (!stop || stop.role !== 'stop') return fail('Unknown location.');
  if (stopOpen(ctx.content, ctx.state, stopId)) return { ok: true };
  if (stop.entryMode === 'hub') return fail('This location is unlocked at the base: answer its question there.');
  if (!inRange(ctx.content, ctx.state, stopId, ctx.pos, ctx.now)) return fail('You need to be at this location. Indoors? Scan the QR code posted there.');
  const prev = prevStop(ctx.content, stop);
  if (prev && !stopClear(ctx.content, ctx.state, prev.id)) return fail(`Clear ${prev.place} first.`);
  if (prev && norm(flag) !== norm(prev.exitFlag)) return fail('Access denied. The previous stop holds this password.');
  ctx.state.unlocked.push(stopId);
  return { ok: true };
}

export function hubAnswer(ctx, stopId, answer) {
  const err = guard(ctx); if (err) return fail(err);
  const stop = byId(ctx.content, stopId);
  if (!stop || stop.role !== 'stop' || stop.entryMode !== 'hub') return fail('That location is not unlocked with a base question.');
  if (stopOpen(ctx.content, ctx.state, stopId)) return { ok: true };
  const hub = hubOf(ctx.content);
  if (hub && !inRange(ctx.content, ctx.state, hub.id, ctx.pos, ctx.now)) return fail('Answer base questions at the base (the vending machine area).');
  if (norm(answer) !== norm(stop.entryAnswer)) return fail('Not quite. Check the hint and try again.');
  ctx.state.unlocked.push(stopId);
  return { ok: true };
}

export function hubFlag(ctx, flag) {
  const err = guard(ctx); if (err) return fail(err);
  const hub = hubOf(ctx.content);
  if (hub && !inRange(ctx.content, ctx.state, hub.id, ctx.pos, ctx.now)) return fail('Hand in flags at the base (the vending machine area).');
  const stop = stopsOf(ctx.content).find((s) => norm(s.exitFlag) === norm(flag));
  if (!stop) return fail('That is not a location flag. Check it and try again.');
  if (!ctx.state.hubFlags.includes(stop.id)) ctx.state.hubFlags.push(stop.id);
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
  if (!inRange(ctx.content, ctx.state, stopId, ctx.pos, ctx.now)) return fail('You need to be at this location. Indoors? Scan the QR code posted there.');
  if (norm(flag) !== norm(puzzle.flag)) return fail('That flag is not quite right. Check the clue and try again.');
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
  if (!inRange(ctx.content, ctx.state, stopId, ctx.pos, ctx.now)) return fail('You need to be at this location. Indoors? Scan the QR code posted there.');
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
  return { ok: true, place: stop.place };
}
