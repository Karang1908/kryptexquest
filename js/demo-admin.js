// Synthetic organiser data for demo mode (no backend), so the console can be explored.
// Everything here is invented except the signed-in demo player's own team, if they made one.
import { DEMO_STOPS } from './data.js';
import { gameStatus } from './demo-engine.js';

const NAMES = [
  ['Night Owls', ['Amira', 'Rohan', 'Lina']], ['Byte Me', ['Zayd', 'Meera', 'Omar', 'Tara']],
  ['Null Pointers', ['Kabir', 'Sana']], ['Stack Overflow', ['Yusuf', 'Anya', 'Ibrahim']], ['Git Gud', ['Noor', 'Dev']],
];
const SOLVE_PLAN = [6, 10, 3, 8, 2];  // flags solved by each invented team (10 questions in total)
const BASE = Date.now() - 95 * 60 * 1000;
const playable = DEMO_STOPS.filter((s) => s.role !== 'hub');
const allPuzzles = playable.flatMap((s) => s.puzzles.map((p, idx) => ({ stopId: s.id, idx, title: p.title, kind: p.kind })));
const regular = DEMO_STOPS.filter((s) => s.role === 'stop');

function fakeTeams() {
  return NAMES.map(([name, people], t) => {
    const members = people.map((n, m) => ({ id: `t${t}m${m}`, name: n, email: `${n.toLowerCase()}@dubai.bits-pilani.ac.in`, isLeader: m === 0, joinedAt: new Date(BASE + t * 60000).toISOString() }));
    const solved = allPuzzles.slice(0, SOLVE_PLAN[t]).map((p, i) => {
      const who = members[(i * 7 + t) % members.length];
      return { ...p, userId: who.id, userName: who.name, at: new Date(BASE + (12 + t * 3 + i * 7) * 60000).toISOString() };
    });
    const clearedStops = regular.filter((s) => s.puzzles.every((_, i) => solved.some((x) => x.stopId === s.id && x.idx === i)));
    const unlocked = regular.slice(0, clearedStops.length + 1).map((s, i) => ({ stopId: s.id, userName: members[0].name, at: new Date(BASE + (10 + t * 3 + i * 18) * 60000).toISOString() }));
    const finished = SOLVE_PLAN[t] >= allPuzzles.length;
    return {
      id: `team${t}`, name, code: `D${t}M0${t}${t}`, locked: true, lockedAt: new Date(BASE + (t + 4) * 60000).toISOString(), createdAt: new Date(BASE + t * 60000).toISOString(),
      startedAt: new Date(BASE + (t + 6) * 60000).toISOString(), finishedAt: finished ? new Date(BASE + 80 * 60000).toISOString() : null,
      hubFlags: clearedStops.map((s) => s.id), leaderId: members[0].id, lastActivity: solved.at(-1)?.at || null, solved, unlocked,
      members: members.map((m, i) => ({ ...m, solves: solved.filter((s) => s.userId === m.id).length, unlocks: i === 0 ? unlocked.length : 0, wrong: (t + i * 2) % 4, lastSeen: new Date(Date.now() - ((t + i) % 3) * 30000).toISOString() })),
    };
  });
}

function localTeam(team, state) {
  if (!team) return null;
  const solved = Object.entries(state.solved || {}).map(([id, v]) => {
    const [stopId, idx] = id.split(':');
    const p = playable.find((s) => s.id === stopId)?.puzzles[Number(idx)];
    return { stopId, idx: Number(idx), title: p?.title || id, kind: p?.kind || 'flag', userId: v.by, userName: v.by ? 'You (demo)' : 'organiser', at: new Date(v.at).toISOString() };
  });
  return {
    id: team.id, name: `${team.name} (you)`, code: team.code, locked: team.locked, lockedAt: null, createdAt: new Date().toISOString(), leaderId: team.leaderId,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null, finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
    hubFlags: state.hubFlags || [], lastActivity: solved.at(-1)?.at || null, solved,
    unlocked: (state.unlocked || []).map((stopId) => ({ stopId, userName: 'You (demo)', at: new Date().toISOString() })),
    members: team.members.map((m) => ({ id: m.id, name: m.name, email: `${m.id}@dubai.bits-pilani.ac.in`, isLeader: m.isLeader, joinedAt: new Date().toISOString(), solves: solved.filter((s) => s.userId === m.id).length, unlocks: 0, wrong: 0, lastSeen: new Date().toISOString() })),
  };
}

export function teams(team, state) {
  return [...fakeTeams(), localTeam(team, state)].filter(Boolean);
}

