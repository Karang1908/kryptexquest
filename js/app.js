import { CONFIG } from './config.js';
import * as api from './api.js';
import { createLocation, distanceM, bearingDeg } from './geo.js';
import { createWorld } from './world.js';
import { startLoginArt } from './login-art.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  started: false, viewTeam: false, polling: false,
  user: null, stops: [], progress: { unlocked: [], solved: [], clues: {} },
  avatar: 'male', fix: null, gps: 'idle', world: null, loc: null,
  openId: null, expanded: 0, photo: null, busy: false,
};
let toastTimer;

// ---------- derived state ----------
const stopById = (id) => S.stops.find((s) => s.id === id);
const solvedCount = (stop) => stop.puzzles.filter((p) => S.progress.solved.includes(`${stop.id}:${p.idx}`)).length;
const isComplete = (stop) => solvedCount(stop) === stop.puzzles.length;
const isUnlocked = (stop) => stop.ord === 1 || S.progress.unlocked.includes(stop.id);
const statusOf = (stop) => (isComplete(stop) ? 'cleared' : isUnlocked(stop) ? 'open' : 'locked');
const radiusOf = (stop) => stop.radius || CONFIG.defaultRadiusM;
const distanceTo = (stop) => (S.fix ? distanceM(S.fix, stop) : null);
const inRange = (stop) => distanceTo(stop) !== null && distanceTo(stop) <= radiusOf(stop);
const fmtDist = (m) => (m === null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
function confetti() {
  const host = $('#confetti');
  const colors = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'];
  host.innerHTML = Array.from({ length: 36 }, (_, i) => `<i style="left:${Math.random() * 100}%;background:${colors[i % 4]};animation-delay:${Math.random() * 0.35}s;--dx:${(Math.random() - 0.5) * 160}px"></i>`).join('');
  setTimeout(() => { host.innerHTML = ''; }, 2400);
}

// ---------- HUD ----------
function renderHud() {
  const done = S.stops.filter(isComplete).length;
  $('#hudProgress').textContent = `${done} / ${S.stops.length}`;
  $('#hudDots').innerHTML = S.stops.map((s) => `<b class="${statusOf(s)}"></b>`).join('');
  S.world?.refreshStops(Object.fromEntries(S.stops.map((s) => [s.id, statusOf(s)])), S.openId);
}

function renderGps() {
  const chip = $('#gpsChip');
  const accuracy = S.fix?.accuracy;
  const label = S.fix?.source === 'sim' ? 'SIM' : S.gps === 'ok' && Number.isFinite(accuracy) ? `±${Math.round(accuracy)} m` : S.gps === 'denied' ? 'OFF' : 'SEARCHING';
  chip.className = `chip gps ${S.fix?.source === 'sim' ? 'sim' : S.gps === 'ok' ? (accuracy <= 30 ? 'good' : 'weak') : S.gps === 'denied' ? 'bad' : 'wait'}`;
  $('#gpsText').textContent = label;
}

function nearestTarget() {
  if (!S.fix) return null;
  const pool = S.stops.filter((s) => statusOf(s) !== 'cleared' && (isUnlocked(s) || S.stops[s.ord - 2] && isComplete(S.stops[s.ord - 2])));
  const list = pool.length ? pool : S.stops;
  return list.map((s) => ({ stop: s, dist: distanceTo(s) })).sort((a, b) => a.dist - b.dist)[0];
}

function renderNear() {
  const card = $('#nearCard');
  const target = nearestTarget();
  if (!target || S.openId) { card.hidden = true; return; }
  const { stop, dist } = target;
  card.hidden = false;
  card.dataset.stop = stop.id;
  card.classList.toggle('in-range', dist <= radiusOf(stop));
  $('#nearKicker').textContent = dist <= radiusOf(stop) ? 'YOU ARE HERE · TAP TO OPEN' : isUnlocked(stop) ? 'NEXT SIGNAL' : 'NEXT STOP';
  $('#nearName').textContent = stop.place;
  $('#nearDist').textContent = fmtDist(dist);
  const here = S.world?.shownPosition() || S.fix;
  // The ➤ glyph points east (90°) at rotate(0).
  $('#nearArrow').style.transform = `rotate(${bearingDeg(here, stop) - (S.world?.bearing() || 0) - 90}deg)`;
}

// ---------- stop sheet ----------
function puzzleCard(stop, puzzle, range) {
  const id = `${stop.id}:${puzzle.idx}`;
  const solved = S.progress.solved.includes(id);
  const open = S.expanded === puzzle.idx && !solved;
  const isPhoto = puzzle.kind === 'photo';
  const hasPhoto = S.photo?.id === id;
  const lock = range ? '' : 'disabled';
  return `<article class="puzzle ${solved ? 'solved' : ''}">
    <button class="puzzle-head" type="button" data-action="expand" data-idx="${puzzle.idx}" aria-expanded="${open}">
      <span class="puzzle-num">${solved ? '✓' : puzzle.idx + 1}</span><strong>${esc(puzzle.title)}</strong>
      <small>${solved ? esc(memberName(S.progress.solvedBy?.[id]) || 'CLEARED') : isPhoto ? 'PHOTO' : 'FLAG'}</small></button>
    ${open ? `<div class="puzzle-body"><p>${esc(puzzle.prompt)}</p>
      ${isPhoto ? `<label class="photo-pick ${lock}">📷 ${hasPhoto ? 'Retake photo' : 'Take a photo'}<input id="photoInput" type="file" accept="image/*" capture="environment" ${lock} /></label>
        ${hasPhoto ? `<img class="photo-preview" src="${S.photo.url}" alt="Your photo" /><button class="primary-button" type="button" data-action="verify-photo" ${lock || (S.busy ? 'disabled' : '')}>${S.busy ? 'Reviewing…' : 'Send for review'}</button>` : ''}`
      : `<form class="flag-row" data-form="flag" data-idx="${puzzle.idx}"><input class="flag-input" name="flag" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="KQ{...}" aria-label="Flag" ${lock} /><button class="small-action" type="submit" ${lock || (S.busy ? 'disabled' : '')}>Verify</button></form>`}
    </div>` : ''}</article>`;
}

function renderSheet() {
  const sheet = $('#sheet');
  const stop = stopById(S.openId);
  sheet.classList.toggle('open', Boolean(stop));
  sheet.setAttribute('aria-hidden', String(!stop));
  document.body.classList.toggle('sheet-open', Boolean(stop));
  if (!stop) return;

  const dist = distanceTo(stop);
  const range = inRange(stop);
  S.rangeShown = range;
  const unlocked = isUnlocked(stop);
  const complete = isComplete(stop);
  const next = S.stops[stop.ord];
  const clue = S.progress.clues[stop.id];
  const sim = S.loc?.isSim();

  const rangeBanner = range ? `<div class="range ok">✓ You're at ${esc(stop.place)}</div>`
    : `<div class="range far">⌖ ${fmtDist(dist)} away · walk within ${radiusOf(stop)} m to interact${sim ? ` <button type="button" class="link" data-action="teleport">Teleport (sim)</button>` : ''}</div>`;

  let body;
  if (!unlocked) {
    body = `<div class="gate"><h3>Location locked</h3><p>The password is the handoff flag from the previous stop.</p>
      <form class="flag-row" data-form="unlock"><input class="flag-input" name="gate" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="KQ{PREVIOUS_FLAG}" aria-label="Location password" ${range ? '' : 'disabled'} /><button class="small-action" type="submit" ${range && !S.busy ? '' : 'disabled'}>Unlock</button></form></div>`;
  } else {
    body = `<div class="progress"><span>THREE SIGNALS</span><b>${solvedCount(stop)} / ${stop.puzzles.length}</b></div>
      <div class="bar"><i style="width:${(solvedCount(stop) / stop.puzzles.length) * 100}%"></i></div>
      <div class="puzzles">${stop.puzzles.map((p) => puzzleCard(stop, p, range)).join('')}</div>
      ${complete && clue ? `<div class="clue"><small>NEXT CLUE</small><strong>“${esc(clue.clue)}”</strong><small>HANDOFF FLAG</small><code>${esc(clue.exitFlag)}</code>${next ? '' : '<p class="win">🏁 Kryptex found. You finished the trail!</p>'}</div>` : ''}`;
  }

  $('#sheetBody').innerHTML = `<div class="sheet-top"><span class="tag">${esc(stop.label)}</span><button class="close" type="button" data-action="close-sheet" aria-label="Close">×</button></div>
    <h2>${esc(stop.name)}</h2><p class="place">${esc(stop.icon)} ${esc(stop.place)}</p><p class="desc">${esc(stop.description)}</p>
    ${rangeBanner}${body}`;
}

function openStop(id) {
  const stop = stopById(id);
  if (!stop) return;
  S.openId = id;
  const first = stop.puzzles.find((p) => !S.progress.solved.includes(`${id}:${p.idx}`));
  S.expanded = first ? first.idx : -1;
  clearPhoto();
  renderSheet(); renderHud(); renderNear();
}
function closeSheet() { S.openId = null; clearPhoto(); renderSheet(); renderHud(); renderNear(); }
function clearPhoto() { if (S.photo?.url) URL.revokeObjectURL(S.photo.url); S.photo = null; }

function applyResult(stop, result, successMessage) {
  S.busy = false;
  if (!result.ok) { renderSheet(); toast(result.error || 'Something went wrong. Try again.'); return false; }
  const wasComplete = isComplete(stop);
  S.progress = result.progress;
  const next = stop.puzzles.find((p) => !S.progress.solved.includes(`${stop.id}:${p.idx}`));
  S.expanded = next ? next.idx : -1;
  clearPhoto();
  renderSheet(); renderHud(); renderNear();
  if (!wasComplete && isComplete(stop)) { confetti(); toast('Location cleared! Your next clue is ready.'); }
  else toast(successMessage);
  return true;
}

// ---------- photo ----------
async function compressImage(file, max = 1280) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.82));
  } catch { return file; }
}

