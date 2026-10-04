import { CONFIG } from './config.js';
import * as api from './api.js';
import { createLocation, distanceM, bearingDeg } from './geo.js';
import { createWorld } from './world.js';
import { createCompass } from './compass.js';
import { createMotion } from './motion.js';
import { compressImage } from './image.js';
import { startLoginArt } from './login-art.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// S.view is the server's (or demo engine's) one source of truth; S.stops / S.progress are conveniences derived from it.
const S = {
  started: false, viewTeam: false, polling: false,
  user: null, view: null, stops: [], progress: { team: null, solved: [], solvedBy: {}, pending: [], clues: {} },
  avatar: 'male', fix: null, gps: 'idle', world: null, loc: null,
  openId: null, expanded: 0, photo: null, busy: false, presence: {}, mapSig: '', arriveTried: {}, arriving: false, lockMsg: '',
  seenAnnounce: Number(localStorage.getItem('kq-seen-announce') || 0), shownAnnounce: 0, safetyMsg: '', boardTimer: null,
};
let toastTimer;
const PRESENCE_MS = 15 * 60_000;
/** Vibrate, but only once the page has had a tap: browsers log an error for earlier attempts. */
const buzz = (pattern) => { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(pattern); };

// ---------- derived state ----------
const isHub = (stop) => stop.role === 'hub';
const stopById = (id) => S.stops.find((s) => s.id === id);
const solvedCount = (stop) => stop.puzzles.filter((p) => p.solved).length;
const isComplete = (stop) => stop.state === 'cleared';
const isUnlocked = (stop) => stop.state !== 'locked';
const radiusOf = (stop) => stop.radius || CONFIG.defaultRadiusM;
const distanceTo = (stop) => (S.fix ? distanceM(S.fix, stop) : null);
const inRange = (stop) => {
  if (stop.role === 'bonus') return true;                                     // the bonus question needs no location
  if (Date.now() - (S.presence[stop.id] || 0) < PRESENCE_MS) return true;      // scanned the QR posted at the stop
  const d = distanceTo(stop);
  return d !== null && d <= radiusOf(stop) + Math.min(Math.max(S.fix?.accuracy || 0, 0), 25);
};
const fmtDist = (m) => (m === null ? '—' : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const teamOf = () => S.view?.team ?? null;
function memberName(id) { return teamOf()?.members.find((m) => m.id === id)?.name; }
const playStops = () => S.stops.filter((s) => s.role === 'stop');
/** The place name is a reward for discovering it; until then players only know "Location N" and a hint. */
const stopTitle = (stop) => (stop.role === 'stop' && stop.state === 'locked' ? `Location ${stop.ord}` : stop.place);

function applyView(view) {
  S.view = view;
  S.stops = view.stops || [];
  const solved = []; const solvedBy = {}; const pending = []; const clues = {};
  S.stops.forEach((s) => {
    if (s.state === 'cleared') clues[s.id] = { clue: s.nextClue, exitFlag: s.exitFlag };
    s.puzzles.forEach((p) => {
      const id = `${s.id}:${p.idx}`;
      if (p.solved) { solved.push(id); solvedBy[id] = p.solvedBy; }
      if (p.pending) pending.push(id);
    });
  });
  S.progress = { team: view.team, solved, solvedBy, pending, clues };
  syncWorldStops();
  renderAnnouncements();
  syncBonusMenu();
  if (view.team?.finishedAt && localStorage.getItem('kq-finish-seen') !== view.team.id) showFinish();
}

/** Beacons on the map: the base and every revealed location. Locked ones are greyed out. The bonus question has none. */
function syncWorldStops() {
  if (!S.world) return;
  const visible = S.stops.filter((s) => s.role !== 'bonus');
  const sig = visible.map((s) => `${s.id}|${s.lat}|${s.lng}|${s.radius}|${s.icon}|${stopTitle(s)}|${s.state}`).join(';');
  if (sig === S.mapSig) return;
  S.mapSig = sig;
  S.world.setStops(visible.map((s) => ({ ...s, place: stopTitle(s) })));
}

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
  const list = playStops();
  const needed = S.view?.hub?.needed ?? list.length;
  const done = list.filter(isComplete).length;
  $('#hudProgress').textContent = `${done} / ${needed}`;
  const dots = Array.from({ length: needed }, (_, i) => list[i]?.state ?? 'locked');
  $('#hudDots').innerHTML = dots.map((state) => `<b class="${state}"></b>`).join('');
  S.world?.refreshStops(Object.fromEntries(S.stops.map((s) => [s.id, isHub(s) ? 'hub' : s.state])), S.openId);
}

function renderGps() {
  const chip = $('#gpsChip');
  const accuracy = S.fix?.accuracy;
  const label = S.fix?.source === 'sim' ? 'SIM' : S.gps === 'ok' && Number.isFinite(accuracy) ? `±${Math.round(accuracy)} m` : S.gps === 'denied' || S.gps === 'insecure' ? 'OFF' : 'SEARCHING';
  chip.className = `chip gps ${S.fix?.source === 'sim' ? 'sim' : S.gps === 'ok' ? (accuracy <= 30 ? 'good' : 'weak') : S.gps === 'denied' || S.gps === 'insecure' ? 'bad' : 'wait'}`;
  $('#gpsText').textContent = label;
}

// ---------- status, announcements, safety ----------
const clockText = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
function renderStatus() {
  const el = $('#statusBanner');
  const g = S.view?.game;
  const skew = g?.now ? Date.parse(g.now) - Date.now() : 0;
  let html = '';
  if (g?.status === 'lobby') html = g.startsAt ? `⏳ The quest starts in <b>${clockText(Date.parse(g.startsAt) - (Date.now() + skew))}</b>` : '⏳ The quest has not started yet. Wait for the organisers.';
  else if (g?.status === 'paused') html = '⏸ The quest is paused by the organisers.';
  else if (g?.status === 'ended') html = '🏁 The quest has ended. <button type="button" data-action="open-board">See the results</button>';
  else if (g?.endsAt) { const left = Date.parse(g.endsAt) - (Date.now() + skew); if (left < 15 * 60_000) html = `⏱ <b>${clockText(left)}</b> left`; }
  el.hidden = !html;
  if (html && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function renderAnnouncements() {
  const latest = S.view?.announcements?.[0];
  const banner = $('#announceBanner');
  if (!latest || latest.id <= S.seenAnnounce) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.classList.toggle('warn', latest.level === 'warn');
  $('#announceText').textContent = `📣 ${latest.message}`;
  if (S.shownAnnounce !== latest.id) { S.shownAnnounce = latest.id; buzz([120, 80, 120]); toast('New message from the organisers'); }
}

function safetyCheck() {
  const g = S.view?.game;
  let message = '';
  if (S.fix && g) {
    if (g.bounds && distanceM(S.fix, g.bounds) > g.bounds.radius) message = '⚠ You are leaving the quest area. Please head back toward the campus.';
    for (const zone of g.noGo || []) if (distanceM(S.fix, zone) < zone.radius + 5) message = `⛔ Keep out: ${zone.label || 'restricted area'}. Please move away.`;
  }
  if (message === S.safetyMsg) return;
  S.safetyMsg = message;
  const el = $('#safetyBanner');
  el.hidden = !message; el.textContent = message;
  if (message) buzz([200, 100, 200]);
}

// ---------- nearest target ----------
function prevCleared(stop) {
  const prev = playStops().filter((s) => s.ord < stop.ord).at(-1);
  return !prev || isComplete(prev);
}
function nearestTarget() {
  if (!S.fix || !S.view?.team?.locked) return null;
  const hub = S.stops.find(isHub);
  const stops = S.stops.filter((s) => s.role === 'stop');
  let pool;
  if (!S.view.started && hub) pool = [hub];
  else {
    // Open locations to work on, plus the next one that can be unlocked by walking in. Otherwise: back to the base.
    pool = stops.filter((s) => s.state === 'open' || (s.state === 'locked' && s.available));
    const allCleared = stops.length > 0 && stops.every(isComplete);
    const handedAll = (S.view.hub?.entered?.length ?? 0) >= (S.view.hub?.needed ?? 0);
    const needsBase = stops.some((s) => isComplete(s) && !S.view.hub.entered.includes(s.id));
    if (!pool.length || needsBase || (allCleared && !handedAll)) pool = hub ? [hub, ...pool.filter((s) => s.state === 'open')] : pool;
  }
  if (!pool.length) return null;
  return pool.map((s) => ({ stop: s, dist: distanceTo(s) })).sort((a, b) => a.dist - b.dist)[0];
}

function renderNear() {
  const card = $('#nearCard');
  const target = nearestTarget();
  if (!target || S.openId) { card.hidden = true; return; }
  const { stop, dist } = target;
  const here = inRange(stop);
  card.hidden = false;
  card.dataset.stop = stop.id;
  card.classList.toggle('in-range', here);
  $('#nearKicker').textContent = here ? 'YOU ARE HERE · TAP TO OPEN' : isHub(stop) ? (S.view.started ? 'THE BASE' : 'CHECK IN AT THE BASE') : isUnlocked(stop) ? 'NEXT SIGNAL' : 'NEXT LOCATION';
  $('#nearName').textContent = stopTitle(stop);
  $('#nearDist').textContent = fmtDist(dist);
  const from = S.world?.shownPosition() || S.fix;
  // The ➤ glyph points east (90°) at rotate(0).
  $('#nearArrow').style.transform = `rotate(${bearingDeg(from, stop) - (S.world?.bearing() || 0) - 90}deg)`;
}

// ---------- sheets ----------
function rangeBanner(stop) {
  if (stop.role === 'bonus') return '';
  const range = inRange(stop);
  const sim = S.loc?.isSim();
  return range ? `<div class="range ok">✓ You're at ${esc(stopTitle(stop))}</div>`
    : `<div class="range far">⌖ ${fmtDist(distanceTo(stop))} away · get within ${radiusOf(stop)} m to interact. Bad GPS indoors? Scan the QR code posted at the spot.${sim ? ` <button type="button" class="link" data-action="teleport">Teleport (sim)</button>` : ''}</div>`;
}

function puzzleCard(stop, p, range) {
  const id = `${stop.id}:${p.idx}`;
  const solved = p.solved;
  const open = S.expanded === p.idx && !solved;
  const photoStage = p.kind === 'photo' && !p.photoCleared && !solved;
  const hasPhoto = S.photo?.id === id;
  const lock = range ? '' : 'disabled';
  const busy = S.busy ? 'disabled' : '';
  const tag = solved ? esc(memberName(p.solvedBy) || 'CLEARED') : p.pending ? 'IN REVIEW' : photoStage ? 'PHOTO' : 'ANSWER';
  let body = '';
  if (open && photoStage) {
    body = `<p class="clue-line">🔎 <b>Clue:</b> ${esc(p.prompt)}</p>
      <p class="loc-note">Find it, photograph it, and the real question appears.</p>
      ${p.pending ? '<div class="range far">⏳ An organiser is checking your photo. You can send another one if you like.</div>' : ''}
      <label class="photo-pick ${lock}">📷 ${hasPhoto ? 'Retake photo' : 'Take a photo'}<input id="photoInput" type="file" accept="image/*" capture="environment" ${lock} /></label>
      ${hasPhoto ? `<img class="photo-preview" src="${S.photo.url}" alt="Your photo" /><button class="primary-button" type="button" data-action="verify-photo" ${lock || busy}>${S.busy ? 'Checking…' : 'Send photo'}</button>` : ''}`;
  } else if (open) {
    body = `${p.kind === 'photo' ? '<span class="tick-tag">✓ Photo verified</span>' : ''}<p>${esc(p.kind === 'photo' ? p.question : p.prompt)}</p>
      <form class="flag-row" data-form="flag" data-idx="${p.idx}"><input class="flag-input" name="flag" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="KQ{...}" aria-label="Flag" ${lock} /><button class="small-action" type="submit" ${lock || busy}>Verify</button></form>`;
  }
  return `<article class="puzzle ${solved ? 'solved' : ''}">
    <button class="puzzle-head" type="button" data-action="expand" data-idx="${p.idx}" aria-expanded="${open}">
      <span class="puzzle-num">${solved ? '✓' : p.idx + 1}</span><strong>${esc(p.title)}</strong><small>${tag}</small></button>
    ${open ? `<div class="puzzle-body">${body}</div>` : ''}</article>`;
}

function locationCard(stop, index, range) {
  const title = stop.state === 'locked' ? `Location ${index + 1}` : stop.place;
  const chip = stop.state === 'cleared' ? 'CLEARED' : stop.state === 'open' ? 'UNLOCKED' : stop.available ? 'READY' : 'LOCKED';
  const handed = S.view.hub?.entered?.includes(stop.id);
  let detail;
  if (stop.state === 'cleared') detail = handed ? '<p class="loc-note">✓ Code handed in.</p>' : `<p class="loc-note">✓ Cleared. Your code: <code>${esc(stop.exitFlag)}</code>. Hand it in below to unlock the next location.</p>`;
  else if (stop.state === 'open') detail = '<p class="loc-note">Unlocked. Go there and solve its questions.</p>';
  else if (stop.entryMode === 'hub') {
    detail = `<p class="loc-hint">❓ ${esc(stop.entryQuestion)}</p>
      <form class="flag-row" data-form="hub-answer" data-stop="${esc(stop.id)}"><input class="flag-input" name="answer" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Answer" aria-label="Answer for location ${index + 1}" ${range ? '' : 'disabled'} /><button class="small-action" type="submit" ${range && !S.busy ? '' : 'disabled'}>Unlock</button></form>`;
  } else if (stop.available) detail = '<p class="loc-note">🔓 Ready. Find it and walk in: it unlocks automatically.</p>';
  else detail = `<p class="loc-note">🔒 Hand in the code from Location ${stop.prevOrd} below to make this location unlockable.</p>`;
  return `<article class="stop-card ${stop.state}"><div class="loc-head"><span class="loc-num">${stop.state === 'cleared' ? '✓' : index + 1}</span><strong>${esc(title)}</strong><span class="chip-s">${chip}</span></div>
    ${stop.hint ? `<p class="loc-hint">💡 ${esc(stop.hint)}</p>` : ''}${detail}</article>`;
}

function renderHubSheet(hub) {
  const v = S.view;
  const range = inRange(hub);
  S.rangeShown = range;
  const list = playStops();
  const needed = v.hub?.needed ?? list.length;
  const entered = v.hub?.entered ?? [];
  const bonus = S.stops.find((s) => s.role === 'bonus');
  let body = '';
  if (v.team.finishedAt) body += `<div class="finished-box">🏁 Quest complete! Time: ${clockText((Date.parse(v.team.finishedAt) - Date.parse(v.team.startedAt || v.team.finishedAt)))}</div>`;
  if (!v.started) {
    body += `<div class="gate"><h3>Check in at the base</h3><p>Every team starts here. Check in once your whole team is at the vending machine area: your clock starts and the locations appear.</p>
      <button class="primary-button" type="button" data-action="checkin" ${range && !S.busy ? '' : 'disabled'}>Check in</button></div>`;
  } else {
    body += `<div class="section-title">LOCATIONS · ${list.filter(isComplete).length} / ${needed} CLEARED</div>`;
    body += list.map((s, i) => locationCard(s, i, range)).join('');
    for (let i = list.length; i < needed; i += 1) body += `<article class="stop-card"><div class="loc-head"><span class="loc-num">${i + 1}</span><strong>Location ${i + 1}</strong><span class="chip-s">LOCKED</span></div><p class="loc-note">Its hint appears once you clear the location before it.</p></article>`;
    const allIn = entered.length >= needed && needed > 0;
    body += `<div class="handin"><h3>Hand in your location codes</h3>
      <p class="loc-note">Each cleared location gives you a code. Enter it here: it unlocks the next location. ${entered.length} / ${needed} handed in${allIn ? '. You have finished!' : '.'}</p>
      ${entered.length ? `<div class="handed">${entered.map((id) => `<span>✓ ${esc(S.stops.find((s) => s.id === id)?.place || id)}</span>`).join('')}</div>` : ''}
      ${allIn ? '' : `<form class="flag-row" data-form="hub-flag"><input class="flag-input" name="flag" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="KQ{...}" aria-label="Location code" ${range ? '' : 'disabled'} /><button class="small-action" type="submit" ${range && !S.busy ? '' : 'disabled'}>Hand in</button></form>`}</div>`;
    if (bonus) body += `<article class="stop-card ${bonus.state}"><div class="loc-head"><span class="loc-num">★</span><strong>Bonus question</strong><span class="chip-s">${bonus.state === 'cleared' ? 'DONE' : 'OPEN'}</span></div><p class="loc-note">${bonus.state === 'cleared' ? 'Answered. Nice work!' : 'An extra question for teams that found every location.'}</p>${bonus.state === 'cleared' ? '' : '<button class="primary-button" type="button" data-action="open-bonus">Answer the bonus question</button>'}</article>`;
    else body += '<article class="stop-card"><div class="loc-head"><span class="loc-num">★</span><strong>Bonus question</strong><span class="chip-s">SECRET</span></div><p class="loc-note">Hand in every location code to reveal it.</p></article>';
  }
  $('#sheetBody').innerHTML = `<div class="sheet-top"><span class="tag">${esc(hub.label || 'BASE')}</span><button class="close" type="button" data-action="close-sheet" aria-label="Close">×</button></div>
    <h2>${esc(hub.name)}</h2><p class="place">${esc(hub.icon)} ${esc(hub.place)}</p><p class="desc">${esc(hub.description)}</p>${rangeBanner(hub)}${body}`;
}

function renderStopSheet(stop) {
  const range = inRange(stop);
  S.rangeShown = range;
  const unlocked = isUnlocked(stop);
  const complete = isComplete(stop);
  const clue = S.progress.clues[stop.id];
  let body;
  if (!unlocked && stop.entryMode === 'hub') {
    body = `<div class="gate"><h3>Unlocked at the base</h3><p>This location opens when you answer its question at the vending machine area.</p><button class="primary-button" type="button" data-action="open-hub">Open the base</button></div>`;
  } else if (!unlocked && !stop.available) {
    body = `<div class="gate"><h3>🔒 Locked</h3><p>You must unlock this location first: hand in the code from <b>Location ${stop.prevOrd}</b> at the base (the vending machine area). Then come back and walk in.</p><button class="primary-button" type="button" data-action="open-hub">Open the base</button></div>`;
  } else if (!unlocked) {
    body = `<div class="gate"><h3>🔓 Ready to unlock</h3><p>${range ? 'You are here: unlocking…' : 'Walk into this location and it unlocks by itself.'}</p><button class="small-action" type="button" data-action="arrive-now" ${range && !S.busy ? '' : 'disabled'}>Unlock now</button></div>`;
  } else {
    const total = stop.puzzles.length || 1;
    body = `<div class="progress"><span>SIGNALS TO DECODE</span><b>${solvedCount(stop)} / ${stop.puzzles.length}</b></div>
      <div class="bar"><i style="width:${(solvedCount(stop) / total) * 100}%"></i></div>
      <div class="puzzles">${stop.puzzles.map((p) => puzzleCard(stop, p, range)).join('')}</div>
      ${complete && clue && clue.exitFlag ? `<div class="clue">${clue.clue ? `<small>NEXT CLUE</small><strong>“${esc(clue.clue)}”</strong>` : ''}<small>YOUR LOCATION CODE</small><code>${esc(clue.exitFlag)}</code>
        <p class="loc-note">Take this code to the base (the vending machine area) and hand it in: that unlocks the next location.</p></div>` : ''}`;
  }
  const hintLine = !unlocked && stop.hint ? `<p class="desc"><b>💡 Hint:</b> ${esc(stop.hint)}</p>` : `<p class="desc">${esc(stop.description)}</p>`;
  $('#sheetBody').innerHTML = `<div class="sheet-top"><span class="tag">${esc(stop.label)}</span><button class="close" type="button" data-action="close-sheet" aria-label="Close">×</button></div>
    <h2>${esc(unlocked ? stop.name : stopTitle(stop))}</h2><p class="place">${esc(stop.icon)} ${esc(stopTitle(stop))}</p>${hintLine}${rangeBanner(stop)}${body}`;
}

function renderSheet() {
  const sheet = $('#sheet');
  const stop = stopById(S.openId);
  sheet.classList.toggle('open', Boolean(stop));
  sheet.setAttribute('aria-hidden', String(!stop));
  document.body.classList.toggle('sheet-open', Boolean(stop));
  if (!stop) return;
  if (isHub(stop)) renderHubSheet(stop); else renderStopSheet(stop);
}

function openStop(id) {
  const stop = stopById(id);
  if (!stop) return;
  S.openId = id;
  const first = stop.puzzles.find((p) => !p.solved);
  S.expanded = first ? first.idx : -1;
  clearPhoto();
  renderSheet(); renderHud(); renderNear();
}
function closeSheet() { S.openId = null; clearPhoto(); renderSheet(); renderHud(); renderNear(); }
function clearPhoto() { if (S.photo?.url) URL.revokeObjectURL(S.photo.url); S.photo = null; }

/** Common tail for every action: show errors, adopt the fresh view, celebrate clears. */
function applyResult(stop, result, successMessage) {
  S.busy = false;
  if (!result.ok) { renderSheet(); toast(result.error || 'Something went wrong. Try again.'); return false; }
  const wasComplete = Boolean(stop && stop.state === 'cleared');
  applyView(result.view);
  const now = stop && stopById(stop.id);
  if (now) { const next = now.puzzles.find((p) => !p.solved); S.expanded = next ? next.idx : -1; }
  clearPhoto();
  renderSheet(); renderHud(); renderNear();
  if (result.pending) { toast(result.message || 'Sent for review.'); return true; }
  if (now && !wasComplete && now.state === 'cleared') { confetti(); toast(now.role === 'bonus' ? 'Bonus cleared!' : 'Location cleared! Your handoff flag is ready.'); }
  else if (successMessage) toast(successMessage);
  return true;
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
  if (action === 'open-hub') { const hub = S.stops.find(isHub); if (hub) openStop(hub.id); }
  if (action === 'open-board') openBoard();
  if (action === 'open-bonus') openBonus();
  if (action === 'arrive-now' && stop && !S.busy) await tryArrive(stop, true);
  if (action === 'checkin' && stop && !S.busy) {
    S.busy = true; renderSheet();
    applyResult(stop, await api.checkIn(S.fix), 'Checked in! The locations are now visible.');
  }
  if (action === 'verify-photo' && stop && S.photo && !S.busy) {
    S.busy = true; renderSheet();
    const result = await api.verifyPhoto(stop, S.expanded, S.photo.blob, S.fix);
    applyResult(stop, result, result.simulated ? 'Demo: photo accepted (simulated, not real AI). Your question is ready.' : 'Photo verified! Your question is ready.');
  }
});

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const stop = stopById(S.openId);
  if (!stop || S.busy) return;
  const kind = form.dataset.form;
  const data = new FormData(form);
  const value = data.get({ flag: 'flag', 'hub-answer': 'answer', 'hub-flag': 'flag' }[kind]);
  if (!String(value || '').trim()) return;
  S.busy = true; renderSheet();
  if (kind === 'hub-answer') { const target = stopById(form.dataset.stop); applyResult(stop, await api.hubAnswer(target, value, S.fix), 'Correct! That location is unlocked. Go find it.'); }
  else if (kind === 'hub-flag') {
    const result = await api.hubFlag(value, S.fix);
    if (!applyResult(stop, result, '')) return;
    const finished = result.have >= result.need;
    const next = playStops().find((s) => s.state === 'locked' && s.available);
    if (finished) { confetti(); toast('Every code is in! You finished the quest.'); }
    else toast(`✓ ${result.place} code accepted (${result.have}/${result.need}).${next ? ` Location ${next.ord} is now unlockable: go find it!` : ''}`);
  } else applyResult(stop, await api.submitFlag(stop, Number(form.dataset.idx), value, S.fix), 'Flag verified. One signal closer.');
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
$('#announceDismiss').addEventListener('click', () => {
  const latest = S.view?.announcements?.[0];
  if (latest) { S.seenAnnounce = latest.id; localStorage.setItem('kq-seen-announce', String(latest.id)); }
  $('#announceBanner').hidden = true;
});

// ---------- arriving at a location ----------
/** Walking into an available location unlocks it. Locked ones tell you what is missing. */
async function tryArrive(stop, manual = false) {
  if (S.arriving) return;
  S.arriving = true;
  S.arriveTried[stop.id] = Date.now();
  try {
    const result = await api.arrive(stop, S.fix);
    if (!result.ok) { if (manual) toast(result.error); return; }
    applyView(result.view);
    buzz([200, 100, 200]);
    confetti();
    toast(`🔓 Location unlocked: ${result.place || stop.place}!`);
    renderHud(); renderNear();
    if (!S.openId || S.openId === stop.id) openStop(stop.id);
  } finally { S.arriving = false; }
}

function checkArrivals() {
  if (!S.fix || !S.view?.started || S.view.game?.status !== 'running') { setLockNotice(''); return; }
  const here = S.stops.filter((s) => s.role === 'stop' && s.state === 'locked' && s.entryMode !== 'hub' && inRange(s));
  const ready = here.find((s) => s.available);
  if (ready && !S.busy && Date.now() - (S.arriveTried[ready.id] || 0) > 6000) tryArrive(ready);
  const blocked = here.find((s) => !s.available);
  setLockNotice(blocked ? `🔒 Location ${blocked.ord} is locked. You must unlock it first: hand in the code from Location ${blocked.prevOrd} at the base.` : '');
}
function setLockNotice(message) {
  if (message === S.lockMsg) return;
  S.lockMsg = message;
  const el = $('#lockBanner');
  el.hidden = !message; el.textContent = message;
  if (message) buzz(150);
}

// ---------- leaderboard, help, finish ----------
async function renderBoard() {
  try {
    const board = await api.leaderboard();
    const fmt = (r) => (r.finishedAt ? `🏁 ${clockText((r.elapsedSeconds || 0) * 1000)}` : `${r.flags} flags`);
    $('#boardTitle').textContent = board.status === 'ended' ? 'Final results' : 'Standings';
    $('#boardBody').innerHTML = board.rows.length ? board.rows.map((r) => `<div class="board-row ${r.teamId === board.me ? 'me' : ''}"><span class="pos">${r.rank}</span><span><strong>${esc(r.name)}</strong><small>${r.stopsCleared} locations · ${r.hubFlags} flags handed in · ${r.players} players</small></span><span class="time">${fmt(r)}</span></div>`).join('') : '<div class="empty">No teams yet.</div>';
  } catch (error) { $('#boardBody').textContent = 'Could not load the standings.'; console.warn(error); }
}
function openBoard() {
  $('#boardDialog').showModal();
  renderBoard();
  clearInterval(S.boardTimer);
  S.boardTimer = setInterval(renderBoard, 6000);
}
$('#boardDialog').addEventListener('close', () => clearInterval(S.boardTimer));

async function showFinish() {
  const team = S.view.team;
  localStorage.setItem('kq-finish-seen', team.id);
  confetti();
  let rank = '';
  try { const board = await api.leaderboard(); const row = board.rows.find((r) => r.teamId === team.id); if (row) rank = ` You finished <b>#${row.rank}</b> of ${board.rows.length}.`; } catch { /* the board is optional here */ }
  const took = team.startedAt ? clockText(Date.parse(team.finishedAt) - Date.parse(team.startedAt)) : '';
  $('#finishText').innerHTML = `${esc(team.name)} unlocked and cleared every location${took ? ` in <b>${took}</b>` : ''}.${rank} A bonus question is waiting.`;
  $('#finishBonus').hidden = !bonusStop();
  $('#finishDialog').showModal();
}
$('#finishDialog').addEventListener('close', () => {
  if ($('#finishDialog').returnValue === 'bonus') openBonus(); else openBoard();
});
function bonusStop() { return S.stops.find((s) => s.role === 'bonus' && s.state !== 'locked'); }
function openBonus() {
  const bonus = bonusStop();
  if (!bonus) { toast('The bonus question appears once every code is handed in.'); return; }
  openStop(bonus.id);
}
function syncBonusMenu() { $('#bonusMenu').hidden = !bonusStop(); }


$('#sosSend').addEventListener('click', async () => {
  const result = await api.requestHelp(S.fix, $('#sosMessage').value);
  $('#sosDialog').close();
  toast(result.ok ? 'Organisers have your location and are on their way.' : result.error);
});

// ---------- location ----------
let gpsPaintedAt = 0;
function onFix(fix) {
  S.fix = fix;
  S.world?.setFix(fix);
  if (performance.now() - gpsPaintedAt > 400) { gpsPaintedAt = performance.now(); renderGps(); }
}
function onStatus(status, detail) {
  S.gps = status;
  renderGps();
  const gate = $('#locGate');
  if (status === 'ok' || status === 'searching') gate.hidden = true;
  const copy = {
    denied: ['Location is blocked', 'Allow location for this site in your browser or phone settings (Safari: aA → Website Settings → Location; Chrome: lock icon → Permissions), then tap retry.'],
    insecure: ['Location needs a secure link', 'Phones only share location with https:// pages, and this one is plain http://, so no permission prompt can appear. Open the HTTPS link from your organisers.'],
    unavailable: ['No location signal', detail || 'Could not read your position. Check that location services are on.'],
    waiting: ['Waiting for your location', 'If your browser asked, tap Allow. Indoors, move near a window. You can retry the request below.'],
  }[status];
  if (!copy) return;
  gate.hidden = false;
  $('#locTitle').textContent = copy[0];
  $('#locCopy').textContent = copy[1];
  $('#locEnable').textContent = 'Retry';
  $('#locEnable').hidden = status === 'insecure';
}

function syncCompassChip() { $('#compassEnable').hidden = !(S.compass.needsGesture() || S.motion.needsGesture()); }

function startSimulator() {
  S.loc.startSim(S.fix || CONFIG.campus);
  $('#simPad').hidden = false;
  $('#simToggle').checked = true;
  $('#locGate').hidden = true;
}
function stopSimulator() {
  S.loc.stopSim();
  S.compass.clearInjected();
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
  let simFacing = 0;
  const keys = { w: [0, 1], arrowup: [0, 1], s: [0, -1], arrowdown: [0, -1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
  const held = new Map();
  addEventListener('keydown', (e) => {
    if ((e.key === 'q' || e.key === 'e') && S.loc?.isSim() && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) {
      simFacing = (simFacing + (e.key === 'e' ? 15 : -15) + 360) % 360; // stand-in for turning your phone
      S.compass.inject(simFacing);
      return;
    }
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
  applyView(result.view);
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

const stable = (view) => JSON.stringify(view && { ...view, game: { ...view.game, now: 0 } }); // the server clock changes every call
const solvedIds = (view) => (view.stops || []).flatMap((s) => s.puzzles.filter((p) => p.solved).map((p) => ({ id: `${s.id}:${p.idx}`, by: p.solvedBy, title: p.title })));
function announceTeamSolves(prev, next) {
  const before = new Set(solvedIds(prev).map((x) => x.id));
  const fresh = solvedIds(next).filter((x) => !before.has(x.id) && x.by !== next.team?.me);
  if (fresh.length) toast(`${memberName(fresh[0].by) || 'A teammate'} solved “${fresh[0].title}”.`);
}

// Polling backs off while nothing changes (4 s -> 10 s), so hundreds of idle phones put little load on the database.
let pollDelay = 4000;
function schedulePoll() { setTimeout(async () => { await pollProgress(); schedulePoll(); }, pollDelay); }
document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollDelay = 4000; pollProgress(); } });

async function pollProgress() {
  if (S.polling || document.hidden) return;
  S.polling = true;
  try {
    const next = await api.loadView();
    if (stable(next) === stable(S.view)) { pollDelay = Math.min(10_000, Math.round(pollDelay * 1.25)); return; }
    pollDelay = 4000;
    const prev = S.view || { stops: [], team: null };
    applyView(next);
    if (S.started) { announceTeamSolves(prev, next); renderHud(); renderNear(); renderStatus(); if (!typingInSheet()) renderSheet(); }
    if (!S.started || !$('#teamScreen').hidden || prev.team?.locked !== next.team?.locked) route();
  } catch (error) { console.warn('progress poll failed', error); }
  finally { S.polling = false; }
}

// ---------- QR codes ----------
/** A stop's printed QR opens ?qr=<stop>.<token>: scanning with the phone camera proves presence indoors. */
function captureQr() {
  const q = new URLSearchParams(location.search).get('qr');
  if (!q) return;
  sessionStorage.setItem('kq-qr', q);
  history.replaceState(null, '', location.pathname);
}
async function handleQr() {
  const q = sessionStorage.getItem('kq-qr');
  if (!q || !S.view?.team?.locked) return;
  sessionStorage.removeItem('kq-qr');
  const [stopId, token] = q.split('.');
  const result = await api.scanQr(stopId, token);
  if (!result.ok) { toast(result.error); return; }
  S.presence[stopId] = Date.now();
  applyView(result.view);
  toast(`Scanned ${result.place}. You count as being there for 15 minutes.`);
  if (stopById(stopId)) openStop(stopId);
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
    applyView(await api.loadView());
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
  schedulePoll();
  await route();
  if (!localStorage.getItem('kq-avatar')) $('#avatarDialog').showModal();
}

async function startGame() {
  S.started = true;
  showScreen('game');
  S.compass = createCompass();
  S.motion = createMotion();
  S.loc = createLocation({ onFix, onStatus, getHeading: () => S.compass.heading(), getMotion: () => S.motion.state() });
  S.compass.autoStart();
  S.motion.autoStart();
  $('#compassEnable').hidden = !(S.compass.needsGesture() || S.motion.needsGesture());
  try {
    S.world = await createWorld({ onStopTap: openStop, getCompass: () => S.compass.heading(), onViewChange: (offset) => { $('#viewReset').hidden = !offset; } });
  } catch (error) {
    console.error(error);
    S.started = false;
    toast('The live map could not load. Check your connection and reload.');
    return;
  }
  S.world.setAvatar(S.avatar);
  S.mapSig = '';
  syncWorldStops();
  if (S.fix) S.world.setFix(S.fix);
  renderHud(); renderGps(); renderStatus();
  setInterval(() => {
    syncWorldStops();
    renderNear();
    renderHud();
    renderStatus();
    safetyCheck();
    checkArrivals();
    // Re-render the sheet only when range flips, so typing in an input is never wiped.
    const stop = stopById(S.openId);
    if (stop && S.rangeShown !== inRange(stop) && !typingInSheet()) renderSheet();
  }, 1000);
  // Organisers see where players are: latest position only, every ~5 s.
  setInterval(() => { if (S.fix) api.sendLocation(S.fix).catch(() => {}); }, 5000);
  const needle = $('#compassNeedle');
  (function spin() { needle.style.transform = `rotate(${-(S.world.bearing() || 0)}deg)`; requestAnimationFrame(spin); })();

  startLocation();
  handleQr();
  navigator.wakeLock?.request('screen').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (!document.hidden) navigator.wakeLock?.request('screen').catch(() => {}); });
}

async function startLocation() {
  let state = 'prompt';
  try { state = (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { /* Safari: unknown */ }
  if (state === 'denied') { onStatus('denied'); return; }
  // Ask straight away: starting the watch is what makes the browser show its own Allow / Don't allow prompt.
  if (state === 'prompt') toast('Tap Allow when your browser asks for your location.');
  S.loc.startGps();
  // If nothing has arrived after a while, offer a manual retry instead of leaving a silent, empty map.
  setTimeout(() => { if (!S.fix && S.gps !== 'denied' && S.gps !== 'insecure') onStatus('waiting'); }, 9000);
}

function showLogin(error) {
  showScreen('login');
  const el = $('#loginError');
  el.hidden = !error; el.textContent = error || '';
}

async function boot() {
  captureQr();
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

$('#locEnable').addEventListener('click', () => { Promise.all([S.compass.request(), S.motion.request()]).then(syncCompassChip); $('#locGate').hidden = true; S.loc.stopGps(); S.loc.startGps(); });
$('#viewReset').addEventListener('click', () => S.world?.resetView());
$('#compassEnable').addEventListener('click', async () => {
  const [result] = await Promise.all([S.compass.request(), S.motion.request()]); // both permissions inside this one tap (iOS)
  syncCompassChip();
  if (result === 'denied') toast('Compass blocked. Allow Motion & Orientation for this site in Settings.');
  if (result === 'unsupported') toast('This device has no compass.');
});
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
  if (action === 'board') openBoard();
  if (action === 'bonus') openBonus();
  if (action === 'sos') $('#sosDialog').showModal();
  if (action === 'help') $('#helpDialog').showModal();
  if (action === 'reset' && confirm('Reset all demo progress on this device?')) { api.resetDemo(); location.reload(); }
  if (action === 'signout') { await api.signOut(); location.reload(); }
});

wireSimulator();
boot();
