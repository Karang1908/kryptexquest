// Synthetic organiser data for demo mode (no backend), so the console can be explored.
// Everything here is invented except the signed-in demo player's own team, if they made one.
import { DEMO_STOPS } from './data.js';

const NAMES = [
  ['Night Owls', ['Amira', 'Rohan', 'Lina']], ['Byte Me', ['Zayd', 'Meera', 'Omar', 'Tara']],
  ['Null Pointers', ['Kabir', 'Sana']], ['Stack Overflow', ['Yusuf', 'Anya', 'Ibrahim']], ['Git Gud', ['Noor', 'Dev']],
];
const SOLVE_PLAN = [7, 12, 4, 9, 2]; // flags solved by each fake team, out of 12
const BASE = Date.now() - 95 * 60 * 1000;
const puzzleTitle = (stopId, idx) => DEMO_STOPS.find((s) => s.id === stopId)?.puzzles[idx]?.title || '';
const allPuzzles = DEMO_STOPS.flatMap((s) => s.puzzles.map((_, idx) => ({ stopId: s.id, idx })));

function fakeTeams() {
  return NAMES.map(([name, people], t) => {
    const members = people.map((n, m) => ({ id: `t${t}m${m}`, name: n, email: `${n.toLowerCase()}@dubai.bits-pilani.ac.in`, isLeader: m === 0, joinedAt: new Date(BASE + t * 60000).toISOString() }));
    const solved = allPuzzles.slice(0, SOLVE_PLAN[t]).map((p, i) => {
      const who = members[(i * 7 + t) % members.length];
      return { ...p, title: puzzleTitle(p.stopId, p.idx), kind: DEMO_STOPS.find((s) => s.id === p.stopId).puzzles[p.idx].kind, userId: who.id, userName: who.name, at: new Date(BASE + (12 + t * 3 + i * 6) * 60000).toISOString() };
    });
    const stopsCleared = Math.floor(SOLVE_PLAN[t] / 3);
    const unlocked = DEMO_STOPS.slice(1, stopsCleared + 1).map((s, i) => ({ stopId: s.id, userName: members[0].name, at: new Date(BASE + (10 + t * 3 + i * 18) * 60000).toISOString() }));
    return {
      id: `team${t}`, name, code: `D${t}M0${t}${t}`, locked: true, lockedAt: new Date(BASE + (t + 4) * 60000).toISOString(), createdAt: new Date(BASE + t * 60000).toISOString(),
      leaderId: members[0].id, lastActivity: solved.at(-1)?.at || null, solved, unlocked,
      members: members.map((m, i) => ({ ...m, solves: solved.filter((s) => s.userId === m.id).length, unlocks: i === 0 ? unlocked.length : 0, wrong: (t + i * 2) % 4, lastSeen: new Date(Date.now() - ((t + i) % 3) * 30000).toISOString() })),
    };
  });
}

function localTeam(team, state) {
  if (!team) return null;
  const solved = (state.solved || []).map((id, i) => {
    const [stopId, idx] = id.split(':');
    return { stopId, idx: Number(idx), title: puzzleTitle(stopId, Number(idx)), kind: 'flag', userId: 'demo', userName: 'You (demo)', at: new Date(Date.now() - (state.solved.length - i) * 60000).toISOString() };
  });
  return {
    id: team.id, name: `${team.name} (you)`, code: team.code, locked: team.locked, lockedAt: null, createdAt: new Date().toISOString(), leaderId: team.leaderId,
    lastActivity: solved.at(-1)?.at || null, solved, unlocked: [],
    members: team.members.map((m) => ({ id: m.id, name: m.name, email: `${m.id}@dubai.bits-pilani.ac.in`, isLeader: m.isLeader, joinedAt: new Date().toISOString(), solves: solved.filter((s) => s.userId === m.id).length, unlocks: 0, wrong: 0, lastSeen: new Date().toISOString() })),
  };
}

export function teams(team, state) {
  return [...fakeTeams(), localTeam(team, state)].filter(Boolean);
}

export function live(team, loc, state) {
  const t = Date.now() / 1000;
  const players = fakeTeams().flatMap((tm, ti) => tm.members.map((m, mi) => {
    const stop = DEMO_STOPS[(ti + mi) % DEMO_STOPS.length];
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
  teams(localT, state).forEach((tm, ti) => {
    const base = Date.parse(tm.createdAt);
    push({ at: tm.createdAt, kind: 'team_created', teamId: tm.id, teamName: tm.name, userId: tm.members[0]?.id, userName: tm.members[0]?.name, detail: tm.name });
    tm.members.slice(1).forEach((m, i) => push({ at: new Date(base + (i + 1) * 20000).toISOString(), kind: 'team_joined', teamId: tm.id, teamName: tm.name, userId: m.id, userName: m.name, detail: tm.name }));
    if (tm.locked) push({ at: tm.lockedAt || new Date(base + 120000).toISOString(), kind: 'team_locked', teamId: tm.id, teamName: tm.name, userId: tm.members[0]?.id, userName: tm.members[0]?.name, detail: `${tm.members.length} players` });
    tm.unlocked.forEach((u) => push({ at: u.at, kind: 'unlock', teamId: tm.id, teamName: tm.name, userName: u.userName, stopId: u.stopId, stopPlace: DEMO_STOPS.find((s) => s.id === u.stopId)?.place, distM: 12 + ti * 3 }));
    tm.solved.forEach((s, i) => {
      const stopPlace = DEMO_STOPS.find((x) => x.id === s.stopId)?.place;
      if (i % 3 === 1) push({ at: new Date(Date.parse(s.at) - 40000).toISOString(), kind: 'flag', ok: false, teamId: tm.id, teamName: tm.name, userId: s.userId, userName: s.userName, stopId: s.stopId, stopPlace, idx: s.idx, distM: 20 + i, detail: 'KQ{GUESS}' });
      push({ at: s.at, kind: s.kind === 'photo' ? 'photo' : 'flag', teamId: tm.id, teamName: tm.name, userId: s.userId, userName: s.userName, stopId: s.stopId, stopPlace, idx: s.idx, distM: 8 + i * 2 });
    });
  });
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  rows.forEach((r, i) => { r.id = i + 1; });
  return rows.filter((r) => (!before || r.id < before) && (!team || r.teamId === team) && (!kind || r.kind === kind)).reverse().slice(0, limit);
}