// ---------- events ----------
document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const stop = stopById(S.openId);
  if (action === 'close-sheet') closeSheet();
  if (action === 'expand') { S.expanded = Number(el.dataset.idx); clearPhoto(); renderSheet(); }
  if (action === 'teleport' && stop) { S.loc.teleport(stop); toast(`Teleported to ${stop.place}.`); }
  if (action === 'verify-photo' && stop && S.photo && !S.busy) {
    S.busy = true; renderSheet();
    const result = await api.verifyPhoto(stop, S.expanded, S.photo.blob, S.fix);
    applyResult(stop, result, result.simulated ? 'Demo review passed (simulated, not real AI).' : 'Photo verified. One signal closer.');
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const stop = stopById(S.openId);
  if (!stop || S.busy) return;
  const value = new FormData(form).get(form.dataset.form === 'unlock' ? 'gate' : 'flag');
  if (!String(value || '').trim()) return;
  S.busy = true; renderSheet();
  const result = form.dataset.form === 'unlock'
    ? await api.unlock(stop, value, S.fix)
    : await api.submitFlag(stop, Number(form.dataset.idx), value, S.fix);
  applyResult(stop, result, form.dataset.form === 'unlock' ? `${stop.place} unlocked. Three puzzles await.` : 'Flag verified. One signal closer.');
});