export function live(team, loc, state) {
  const t = Date.now() / 1000;
  const players = fakeTeams().flatMap((tm, ti) => tm.members.map((m, mi) => {
    const stop = regular[(ti + mi) % regular.length];
    const a = t / 25 + ti * 1.7 + mi * 2.1;
    return {
      id: m.id, name: m.name, email: m.email, avatar: (ti + mi) % 2 ? 'female' : 'male', teamId: tm.id, teamName: tm.name,
      lat: stop.lat + Math.sin(a) * 0.0002, lng: stop.lng + Math.cos(a) * 0.0003, accuracy: 6 + ((ti + mi) % 5) * 4,
      updatedAt: new Date(Date.now() - (((ti * 3 + mi) % 7 === 0) ? 6 * 60000 : ((ti + mi) % 4) * 4000)).toISOString(),
    };
  }));
  if (loc && Date.now() - loc.at < 60000) {
    players.push({ id: 'demo', name: 'You (demo)', email: 'explorer@dubai.bits-pilani.ac.in', avatar: 'male', teamId: team?.id || null, teamName: team?.name || null, lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy, updatedAt: new Date(loc.at).toISOString() });
  }
  const all = teams(team, state);
  return { now: new Date().toISOString(), registered: 40 + players.length, teams: all.length, lockedTeams: all.filter((x) => x.locked).length, flagsSolved: all.reduce((n, x) => n + x.solved.length, 0), players };
}

export function events({ limit, before, team, kind }, localT, state) {
  const rows = [];
  let id = 1;
  const push = (row) => rows.push({ id: id++, ok: true, lat: null, lng: null, distM: null, detail: null, idx: null, stopId: null, stopPlace: null, ...row });
  const place = (stopId) => DEMO_STOPS.find((s) => s.id === stopId)?.place;
  teams(localT, state).forEach((tm, ti) => {
    const base = Date.parse(tm.createdAt);
    push({ at: tm.createdAt, kind: 'team_created', teamId: tm.id, teamName: tm.name, userId: tm.members[0]?.id, userName: tm.members[0]?.name, detail: tm.name });
    tm.members.slice(1).forEach((m, i) => push({ at: new Date(base + (i + 1) * 20000).toISOString(), kind: 'team_joined', teamId: tm.id, teamName: tm.name, userId: m.id, userName: m.name, detail: tm.name }));
    if (tm.locked) push({ at: tm.lockedAt || new Date(base + 120000).toISOString(), kind: 'team_locked', teamId: tm.id, teamName: tm.name, userId: tm.members[0]?.id, userName: tm.members[0]?.name, detail: `${tm.members.length} players` });
    if (tm.startedAt) push({ at: tm.startedAt, kind: 'checkin', teamId: tm.id, teamName: tm.name, userName: tm.members[0]?.name, stopId: 'base', stopPlace: place('base') });
    tm.unlocked.forEach((u) => push({ at: u.at, kind: 'unlock', teamId: tm.id, teamName: tm.name, userName: u.userName, stopId: u.stopId, stopPlace: place(u.stopId), distM: 12 + ti * 3 }));
    tm.solved.forEach((s, i) => {
      if (i % 3 === 1) push({ at: new Date(Date.parse(s.at) - 40000).toISOString(), kind: 'flag', ok: false, teamId: tm.id, teamName: tm.name, userId: s.userId, userName: s.userName, stopId: s.stopId, stopPlace: place(s.stopId), idx: s.idx, distM: 20 + i, detail: 'KQ{GUESS}' });
      push({ at: s.at, kind: 'flag', teamId: tm.id, teamName: tm.name, userId: s.userId, userName: s.userName, stopId: s.stopId, stopPlace: place(s.stopId), idx: s.idx, distM: 8 + i * 2 });
    });
    tm.hubFlags.forEach((stopId, i) => push({ at: new Date(Date.parse(tm.startedAt || tm.createdAt) + (60 + i) * 60000).toISOString(), kind: 'hub_flag', teamId: tm.id, teamName: tm.name, userName: tm.members[0]?.name, stopId, stopPlace: place(stopId) }));
    if (tm.finishedAt) push({ at: tm.finishedAt, kind: 'finished', teamId: tm.id, teamName: tm.name, detail: 'quest complete' });
  });
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  rows.forEach((r, i) => { r.id = i + 1; });
  return rows.filter((r) => (!before || r.id < before) && (!team || r.teamId === team) && (!kind || r.kind === kind)).reverse().slice(0, limit);
}

/** Same shape as the database's leaderboard(): invented teams + the demo player's own team. */
export function leaderboard(team, state, content, game) {
  const rows = teams(team, state).filter((t) => t.locked).map((t) => {
    const cleared = (content || DEMO_STOPS).filter((s) => s.role !== 'hub' && s.puzzles.length && s.puzzles.every((_, i) => t.solved.some((x) => x.stopId === s.id && x.idx === i))).length;
    const started = t.startedAt || t.lockedAt || t.createdAt;
    return {
      teamId: t.id, name: t.name, players: t.members.length, flags: t.solved.length, stopsCleared: cleared, hubFlags: t.hubFlags.length,
      startedAt: t.startedAt, finishedAt: t.finishedAt, lastSolveAt: t.solved.at(-1)?.at ?? null,
      elapsedSeconds: t.finishedAt ? (Date.parse(t.finishedAt) - Date.parse(started)) / 1000 : null,
    };
  });
  rows.sort((a, b) => (!a.finishedAt - !b.finishedAt) || ((a.elapsedSeconds ?? 1e12) - (b.elapsedSeconds ?? 1e12)) || (b.flags - a.flags) || (Date.parse(a.lastSolveAt || 0) - Date.parse(b.lastSolveAt || 0)));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { status: gameStatus(game || { status: 'running' }), now: new Date().toISOString(), me: team?.id ?? null, stops: (content || DEMO_STOPS).filter((s) => s.role !== 'hub').length, rows };
}