document.addEventListener('change', async (event) => {
  if (event.target.id !== 'photoInput') return;
  const file = event.target.files?.[0];
  if (!file || !file.type.startsWith('image/')) { toast('Choose an image to continue.'); return; }
  const blob = await compressImage(file);
  clearPhoto();
  S.photo = { id: `${S.openId}:${S.expanded}`, blob, url: URL.createObjectURL(blob) };
  renderSheet();
});

$('#nearCard').addEventListener('click', () => openStop($('#nearCard').dataset.stop));

// ---------- location ----------
function onFix(fix) {
  S.fix = fix;
  S.world?.setFix(fix);
  renderGps();
}
function onStatus(status, detail) {
  S.gps = status;
  renderGps();
  const gate = $('#locGate');
  if (status === 'ok' || status === 'searching') gate.hidden = true;
  if (status === 'denied' || status === 'unavailable') {
    gate.hidden = false;
    $('#locTitle').textContent = status === 'denied' ? 'Location is blocked' : 'No location signal';
    $('#locCopy').textContent = status === 'denied'
      ? 'Allow location for this site in your browser or phone settings (Safari: aA → Website Settings → Location; Chrome: lock icon → Permissions), then tap retry.'
      : (detail || 'Could not read your position. Check that location services are on.');
    $('#locEnable').textContent = 'Retry';
  }
}

function startSimulator() {
  S.loc.startSim(S.fix || CONFIG.campus);
  $('#simPad').hidden = false;
  $('#simToggle').checked = true;
  $('#locGate').hidden = true;
}
function stopSimulator() {
  S.loc.stopSim();
  $('#simPad').hidden = true;
  $('#simToggle').checked = false;
  S.loc.startGps();
}

function wireSimulator() {
  const dirs = new Set();
  const vector = () => [...dirs].reduce((acc, d) => ({ x: acc.x + d[0], y: acc.y + d[1] }), { x: 0, y: 0 });
  const push = () => { const v = vector(); S.loc.setSimDirection(v.x, v.y, $('#simFast').checked); };
  document.querySelectorAll('#simPad [data-dir]').forEach((button) => {
    const dir = button.dataset.dir.split(',').map(Number);
    const down = (e) => { e.preventDefault(); dirs.add(dir); push(); };
    const up = () => { dirs.delete(dir); push(); };
    button.addEventListener('pointerdown', down);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((name) => button.addEventListener(name, up));
  });
  const keys = { w: [0, 1], arrowup: [0, 1], s: [0, -1], arrowdown: [0, -1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
  const held = new Map();
  addEventListener('keydown', (e) => {
    const dir = keys[e.key.toLowerCase()];
    if (!dir || !S.loc?.isSim() || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    held.set(e.key.toLowerCase(), dir);
    dirs.clear(); held.forEach((d) => dirs.add(d));
    S.loc.setSimDirection(vector().x, vector().y, e.shiftKey || $('#simFast').checked);
    e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    held.delete(e.key.toLowerCase());
    dirs.clear(); held.forEach((d) => dirs.add(d));
    if (S.loc?.isSim()) S.loc.setSimDirection(vector().x, vector().y, $('#simFast').checked);
  });
}

// ---------- teams ----------
const teamOf = () => S.progress.team;
function memberName(id) { return teamOf()?.members.find((m) => m.id === id)?.name; }

function renderTeam() {
  const team = teamOf();
  $('#teamStart').hidden = Boolean(team);
  $('#teamLobby').hidden = !team;
  $('#teamBack').hidden = !team?.locked;
  if (!team) return;
  const leader = team.members.find((m) => m.isLeader);
  const amLeader = team.leaderId === team.me;
  $('#teamNameOut').textContent = team.name;
  $('#teamCode').textContent = team.code;
  $('#teamCount').textContent = `${team.members.length} / ${team.max} players`;
  $('#teamMembers').innerHTML = team.members.map((m) => `<li><span class="member-av ${m.avatar === 'female' ? 'f' : ''}">${esc(m.name.slice(0, 1).toUpperCase())}</span><span class="member-name">${esc(m.name)}${m.id === team.me ? ' <em>(you)</em>' : ''}</span>${m.isLeader ? '<span class="badge">LEADER</span>' : amLeader && !team.locked ? `<button type="button" class="kick" data-action="kick" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">×</button>` : ''}</li>`).join('');
  const enough = team.members.length >= team.min;
  $('#teamLock').hidden = !amLeader || team.locked;
  $('#teamLock').disabled = !enough;
  $('#teamLock').textContent = enough ? 'Lock in team' : `Need ${team.min - team.members.length} more to lock in`;
  $('#teamLeave').hidden = team.locked;
  $('#teamDemoMate').hidden = api.hasBackend || team.locked;
  $('#teamShare').hidden = team.locked;
  $('#teamStatus').textContent = team.locked ? 'LOCKED IN · let the quest begin'
    : amLeader ? (enough ? 'Everyone here? Lock in to start. No one can join or leave after.' : `Share the code in person. Teams need ${team.min}-${team.max} players.`)
    : `Waiting for ${leader?.name || 'the leader'} to lock the team in…`;
}

async function teamAction(promise, successMessage) {
  const result = await promise;
  if (!result.ok) { toast(result.error || 'Something went wrong.'); return; }
  S.progress = result.progress;
  if (successMessage) toast(successMessage);
  route();
}

function showTeamScreen(viewOnly) {
  S.viewTeam = viewOnly;
  showScreen('team');
  renderTeam();
}

/** Decides which screen the player belongs on, based on their team. */
async function route() {
  const team = teamOf();
  if (team?.locked && !S.viewTeam) {
    if (!S.started) await startGame();
    else showScreen('game');
  } else if (team?.locked) {
    renderTeam();
  } else {
    S.viewTeam = false;
    showTeamScreen(false);
  }
}

function typingInSheet() { return document.activeElement?.closest?.('#sheet') && /INPUT|TEXTAREA/.test(document.activeElement.tagName); }

function announceTeamSolves(prev, next) {
  const fresh = next.solved.filter((id) => !prev.solved.includes(id) && next.solvedBy?.[id] !== next.team?.me);
  if (!fresh.length) return;
  const [stopId, idx] = fresh[0].split(':');
  const title = stopById(stopId)?.puzzles.find((p) => p.idx === Number(idx))?.title || 'a flag';
  toast(`${memberName(next.solvedBy?.[fresh[0]]) || 'A teammate'} solved “${title}”.`);
}

async function pollProgress() {
  if (S.polling) return;
  S.polling = true;
  try {
    const next = await api.loadProgress();
    if (JSON.stringify(next) === JSON.stringify(S.progress)) return;
    const prev = S.progress;
    S.progress = next;
    if (S.started) { announceTeamSolves(prev, next); renderHud(); renderNear(); if (!typingInSheet()) renderSheet(); }
    if (!S.started || !$('#teamScreen').hidden || prev.team?.locked !== next.team?.locked) route();
  } catch (error) { console.warn('progress poll failed', error); }
  finally { S.polling = false; }
}

// ---------- boot ----------
function showScreen(name) {
  $('#loginScreen').hidden = name !== 'login';
  $('#teamScreen').hidden = name !== 'team';
  $('#game').hidden = name !== 'game';
}

function setAvatar(kind) {
  S.avatar = kind;
  S.world?.setAvatar(kind);
  document.querySelectorAll('.avatar-option').forEach((o) => o.classList.toggle('selected', o.dataset.avatar === kind));
}

async function enterGame(user) {
  if (!api.emailAllowed(user.email)) {
    await api.signOut();
    return showLogin(`Use your @${CONFIG.allowedEmailDomain} Google account to play.`);
  }
  S.user = user;
  try {
    const game = await api.loadGame();
    S.stops = game.stops; S.progress = game.progress;
  } catch (error) {
    console.error(error);
    return showLogin('Could not load the quest. Check your connection and try again.');
  }
  api.saveProfile(user).catch(() => {});
  const saved = await api.loadAvatar().catch(() => null);
  setAvatar(saved === 'female' ? 'female' : 'male');
  $('#menuName').textContent = user.name;
  $('#menuEmail').textContent = user.email;
  $('#resetRow').hidden = api.hasBackend;
  $('#simToggleRow').hidden = !CONFIG.allowSimulator;
  $('#locSim').hidden = !CONFIG.allowSimulator;
  $('#modeNote').textContent = api.hasBackend ? '' : 'Demo mode: sample content, progress saved on this device only.';
  setInterval(pollProgress, 4000);
  await route();
  if (!localStorage.getItem('kq-avatar')) $('#avatarDialog').showModal();
}

async function startGame() {
  S.started = true;
  showScreen('game');
  S.loc = createLocation({ onFix, onStatus });
  try {
    S.world = await createWorld({ onStopTap: openStop });
  } catch (error) {
    console.error(error);
    S.started = false;
    toast('The live map could not load. Check your connection and reload.');
    return;
  }
  S.world.setAvatar(S.avatar);
  S.world.setStops(S.stops);
  if (S.fix) S.world.setFix(S.fix);
  renderHud(); renderGps();
  setInterval(() => {
    renderNear();
    renderHud();
    // Re-render the sheet only when range flips, so typing in an input is never wiped.
    const stop = stopById(S.openId);
    if (stop && S.rangeShown !== inRange(stop)) renderSheet();
  }, 1000);
  // Organisers see where players are: latest position only, every ~10 s.
  setInterval(() => { if (S.fix) api.sendLocation(S.fix).catch(() => {}); }, 10000);
  const needle = $('#compassNeedle');
  (function spin() { needle.style.transform = `rotate(${-(S.world.bearing() || 0)}deg)`; requestAnimationFrame(spin); })();

  startLocation();
  navigator.wakeLock?.request('screen').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) navigator.wakeLock?.request('screen').catch(() => {}); });
}

async function startLocation() {
  let state = 'prompt';
  try { state = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* Safari: unknown */ }
  if (state === 'granted') S.loc.startGps();
  else { $('#locGate').hidden = false; }
}

function showLogin(error) {
  showScreen('login');
  const el = $('#loginError');
  el.hidden = !error; el.textContent = error || '';
}

async function boot() {
  startLoginArt($('#loginCanvas'));
  $('#domainHint').textContent = `@${CONFIG.allowedEmailDomain}`;
  $('#demoSignIn').hidden = api.hasBackend;
  if (!api.hasBackend) $('#googleSignIn').hidden = true;
  const urlError = api.authErrorFromUrl();
  const user = await api.getUser();
  if (user) await enterGame(user);
  else showLogin(urlError);
}

$('#googleSignIn').addEventListener('click', async () => {
  try { await api.signInWithGoogle(); } catch (error) { showLogin(error.message); }
});
$('#demoSignIn').addEventListener('click', () => enterGame(api.signInDemo()));

$('#createForm').addEventListener('submit', (e) => { e.preventDefault(); teamAction(api.createTeam(new FormData(e.target).get('team')), 'Team created. Share your code!'); });
$('#joinForm').addEventListener('submit', (e) => { e.preventDefault(); teamAction(api.joinTeam(new FormData(e.target).get('code')), 'You joined the team.'); });
$('#teamShare').addEventListener('click', async () => {
  const team = teamOf();
  const text = `Join my Kryptex Quest team "${team.name}" with code ${team.code}`;
  if (navigator.share) { try { await navigator.share({ text }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(team.code); toast('Code copied.'); } catch { toast(`Your code: ${team.code}`); }
});
$('#teamLock').addEventListener('click', () => { if (confirm('Lock in this team? Nobody can join or leave afterwards.')) teamAction(api.lockTeam(), 'Team locked in. Good luck!'); });
$('#teamLeave').addEventListener('click', () => { if (confirm('Leave this team?')) teamAction(api.leaveTeam(), 'You left the team.'); });
$('#teamBack').addEventListener('click', () => { S.viewTeam = false; route(); });
$('#teamDemoMate').addEventListener('click', () => teamAction(Promise.resolve(api.demoAddTeammate())));
$('#teamMembers').addEventListener('click', (e) => {
  const kick = e.target.closest('[data-action=kick]');
  if (kick && confirm('Remove this player from the team?')) teamAction(api.kickMember(kick.dataset.id));
});

$('#locEnable').addEventListener('click', () => { $('#locGate').hidden = true; S.loc.startGps(); });
$('#locSim').addEventListener('click', startSimulator);
$('#simToggle').addEventListener('change', (e) => (e.target.checked ? startSimulator() : stopSimulator()));
$('#gpsChip').addEventListener('click', () => toast(S.fix ? `${S.fix.source === 'sim' ? 'Simulated' : 'GPS'} position · accuracy ±${Math.round(S.fix.accuracy)} m` : 'Waiting for a GPS signal…'));
$('#compassButton').addEventListener('click', () => {
  const on = !S.world.isNorthUp();
  S.world.setNorthUp(on);
  $('#compassButton').setAttribute('aria-pressed', String(on));
  toast(on ? 'North is up. The explorer turns instead.' : 'Camera follows behind your explorer.');
});
$('#menuButton').addEventListener('click', () => $('#menuDialog').showModal());

document.querySelectorAll('.avatar-option').forEach((option) => option.addEventListener('click', async () => {
  setAvatar(option.dataset.avatar);
  $('#avatarDialog').close();
  await api.saveProfile(S.user, S.avatar).catch(() => {});
  toast('Explorer updated.');
}));

$('#menuDialog').addEventListener('click', async (event) => {
  const item = event.target.closest('[data-menu]');
  if (!item) return;
  $('#menuDialog').close();
  const action = item.dataset.menu;
  if (action === 'avatar') $('#avatarDialog').showModal();
  if (action === 'team') showTeamScreen(true);
  if (action === 'help') $('#helpDialog').showModal();
  if (action === 'reset' && confirm('Reset all demo progress on this device?')) { api.resetDemo(); location.reload(); }
  if (action === 'signout') { await api.signOut(); location.reload(); }
});

wireSimulator();
boot();
