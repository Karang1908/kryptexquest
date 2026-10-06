import { icon, gi, stopIcon, hydrateIcons } from './icons.js';
import { sfx, soundOn, setSound } from './sfx.js';
import { CONFIG } from './config.js';
import * as api from './api.js';
import { createLocation, distanceM, bearingDeg } from './geo.js';
import { createWorld } from './world.js';
import { createCompass } from './compass.js';
import { createMotion } from './motion.js';
import { compressImage } from './image.js';
import { installPromptWanted, showInstallGate } from './install.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// S.view is the server's (or demo engine's) one source of truth; S.stops / S.progress are conveniences derived from it.
const S = {
  started: false, viewTeam: false, polling: false,
  user: null, view: null, stops: [], progress: { team: null, solved: [], solvedBy: {}, pending: [], clues: {} },
  avatar: 'male', fix: null, gps: 'idle', world: null, loc: null,
  openId: null, photo: null, busy: false, presence: {}, mapSig: '', lockMsg: '', unlockTried: {}, unlocking: false,
  canRehearse: false, netFail: false, flushing: false,
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
const distanceTo = (stop) => (S.fix && stop.lat != null ? distanceM(S.fix, stop) : null);
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
const stopTitle = (stop) => (stop.role === 'stop' && stop.state === 'locked' ? `Location ${stop.ord}` : stop.place || `Location ${stop.ord}`);

function applyView(view) {
  S.view = view;
  S.stops = (view.stops || []).filter((s) => s.role !== 'bonus');   // there is no bonus question
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
  syncMenu();
  if (view.team?.finishedAt && localStorage.getItem('kq-finish-seen') !== view.team.id) showFinish();
}

/** Beacons on the map: the base and every location this team has DISCOVERED (grey locked, blue unlocked, green cleared). The rest stay hidden. */
function syncWorldStops() {
  if (!S.world) return;
  const visible = S.stops.filter((s) => s.role !== 'bonus' && s.discovered && s.lat != null);
  const sig = visible.map((s) => `${s.id}|${s.lat}|${s.lng}|${s.radius}|${s.icon}|${stopTitle(s)}|${s.state}`).join(';');
  if (sig === S.mapSig) return;
  S.mapSig = sig;
  S.world.setStops(visible.map((s) => ({ ...s, place: stopTitle(s) })));
}

/** Quest banner: a medal and a line, with a sound. kind: info | discover | unlock | win | warn */
const TOAST = { info: [null, 'blue', null], discover: ['position-marker', 'yellow', 'discover'], unlock: ['padlock-open', 'green', 'unlock'], win: ['star-medal', 'yellow', 'success'], coins: ['gems', 'blue', 'coins'], warn: ['ringing-bell', 'red', 'error'] };
function toast(message, kind = 'info') {
  const el = $('#toast');
  const [iconName, tone, sound] = TOAST[kind] || TOAST.info;
  el.innerHTML = `${iconName ? `<span class="medal ${tone}" style="--s:34px">${gi(iconName)}</span>` : ''}<span class="t-text"></span>`;
  el.querySelector('.t-text').textContent = message;
  el.className = `toast show ${kind}`;
  if (sound) sfx(sound);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

/** A reward moment: a medal or chest pops up with rays and a loot line. Resolves when the player taps OK. */
function showReward({ title, sub = '', art, loot = '', sound = 'cleared', button = 'Awesome!' }) {
  return new Promise((resolve) => {
    const d = $('#rewardDialog');
    $('#rewardArt').innerHTML = art;
    $('#rewardTitle').textContent = title;
    $('#rewardSub').textContent = sub;
    const lootEl = $('#rewardLoot');
    lootEl.hidden = !loot; lootEl.innerHTML = loot;
    $('#rewardOk').textContent = button;
    if (d.open) d.close();
    d.showModal();
    sfx(sound); confetti(); buzz([120, 60, 120, 60, 200]);
    const done = () => { d.close(); $('#rewardOk').removeEventListener('click', done); resolve(); };
    $('#rewardOk').addEventListener('click', done);
    setTimeout(() => d.querySelector('.reward-art')?.classList.add('open'), 450);
  });
}
const chestArt = () => '<img class="chest closed" src="./assets/art/chest-closed.svg" alt="" /><img class="chest opened" src="./assets/art/chest-open.svg" alt="" />';
const medalArt = (name, tone = 'yellow') => `<span class="medal ${tone} big" style="--s:132px">${gi(name)}</span>`;

function confetti() {
  const host = $('#confetti');
  const colors = ['#8b6cf0', '#EA4335', '#FBBC05', '#34A853'];
  host.innerHTML = Array.from({ length: 36 }, (_, i) => `<i style="left:${Math.random() * 100}%;background:${colors[i % 4]};animation-delay:${Math.random() * 0.35}s;--dx:${(Math.random() - 0.5) * 160}px"></i>`).join('');
  setTimeout(() => { host.innerHTML = ''; }, 2400);
}

// ---------- HUD ----------
function renderHud() {
  const list = playStops();
  const needed = S.view?.hub?.needed ?? list.length;
  const done = list.filter(isComplete).length;
  $('#hudProgress').textContent = `${done} / ${needed}`;
  // One gem per location: a tappable shortcut to every location the team has found, from anywhere.
  const gems = Array.from({ length: needed }, (_, i) => list.find((s) => s.ord === i + 1) ?? { ord: i + 1, state: 'locked', discovered: false });
  $('#hudDots').innerHTML = gems.map((g) => (g.id && g.discovered
    ? `<button type="button" class="gem ${g.state}" data-gem="${esc(g.id)}" aria-label="Open ${esc(stopTitle(g))}">${g.state === 'cleared' ? icon('check') : g.ord}</button>`
    : `<b class="gem hidden" aria-hidden="true">?</b>`)).join('');
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
  const g = S.view?.team?.isTest ? { status: 'running' } : S.view?.game;
  $('#testBadge').hidden = !S.view?.team?.isTest;
  const skew = g?.now ? Date.parse(g.now) - Date.now() : 0;
  let html = '';
  if (g?.status === 'lobby') html = g.startsAt ? `${icon('clock')} The quest starts in <b>${clockText(Date.parse(g.startsAt) - (Date.now() + skew))}</b>` : `${icon('clock')} The quest has not started yet. Wait for the organisers.`;
  else if (g?.status === 'paused') html = `${icon('clock')} The quest is paused by the organisers.`;
  else if (g?.status === 'ended') html = `${icon('flag')} The quest has ended. <button type="button" data-action="open-board">See the results</button>`;
  else if (g?.endsAt) { const left = Date.parse(g.endsAt) - (Date.now() + skew); if (left < 15 * 60_000) html = `${icon('clock')} <b>${clockText(left)}</b> left`; }
  el.hidden = !html;
  if (html && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function renderAnnouncements() {
  const latest = S.view?.announcements?.[0];
  const banner = $('#announceBanner');
  if (!latest || latest.id <= S.seenAnnounce) { banner.hidden = true; return; }
  banner.hidden = false;
  banner.classList.toggle('warn', latest.level === 'warn');
  $('#announceText').textContent = `${latest.message}`;
  if (S.shownAnnounce !== latest.id) { S.shownAnnounce = latest.id; buzz([120, 80, 120]); toast('New message from the organisers'); }
}

function safetyCheck() {
  const g = S.view?.game;
  let message = '';
  if (S.fix && g) {
    if (g.bounds && distanceM(S.fix, g.bounds) > g.bounds.radius) message = 'You are leaving the quest area. Please head back toward the campus.';
    for (const zone of g.noGo || []) if (distanceM(S.fix, zone) < zone.radius + 5) message = `Keep out: ${zone.label || 'restricted area'}. Please move away.`;
  }
  if (message === S.safetyMsg) return;
  S.safetyMsg = message;
  const el = $('#safetyBanner');
  el.hidden = !message; el.textContent = message;
  if (message) buzz([200, 100, 200]);
}

// ---------- nearest target ----------
function nearestTarget() {
  if (!S.fix || !S.view?.team?.locked) return null;
  const hub = S.stops.find(isHub);
  const stops = S.stops.filter((s) => s.role === 'stop');
  let pool;
  if (!S.view.started && hub) pool = [hub];
  else {
    // Only places the team already knows: the base, and discovered locations that are open or ready to be unlocked.
    pool = stops.filter((s) => s.discovered && (s.state === 'open' || (s.state === 'locked' && s.released)));
    const needsBase = stops.some((s) => isComplete(s) && !S.view.hub.entered.includes(s.id)) || (stops.length > 0 && stops.every(isComplete) && S.view.hub.entered.length < S.view.hub.needed);
    if (hub && (!pool.length || needsBase)) pool = [hub, ...pool.filter((s) => s.state === 'open')];
  }
  if (!pool.length) return null;
  return pool.map((s) => ({ stop: s, dist: distanceTo(s) })).sort((a, b) => a.dist - b.dist)[0];
}

/** Nothing known to walk to: remind the team of the hint for the next location they have to find. */
function nextHint() {
  if (!S.view?.started) return null;
  return playStops().filter((s) => s.released && !s.discovered).sort((a, b) => a.ord - b.ord)[0] ?? null;
}

function renderNear() {
  const card = $('#nearCard');
  const target = S.openId ? null : nearestTarget();
  const hint = !target && !S.openId ? nextHint() : null;
  if (!target && !hint) { card.hidden = true; return; }
  card.hidden = false;
  card.classList.toggle('hint-only', Boolean(hint));
  if (hint) {
    card.dataset.stop = S.stops.find(isHub)?.id ?? '';
    card.classList.remove('in-range');
    $('#nearKicker').textContent = `FIND LOCATION ${hint.ord}`;
    $('#nearName').textContent = hint.hint || 'Explore the campus';
    $('#nearDist').textContent = '';
    return;
  }
  const { stop, dist } = target;
  const here = inRange(stop);
  card.dataset.stop = stop.id;
  card.classList.toggle('in-range', here);
  $('#nearKicker').textContent = here ? 'YOU ARE HERE · TAP TO OPEN' : isHub(stop) ? (S.view.started ? 'THE BASE' : 'CHECK IN AT THE BASE') : isUnlocked(stop) ? 'NEXT SIGNAL' : 'DISCOVERED';
  $('#nearName').textContent = stopTitle(stop);
  $('#nearDist').textContent = fmtDist(dist);
  const from = S.world?.shownPosition() || S.fix;
  // The arrow icon points north at rotate(0).
  $('#nearArrow').style.transform = `rotate(${bearingDeg(from, stop) - (S.world?.bearing() || 0)}deg)`;
}

// ---------- sheets ----------
function rangeBanner(stop) {
  if (stop.role === 'bonus') return '';
  // Unlocked locations can be worked on from anywhere; being there only matters for unlocking.
  if (stop.role === 'stop' && isUnlocked(stop)) return `<div class="range ok">${icon('check')} Unlocked · you can answer from anywhere</div>`;
  const range = inRange(stop);
  const sim = S.loc?.isSim();
  return range ? `<div class="range ok">${icon('check')} You're at ${esc(stopTitle(stop))}</div>`
    : `<div class="range far">${icon('pin')} ${fmtDist(distanceTo(stop))} away · get within ${radiusOf(stop)} m to interact. Bad GPS indoors? Scan the QR code posted at the spot.${sim ? ` <button type="button" class="link" data-action="teleport">Teleport (sim)</button>` : ''}</div>`;
}

/**
 * One question. The real question lives on an external page: the game shows its title and a link, and takes the flag.
 * Photo questions show the clue first; the title and link appear once the photo is verified. Questions open in order: the next one unlocks when the previous is solved.
 */
function puzzleCard(stop, p) {
  if (p.locked) {
    return `<article class="puzzle locked"><div class="puzzle-head"><span class="puzzle-num">${p.idx + 1}</span><strong>Question ${p.idx + 1}</strong><small>${icon('lock')} LOCKED</small></div></article>`;
  }
  const busy = S.busy ? 'disabled' : '';
  const image = p.kind === 'photo';
  const tag = p.solved ? esc(memberName(p.solvedBy) || 'SOLVED') : p.pending ? 'IN REVIEW' : image ? 'IMAGE' : 'FLAG';
  let body = '';
  if (p.solved) body = '';
  else if (image) body = photoPicker(`${stop.id}:${p.idx}`, p.idx, { clue: p.prompt, pending: p.pending, note: 'Find it and photograph it. The photo is checked automatically and the question is solved when it matches.' });
  else {
    body = `${p.prompt ? `<p class="q-note">${esc(p.prompt)}</p>` : ''}
      ${p.questionUrl ? `<a class="q-link" href="${esc(p.questionUrl)}" target="_blank" rel="noopener noreferrer">Open the question ${icon('out')}</a>` : '<p class="loc-note">The question link is not set yet. Ask an organiser.</p>'}
      <form class="flag-row" data-form="flag" data-idx="${p.idx}"><input class="flag-input" name="flag" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="GDG{...}" aria-label="Flag for ${esc(p.title)}" /><button class="small-action" type="submit" ${busy}>Submit</button></form>`;
  }
  return `<article class="puzzle ${p.solved ? 'solved' : ''} ${image && !p.solved ? 'photo' : ''}">
    <div class="puzzle-head"><span class="puzzle-num">${p.solved ? icon('check') : p.idx + 1}</span><strong>${esc(p.title)}</strong><small>${tag}</small></div>
    ${body ? `<div class="puzzle-body">${body}</div>` : ''}</article>`;
}

/** Clue, camera button, preview and send button for an image question (idx >= 0) or a location's unlock photo (idx -1). */
function photoPicker(id, idx, { clue, pending, note, disabled = false }) {
  const hasPhoto = S.photo?.id === id;
  const busy = S.busy || disabled ? 'disabled' : '';
  return `${clue ? `<p class="clue-line">${icon('eye')} <b>Clue:</b> ${esc(clue)}</p>` : ''}
      <p class="loc-note">${note}</p>
      ${pending ? `<div class="range far">${icon('clock')} An organiser is checking your photo. You can send another one if you like.</div>` : ''}
      <label class="photo-pick ${disabled ? 'off' : ''}">${icon('camera')} ${hasPhoto ? 'Retake photo' : 'Take a photo'}<input class="photo-input" data-idx="${idx}" type="file" accept="image/*" capture="environment" ${disabled ? 'disabled' : ''} /></label>
      ${hasPhoto ? `<img class="photo-preview" src="${S.photo.url}" alt="Your photo" /><button class="primary-button" type="button" data-action="verify-photo" data-idx="${idx}" ${busy}>${S.busy ? 'Checking…' : 'Send photo'}</button>` : ''}`;
}

/** The unlock question: its text, plus a link to the real question page when the organiser set one. */
const entryLink = (stop) => (stop.entryUrl ? `<a class="q-link" href="${esc(stop.entryUrl)}" target="_blank" rel="noopener noreferrer">Open the question ${icon('out')}</a>` : '');
function locationCard(stop, index, range) {
  const title = stop.state === 'locked' ? `Location ${index + 1}` : stop.place;
  const chip = stop.state === 'cleared' ? 'CLEARED' : stop.state === 'open' ? 'UNLOCKED' : stop.discovered ? 'DISCOVERED' : stop.released ? 'TO FIND' : 'LOCKED';
  const handed = S.view.hub?.entered?.includes(stop.id);
  const lines = [];
  if (stop.released && stop.hint) lines.push(`<p class="loc-hint">${icon('bulb')} ${esc(stop.hint)}</p>`);
  if (stop.state === 'cleared') lines.push(handed ? `<p class="loc-note">${icon('check')} Code handed in.</p>` : `<p class="loc-note">${icon('check')} Cleared. Your code: <code>${esc(stop.exitFlag)}</code>. Hand it in below to release the next location.</p>`);
  else if (stop.state === 'open') lines.push('<p class="loc-note">Unlocked. Solve its questions there.</p>');
  else if (stop.released) {
    if (stop.entryQuestion) lines.push(`<p class="loc-hint">${icon('note')} ${esc(stop.entryQuestion)}</p>${entryLink(stop)}<p class="loc-note">${stop.entryKind === 'photo' ? 'Photograph it when you are there to unlock this location.' : "The answer is this location's entry flag. Type it when you are there."}</p>`);
    else if (stop.entryFlag) lines.push(`<p class="loc-note">Entry flag: <code>${esc(stop.entryFlag)}</code>. Type it when you are there.</p>`);
    lines.push(`<p class="loc-note">${stop.discovered ? `${icon('pin')} Discovered. Go back and unlock it.` : `${icon('radar')} Not found yet. Explore the campus.`}</p>`);
  } else lines.push(`<p class="loc-note">${icon('lock')} Hand in the code from Location ${stop.prevOrd} below to get this location's hint and entry question.${stop.discovered ? ' (You already found it, so it stays on your map.)' : ''}</p>`);
  return `<article class="stop-card ${stop.state}"><div class="loc-head"><span class="loc-num">${stop.state === 'cleared' ? icon('check') : index + 1}</span><strong>${esc(title)}</strong><span class="chip-s">${chip}</span></div>${lines.join('')}</article>`;
}

/** The base: it shows ONE hint and question (the next location to find), what the team has already found, and the hand-in slot. */
function renderHubSheet(hub) {
  const v = S.view;
  const range = inRange(hub);
  S.rangeShown = range;
  const list = playStops();
  const needed = v.hub?.needed ?? list.length;
  const entered = v.hub?.entered ?? [];
  const next = list.filter((s) => s.released && !isComplete(s)).sort((a, b) => a.ord - b.ord)[0];
  const found = list.filter((s) => s.discovered && s !== next).sort((a, b) => a.ord - b.ord);
  let body = '';
  if (!v.started) {
    body += `<div class="gate"><h3>Check in at the base</h3><p>Every team starts here. Check in once your whole team is at the vending machine area: your clock starts and your first hint appears.</p>
      <button class="primary-button" type="button" data-action="checkin" ${range && !S.busy ? '' : 'disabled'}>Check in</button></div>`;
  } else {
    if (next) {
      const status = next.state === 'open' ? 'Unlocked. Solve its questions, then bring the code back here.' : next.discovered ? `${icon('pin')} You found it. Go back to it and enter the entry flag.` : `${icon('radar')} Not found yet. Explore the campus.`;
      body += `<div class="section-title">Your next location</div>
        <article class="stop-card next ${next.state}"><div class="loc-head"><span class="loc-num">${next.ord}</span><strong>${next.discovered ? esc(next.place) : `Location ${next.ord}`}</strong><span class="chip-s">${next.state === 'open' ? 'UNLOCKED' : next.discovered ? 'FOUND' : 'TO FIND'}</span></div>
        ${next.hint ? `<p class="loc-hint">${icon('bulb')} ${esc(next.hint)}</p>` : ''}
        ${next.entryQuestion ? `<p class="loc-hint">${icon('note')} ${esc(next.entryQuestion)}</p>${entryLink(next)}<p class="loc-note">${next.entryKind === 'photo' ? 'Photograph it when you are there to unlock this location.' : "The answer is this location's entry flag. Type it when you are there."}</p>` : next.entryFlag ? `<p class="loc-note">Entry flag: <code>${esc(next.entryFlag)}</code>. Type it when you are there.</p>` : ''}
        <p class="loc-note">${status}</p></article>`;
    } else if (entered.length < needed) {
      body += `<div class="section-title">Your next location</div><article class="stop-card"><p class="loc-note">${icon('lock')} Hand in the code you are holding to get your next hint.</p></article>`;
    }
    if (v.surprise) {
      const q = v.surprise;
      body = `<article class="stop-card surprise ${q.solved ? 'cleared' : ''}"><div class="loc-head"><span class="loc-num">${icon('star')}</span><strong>Surprise question</strong><span class="chip-s">${q.solved ? 'SOLVED' : 'NEW'}</span></div>
        <p class="loc-hint">${icon('note')} ${esc(q.title)}</p>${q.url ? `<a class="q-link" href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">Open the question ${icon('out')}</a>` : ''}
        ${q.solved ? `<p class="loc-note">${icon('check')} Your team solved it.</p>` : `<form class="flag-row" data-form="surprise" data-id="${q.id}"><input class="flag-input" name="flag" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="GDG{...}" aria-label="Surprise question flag" ${range ? '' : 'disabled'} /><button class="primary-button" type="submit" ${range && !S.busy ? '' : 'disabled'}>Answer</button></form>${range ? '' : '<p class="loc-note">Answer it from the base.</p>'}`}</article>` + body;
    }
    if (found.length) body += `<div class="section-title">Locations you found</div>${found.map((s) => locationCard(s, s.ord - 1, range)).join('')}`;
    const allIn = entered.length >= needed && needed > 0;
    body += `<div class="handin"><h3>Hand in your location codes</h3>
      <p class="loc-note">Each cleared location gives you a code. Enter it here to get your next hint. ${entered.length} / ${needed} handed in${allIn ? '. You have finished!' : '.'}</p>
      ${entered.length ? `<div class="handed">${entered.map((id) => `<span>${icon('check')} ${esc(S.stops.find((x) => x.id === id)?.place || id)}</span>`).join('')}</div>` : ''}
      ${allIn ? '' : `<form class="flag-row" data-form="hub-flag"><input class="flag-input" name="flag" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="GDG{...}" aria-label="Location code" ${range ? '' : 'disabled'} /><button class="small-action" type="submit" ${range && !S.busy ? '' : 'disabled'}>Hand in</button></form>`}</div>`;
  }
  $('#sheetBody').innerHTML = `<div class="sheet-top"><button class="close" type="button" data-action="close-sheet" aria-label="Close">${icon('x')}</button></div>
    <h2>${esc(hub.name)}</h2><p class="place">${stopIcon(hub)} ${esc(hub.place)}</p><p class="desc">${esc(hub.description)}</p>${rangeBanner(hub)}${body}`;
}

function renderStopSheet(stop) {
  const range = inRange(stop);
  S.rangeShown = range;
  const unlocked = isUnlocked(stop);
  const complete = isComplete(stop);
  const clue = S.progress.clues[stop.id];
  let body;
  if (!unlocked && !stop.released) {
    body = `<div class="gate"><h3>${icon('lock')} Locked</h3><p>You found it, but locations must be unlocked <b>in order</b>. Hand in the code from <b>Location ${stop.prevOrd}</b> at the base (the vending machine area) to get this location's hint and entry question. It stays on your map.</p><button class="primary-button" type="button" data-action="open-hub">Open the base</button></div>`;
  } else if (!unlocked) {
    body = `<div class="gate"><h3>${icon('unlock')} Ready to unlock</h3>
      ${stop.entryQuestion ? `<p class="loc-hint">${icon('note')} ${esc(stop.entryQuestion)}</p>${entryLink(stop)}` : stop.entryFlag ? `<p>Your entry flag: <code>${esc(stop.entryFlag)}</code></p>` : ''}
      ${stop.needsPhoto ? photoPicker(`${stop.id}:-1`, -1, { clue: null, pending: stop.entryPending, note: 'Photograph it here to unlock this location. The photo is checked automatically.', disabled: !range }) : stop.needsFlag ? `<p class="loc-note">Type this location's entry flag to unlock it.</p>
      <form class="flag-row" data-form="unlock"><input class="flag-input" name="gate" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="GDG{ENTRY_FLAG}" aria-label="Entry flag" ${range ? '' : 'disabled'} /><button class="small-action" type="submit" ${range && !S.busy ? '' : 'disabled'}>Unlock</button></form>`
      : '<p class="loc-note">No flag needed: it unlocks by itself.</p>'}</div>`;
  } else {
    const total = stop.puzzles.length || 1;
    body = `<div class="progress"><span class="engrave">Signals to decode</span><b class="digits">${solvedCount(stop)} / ${stop.puzzles.length}</b></div>
      <div class="bar"><i style="width:${(solvedCount(stop) / total) * 100}%"></i></div>
      <div class="puzzles">${stop.puzzles.map((p) => puzzleCard(stop, p)).join('')}</div>
      ${complete && clue && clue.exitFlag ? `<div class="clue">${clue.clue ? `<small>NEXT CLUE</small><strong>“${esc(clue.clue)}”</strong>` : ''}<small>YOUR LOCATION CODE</small><code>${esc(clue.exitFlag)}</code>
        <p class="loc-note">Take this code to the base (the vending machine area) and hand it in: that unlocks the next location.</p></div>` : ''}`;
  }
  const hintLine = !unlocked && stop.hint ? `<p class="desc"><b>${icon('bulb')} Hint:</b> ${esc(stop.hint)}</p>` : `<p class="desc">${esc(stop.description || '')}</p>`;
  $('#sheetBody').innerHTML = `<div class="sheet-top"><button class="close" type="button" data-action="close-sheet" aria-label="Close">${icon('x')}</button></div>
    <h2>${esc(unlocked ? stop.name : stopTitle(stop))}</h2>${unlocked ? `<p class="place">${stopIcon(stop)} ${esc(stopTitle(stop))}</p>` : ''}${hintLine}${rangeBanner(stop)}${body}`;
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
  if (S.openId !== id) sfx('open');
  S.openId = id;
  clearPhoto();
  renderSheet(); renderHud(); renderNear();
}
function closeSheet() {
  sfx('close'); S.openId = null; clearPhoto(); renderSheet(); renderHud(); renderNear(); }
function clearPhoto() { if (S.photo?.url) URL.revokeObjectURL(S.photo.url); S.photo = null; }

/** Common tail for every action: show errors, adopt the fresh view, celebrate clears. */
const successKind = (message) => (/unlocked/i.test(message) ? 'unlock' : /verified|closer|accepted|checked in/i.test(message) ? 'win' : 'info');
function applyResult(stop, result, successMessage) {
  S.busy = false;
  if (!result.ok) { renderSheet(); toast(result.error || 'Something went wrong. Try again.', 'warn'); return false; }
  const wasComplete = Boolean(stop && stop.state === 'cleared');
  applyView(result.view);
  const now = stop && stopById(stop.id);
  clearPhoto();
  renderSheet(); renderHud(); renderNear();
  if (result.pending) { toast(result.message || 'Sent for review.'); return true; }
  if (now && !wasComplete && now.state === 'cleared') {
    const clue = S.progress.clues[now.id];
    showReward({ title: 'Location cleared!', sub: `${now.place} is done. Take your code to the base to unlock the next location.`, art: chestArt(), loot: clue?.exitFlag ? `<span class="engrave">Your location code</span><code>${esc(clue.exitFlag)}</code>` : '', sound: 'cleared' });
  }
  else if (successMessage) toast(successMessage, successKind(successMessage));
  return true;
}

// ---------- events ----------
document.addEventListener('click', (event) => { if (event.target.closest('button:not(:disabled), .q-link, .photo-pick, .google-button')) sfx('tap', 0.35); }, true);
$('#soundToggle').checked = soundOn();
$('#soundToggle').addEventListener('change', (e) => { setSound(e.target.checked); if (e.target.checked) sfx('success'); });

document.addEventListener('click', (event) => { const g = event.target.closest('[data-gem]'); if (g) openStop(g.dataset.gem); });

document.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const stop = stopById(S.openId);
  if (action === 'close-sheet') closeSheet();
  if (action === 'teleport' && stop) { S.loc.teleport(stop); toast(`Teleported to ${stop.place}.`); }
  if (action === 'open-hub') { const hub = S.stops.find(isHub); if (hub) openStop(hub.id); }
  if (action === 'open-board') openBoard();
  if (action === 'checkin' && stop && !S.busy) {
    S.busy = true; renderSheet();
    applyResult(stop, await api.checkIn(S.fix), 'Checked in! The locations are now visible.');
  }
  if (action === 'verify-photo' && stop && S.photo && !S.busy && S.photo.id === `${stop.id}:${el.dataset.idx}`) {
    S.busy = true; renderSheet();
    const result = await api.verifyPhoto(stop, Number(el.dataset.idx), S.photo.blob, S.fix);
    const unlockPhoto = Number(el.dataset.idx) === -1;
    if (applyResult(stop, result, unlockPhoto ? `${stop.place || stop.name || 'Location'} unlocked!` : result.simulated ? 'Demo: photo accepted (simulated, not real AI). Question solved.' : 'Photo verified! Question solved.') && unlockPhoto && !result.pending) { buzz([200, 100, 200]); confetti(); }
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
  const value = data.get({ flag: 'flag', unlock: 'gate', 'hub-flag': 'flag', surprise: 'flag' }[kind]);
  if (!String(value || '').trim()) return;
  S.busy = true; renderSheet();
  if (kind === 'unlock') applyResult(stop, await api.unlock(stop, value, S.fix), `${stop.name || 'Location'} unlocked!`);
  else if (kind === 'surprise') {
    const result = await api.submitSurprise(Number(form.dataset.id), value);
    if (applyResult(stop, result, '')) { confetti(); toast('Surprise question solved!', 'win'); }
  } else if (kind === 'hub-flag') {
    const result = await api.hubFlag(value, S.fix);
    if (!applyResult(stop, result, '')) return;
    const finished = result.have >= result.need;
    const next = playStops().filter((s) => s.released && s.state === 'locked').sort((a, b) => a.ord - b.ord)[0];
    if (finished) { confetti(); toast('Every code is in! You finished the quest.', 'win'); }
    else toast(`${result.place} code accepted (${result.have}/${result.need}).${next ? ` Location ${next.ord}'s hint and question are now in the base list.` : ''}`, 'coins');
  } else {
    const idx = Number(form.dataset.idx);
    const result = await api.submitFlag(stop, idx, value, S.fix);
    if (result.offline) { S.busy = false; queueFlag(stop, idx, String(value)); renderSheet(); return; }
    applyResult(stop, result, 'Flag verified. One signal closer.');
  }
});

document.addEventListener('change', async (event) => {
  if (!event.target.classList.contains('photo-input')) return;
  const file = event.target.files?.[0];
  if (!file || !file.type.startsWith('image/')) { toast('Choose an image to continue.'); return; }
  const blob = await compressImage(file);
  clearPhoto();
  S.photo = { id: `${S.openId}:${event.target.dataset.idx}`, blob, url: URL.createObjectURL(blob) };
  renderSheet();
});

$('#nearCard').addEventListener('click', () => openStop($('#nearCard').dataset.stop));
$('#announceDismiss').addEventListener('click', () => {
  const latest = S.view?.announcements?.[0];
  if (latest) { S.seenAnnounce = latest.id; localStorage.setItem('kq-seen-announce', String(latest.id)); }
  $('#announceBanner').hidden = true;
});

// ---------- discovering locations ----------
/** The server tells us (in the location ping) which hidden locations this team just walked into. */
async function onDiscovered(found) {
  try { applyView(await api.loadView()); } catch (error) { console.warn(error); return; }
  const first = found[0];
  const stop = stopById(first.id);
  buzz([150, 80, 150]);
  confetti();
  const more = found.length > 1 ? ` (and ${found.length - 1} more)` : '';
  if (!stop) { toast(`Location discovered!${more}`, 'discover'); return; }
  toast(`Location discovered: Location ${stop.ord}!${more} ${stop.released ? (stop.needsPhoto ? 'Photograph it to unlock it.' : 'Enter its entry flag to unlock it.') : 'It is locked: unlock locations in order.'}`, 'discover');
  renderHud(); renderNear();
  S.promptedFor = stop.id;   // the card opens now; do not pop it open again when it is closed
  if (!S.openId) openStop(stop.id);
}

/** No flag set for a released location: discovering it is enough to unlock it. */
async function autoUnlock() {
  if (S.unlocking || !S.fix || (S.view?.game?.status !== 'running' && !S.view?.team?.isTest)) return;
  const stop = S.stops.find((s) => s.role === 'stop' && s.discovered && s.state === 'locked' && s.released && !s.needsFlag && !s.needsPhoto && inRange(s));
  if (!stop || Date.now() - (S.unlockTried[stop.id] || 0) < 8000) return;
  S.unlockTried[stop.id] = Date.now(); S.unlocking = true;
  try {
    const result = await api.unlock(stop, '', S.fix);
    if (result.ok) { applyView(result.view); buzz([200, 100, 200]); confetti(); toast(`Location unlocked: ${result.place || stop.place}!`, 'unlock'); renderHud(); renderNear(); openStop(stop.id); }
  } finally { S.unlocking = false; }
}

/** Standing in a discovered, still-locked location: say what is missing. */
function checkNotices() {
  if (!S.fix || !S.view?.started || (S.view.game?.status !== 'running' && !S.view.team?.isTest)) { setLockNotice(''); return; }
  const here = S.stops.find((s) => s.role === 'stop' && s.discovered && s.state === 'locked' && inRange(s));
  if (!here) { S.promptedFor = null; setLockNotice(''); autoUnlock(); return; }
  // Standing at a discovered location: open its card once per visit so the entry form (or the lock reason) is right there.
  if (S.promptedFor !== here.id && !S.openId) { S.promptedFor = here.id; openStop(here.id); }
  setLockNotice(here.released
    ? (here.needsPhoto ? `Location ${here.ord} is discovered but locked. Photograph it to unlock it (tap the card below).` : here.needsFlag ? `Location ${here.ord} is discovered but locked. Enter its entry flag to unlock it (tap the card below).` : '')
    : `Location ${here.ord} is locked. Unlock locations in order: hand in the code from Location ${here.prevOrd} at the base.`);
  autoUnlock();
}
function setLockNotice(message) {
  if (message === S.lockMsg) return;
  S.lockMsg = message;
  const el = $('#lockBanner');
  el.hidden = !message; el.textContent = message;
  if (message) buzz(150);
}

// ---------- offline tolerance ----------
// Answers typed while there is no connection are kept on the phone and sent when it returns. Only flag answers are queued:
// unlocking and handing in need the player's position at that moment, and photos are too big to hold.
const QUEUE_KEY = 'kq-queue';
const readQueue = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } };
const writeQueue = (list) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(list)); } catch { /* storage unavailable: queue only lives this session */ } renderOffline(); };
function queueFlag(stop, idx, flag) {
  const list = readQueue().filter((q) => !(q.stopId === stop.id && q.idx === idx));
  list.push({ stopId: stop.id, idx, flag, at: Date.now() });
  writeQueue(list);
  toast('No connection. Your answer is saved and will be sent automatically.');
}
function setNetFail(failed) { if (S.netFail !== failed) { S.netFail = failed; renderOffline(); } }
function renderOffline() {
  const offline = !navigator.onLine || S.netFail;
  const queued = readQueue().length;
  const badge = $('#offlineBadge');
  badge.hidden = !offline && !queued;
  badge.textContent = offline ? `OFFLINE${queued ? ` · ${queued} answer${queued > 1 ? 's' : ''} saved` : ''}` : `SENDING ${queued} SAVED ANSWER${queued > 1 ? 'S' : ''}…`;
}
async function flushQueue() {
  if (S.flushing || !navigator.onLine || !S.started) return;
  const list = readQueue();
  if (!list.length) { renderOffline(); return; }
  S.flushing = true;
  try {
    for (const item of list) {
      const stop = stopById(item.stopId);
      if (!stop || stop.puzzles.find((p) => p.idx === item.idx)?.solved) { writeQueue(readQueue().filter((q) => q !== item && !(q.stopId === item.stopId && q.idx === item.idx))); continue; }
      const result = await api.submitFlag(stop, item.idx, item.flag, S.fix);
      if (result.offline) break;
      writeQueue(readQueue().filter((q) => !(q.stopId === item.stopId && q.idx === item.idx)));
      const title = stop.puzzles.find((p) => p.idx === item.idx)?.title || 'a question';
      if (result.ok) { applyView(result.view); renderSheet(); renderHud(); renderNear(); toast(`Saved answer sent: “${title}” is correct.`, 'win'); }
      else toast(`Your saved answer for “${title}” was not accepted: ${result.error}`);
    }
  } finally { S.flushing = false; renderOffline(); }
}
window.addEventListener('online', () => { setNetFail(false); flushQueue(); });
window.addEventListener('offline', renderOffline);
setInterval(flushQueue, 6000);

// ---------- rehearsal (organisers) ----------
async function toggleRehearsal() {
  const test = Boolean(S.view?.team?.isTest);
  if (test && !confirm('End the rehearsal? Its progress is deleted.')) return;
  const result = test ? await api.endRehearsal() : await api.startRehearsal();
  if (!result.ok) { toast(result.error || 'Could not change rehearsal.'); return; }
  location.reload();
}

// ---------- recap ----------
const fmtDur = (sec) => (sec == null ? '–' : sec >= 3600 ? `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`);
/** Per location: how long from unlocking it to handing its code in (falls back to what is known). */
function recapRows(recap) {
  return recap.stops.map((s) => {
    const from = s.unlockedAt || s.discoveredAt; const to = s.handedInAt || s.clearedAt;
    return { ...s, seconds: from && to ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000)) : null };
  });
}
async function openRecap() {
  const recap = await api.teamRecap();
  if (!recap.ok && recap.error) { toast(recap.error); return; }
  S.recap = recap;
  const rows = recapRows(recap);
  $('#recapTitle').textContent = recap.team.name;
  $('#recapBody').innerHTML = `
    <div class="recap-stats">
      <div><strong>${fmtDur(recap.team.elapsedSeconds)}</strong><small>TOTAL TIME</small></div>
      <div><strong>#${recap.team.rank ?? '–'}</strong><small>OF ${recap.team.finishedTeams}</small></div>
      <div><strong>${recap.flags}</strong><small>FLAGS · ${recap.wrong} MISSES</small></div>
    </div>
    ${rows.map((r) => `<div class="recap-line"><span>${stopIcon(r)}</span><span><b>${esc(r.place)}</b><br><small>${r.wrong ? `${r.wrong} wrong answer${r.wrong > 1 ? 's' : ''}` : 'no wrong answers'}</small></span><b>${fmtDur(r.seconds)}</b></div>`).join('')}
    ${recap.fastest ? `<p class="dialog-note">${icon('trophy')} Fastest solve: <b>${esc(recap.fastest.title)}</b> in ${fmtDur(recap.fastest.seconds)} by ${esc(recap.fastest.by || 'your team')}.</p>` : ''}
    ${recap.members?.length ? `<p class="dialog-note">${recap.members.map((m) => `${esc(m.name)} ${m.solves}`).join(' · ')} flags</p>` : ''}`;
  $('#recapDialog').showModal();
}
/** A shareable image: dark card with the team's numbers. Drawn on a canvas, no network. */
function recapCard(recap) {
  const w = 1080; const rows = recapRows(recap); const h = 600 + rows.length * 104 + 160;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const FONT = '"Lilita One", "Google Sans", sans-serif';
  const INK = '#0f0728';
  const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#150a36'); sky.addColorStop(0.6, '#3d2d94'); sky.addColorStop(1, '#3a2a82');
  g.fillStyle = sky; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; for (let i = 0; i < 70; i += 1) { g.globalAlpha = 0.25 + ((i * 37) % 70) / 100; g.fillRect((i * 193) % w, (i * 71) % (h * 0.55), 3, 3); } g.globalAlpha = 1;
  const outlined = (text, x, y, size, fill, align = 'left') => { g.font = `${size}px ${FONT}`; g.textAlign = align; g.lineJoin = 'round'; g.lineWidth = size * 0.18; g.strokeStyle = INK; g.strokeText(text, x, y); g.fillStyle = fill; g.fillText(text, x, y); };
  const slab = (x, y, bw, bh, fill) => { g.fillStyle = INK; g.beginPath(); g.roundRect(x - 4, y - 4, bw + 8, bh + 14, 26); g.fill(); g.fillStyle = fill; g.beginPath(); g.roundRect(x, y, bw, bh, 22); g.fill(); g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(x + 12, y + 4, bw - 24, 4); };
  outlined('KRYPTEX QUEST', 60, 130, 64, '#b8a2ff');
  g.font = `34px ${FONT}`; g.fillStyle = '#c8bdf0'; g.textAlign = 'left'; g.fillText('GDG ON CAMPUS · BITS PILANI DUBAI', 60, 180);
  outlined(recap.team.name.slice(0, 16), 60, 320, 110, '#ffe066');
  const stat = (x, big, small) => { slab(x, 380, 300, 150, '#2c2074'); outlined(big, x + 150, 470, 64, '#fff', 'center'); g.font = `28px ${FONT}`; g.fillStyle = '#c8bdf0'; g.textAlign = 'center'; g.fillText(small, x + 150, 512); };
  stat(60, fmtDur(recap.team.elapsedSeconds), 'TOTAL TIME'); stat(390, `#${recap.team.rank ?? '–'}`, `OF ${recap.team.finishedTeams} TEAM${recap.team.finishedTeams === 1 ? '' : 'S'}`); stat(720, String(recap.flags), 'FLAGS');
  const cols = ['#8b6cf0', '#ea4335', '#fbbc04', '#34a853'];
  rows.forEach((r, i) => {
    const y = 590 + i * 104;
    slab(60, y, w - 120, 84, '#3a2c8c');
    g.fillStyle = cols[i % 4]; g.beginPath(); g.arc(112, y + 42, 26, 0, Math.PI * 2); g.fill(); g.lineWidth = 5; g.strokeStyle = INK; g.stroke();
    outlined(String(i + 1), 112, y + 54, 34, '#fff', 'center');
    g.font = `38px ${FONT}`; g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(r.place.slice(0, 24), 164, y + 54);
    g.textAlign = 'right'; g.fillStyle = '#ffe066'; g.fillText(fmtDur(r.seconds), w - 96, y + 54);
  });
  if (recap.fastest) { g.font = `34px ${FONT}`; g.fillStyle = '#8fe8a8'; g.textAlign = 'left'; g.fillText(`Fastest solve: ${recap.fastest.title} (${fmtDur(recap.fastest.seconds)})`.slice(0, 56), 60, h - 70); }
  return c;
}
$('#recapShare').addEventListener('click', async () => {
  if (!S.recap) return;
  const canvas = recapCard(S.recap);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], 'kryptex-quest-recap.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], text: `${S.recap.team.name} on Kryptex Quest` }); return; } catch { /* cancelled */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});

// ---------- leaderboard, help, finish ----------
async function renderBoard() {
  try {
    const board = await api.leaderboard();
    const fmt = (r) => (r.finishedAt ? `${clockText((r.elapsedSeconds || 0) * 1000)}` : `${r.flags} flag${r.flags === 1 ? '' : 's'}`);
    $('#boardTitle').textContent = board.status === 'ended' ? 'Final results' : 'Standings';
    $('#boardBody').innerHTML = board.rows.length ? board.rows.map((r) => `<div class="board-row ${r.teamId === board.me ? 'me' : ''}"><span class="pos">${r.rank}</span><span><strong>${esc(r.name)}</strong><small>${r.stopsCleared} ${r.stopsCleared === 1 ? 'location' : 'locations'} · ${r.hubFlags} flags in · ${r.players} ${r.players === 1 ? 'player' : 'players'}</small></span><span class="time">${fmt(r)}</span></div>`).join('') : '<div class="empty">No teams yet.</div>';
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
  let rank = null; let total = null;
  try { const board = await api.leaderboard(); const row = board.rows.find((r) => r.teamId === team.id); if (row) { rank = row.rank; total = board.rows.length; } } catch { /* the board is optional here */ }
  const took = team.startedAt ? clockText(Date.parse(team.finishedAt) - Date.parse(team.startedAt)) : '--:--';
  const flags = S.progress.solved.length;
  $('#finishTeam').textContent = team.name;
  $('#finishStats').innerHTML = `<div><strong class="digits">${took}</strong><small>Total time</small></div><div><strong class="digits">${rank ? `#${rank}` : '-'}</strong><small>${total ? `of ${total} team${total === 1 ? '' : 's'}` : 'Rank'}</small></div><div><strong class="digits">${flags}</strong><small>Flags</small></div>`;
  $('#finishArt').innerHTML = medalArt('trophy');
  sfx('cleared'); $('#finishDialog').showModal();
}
$('#finishDialog').addEventListener('close', () => {
  const choice = $('#finishDialog').returnValue;
  if (choice === 'recap') openRecap(); else if (choice === 'board') openBoard();
});
function syncMenu() {
  $('#recapMenu').hidden = !S.view?.team?.finishedAt;
  const test = Boolean(S.view?.team?.isTest);
  $('#rehearsalMenu').hidden = !S.canRehearse || (!test && Boolean(S.view?.team));
  $('#rehearsalMenu').textContent = test ? 'End rehearsal (deletes its progress)' : 'Start rehearsal (organisers)';
  // Discovered locations can be opened from anywhere; unlocking and answering still need the team to be there.
  const found = S.stops.filter((s) => s.role === 'stop' && s.discovered).sort((a, b) => a.ord - b.ord);
  const box = $('#menuLocations');
  box.hidden = !found.length;
  box.innerHTML = found.length ? `<p class="menu-label">DISCOVERED LOCATIONS</p>${found.map((s) => `<button type="button" data-menu="stop:${esc(s.id)}"><span class="dot ${s.state}"></span> ${esc(s.state === 'locked' ? `Location ${s.ord}` : s.place)}<small>${s.state === 'cleared' ? 'Cleared' : s.state === 'open' ? 'Unlocked' : 'Locked'}</small></button>`).join('')}` : '';
}


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
  $('#teamCode').innerHTML = [...team.code].map((c) => `<span>${esc(c)}</span>`).join('');   // one rotor window per letter
  $('#teamCount').textContent = `${team.members.length} / ${team.max} players`;
  $('#teamMembers').innerHTML = team.members.map((m) => `<li><span class="member-av ${m.avatar === 'female' ? 'f' : ''}">${esc(m.name.slice(0, 1).toUpperCase())}</span><span class="member-name">${esc(m.name)}${m.id === team.me ? ' <em>(you)</em>' : ''}</span>${m.isLeader ? '<span class="badge">LEADER</span>' : amLeader && !team.locked ? `<button type="button" class="kick" data-action="kick" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">${icon('x')}</button>` : ''}</li>`).join('');
  const enough = team.members.length >= team.min;
  $('#teamLock').hidden = !amLeader || team.locked;
  $('#teamLock').disabled = !enough;
  $('#teamLock').textContent = enough ? 'Lock in team' : `Need ${team.min - team.members.length} more to lock in`;
  $('#teamLeave').hidden = team.locked;
  $('#teamDemoMate').hidden = api.hasBackend || team.locked;
  $('#teamShare').hidden = team.locked;
  $('#teamStatus').textContent = team.locked ? 'LOCKED IN · let the quest begin'
    : amLeader ? (enough ? 'Everyone here? Lock in to start. Playing solo is fine. No one can join or leave after.' : `Share the code in person. Teams need ${team.min} to ${team.max} players.`)
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
    setNetFail(false);
    if (stable(next) === stable(S.view)) { pollDelay = Math.min(10_000, Math.round(pollDelay * 1.25)); return; }
    pollDelay = 4000;
    const prev = S.view || { stops: [], team: null };
    applyView(next);
    if (S.started) { announceTeamSolves(prev, next); renderHud(); renderNear(); renderStatus(); if (!typingInSheet()) renderSheet(); }
    if (!S.started || !$('#teamScreen').hidden || prev.team?.locked !== next.team?.locked) route();
  } catch (error) { console.warn('progress poll failed', error); setNetFail(true); }
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
  $('#hudAvatar').src = `./assets/art/portrait-${kind === 'female' ? 'female' : 'male'}.png`;
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
  if (saved) localStorage.setItem('kq-avatar', saved);   // a returning player on a new phone already has a character: do not ask again
  setAvatar(saved === 'female' ? 'female' : 'male');
  $('#menuName').textContent = user.name;
  $('#menuEmail').textContent = user.email;
  $('#resetRow').hidden = api.hasBackend;
  $('#simToggleRow').hidden = !CONFIG.allowSimulator;
  $('#locSim').hidden = !CONFIG.allowSimulator;
  $('#modeNote').textContent = api.hasBackend ? '' : 'Demo mode: sample content, progress saved on this device only.';
  schedulePoll();
  api.rehearsalAvailable().then((ok) => { S.canRehearse = ok; $('#teamRehearsal').hidden = !ok; syncMenu(); });
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
    checkNotices();
    // Re-render the sheet only when range flips, so typing in an input is never wiped.
    const stop = stopById(S.openId);
    if (stop && S.rangeShown !== inRange(stop) && !typingInSheet()) renderSheet();
  }, 1000);
  // Organisers see where players are: latest position only, every ~5 s.
  // The same ping discovers hidden locations server-side, so it runs a little faster than the console needs.
  setInterval(async () => {
    if (!S.fix) return;
    try {
      const res = await api.sendLocation(S.fix);
      setNetFail(false);
      S.world?.setMates(res?.mates || []);
      if (res?.discovered?.length) onDiscovered(res.discovered);
    } catch { setNetFail(true); }
  }, 4000);
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

/** Hide the splash once the first real screen is ready (it stays up at least a moment so it never flashes). */
const splashStart = performance.now();
function splash(text) { const el = $('#splashText'); if (el && text) el.textContent = text; }
function hideSplash() {
  const el = $('#splash');
  if (!el || el.dataset.gone) return;
  el.dataset.gone = '1';
  setTimeout(() => { el.classList.add('leave'); setTimeout(() => el.remove(), 600); }, Math.max(0, 1300 - (performance.now() - splashStart)));
}

async function boot() {
  // An installable app needs a service worker; this one caches nothing (see sw.js).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => { /* optional */ });
  if (installPromptWanted()) { showInstallGate(startApp); return; }
  await startApp();
}

async function startApp() {
  captureQr();
  $('#domainHint').textContent = `@${CONFIG.allowedEmailDomain}`;
  $('#demoSignIn').hidden = api.hasBackend;
  if (!api.hasBackend) $('#googleSignIn').hidden = true;
  const urlError = api.authErrorFromUrl();
  splash('Checking your sign-in…');
  const user = await api.getUser();
  if (user) { splash('Loading the map…'); await enterGame(user); } else showLogin(urlError);
  hideSplash();
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
$('#teamRehearsal').addEventListener('click', toggleRehearsal);
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
  if (action === 'recap') openRecap();
  if (action === 'rehearsal') toggleRehearsal();
  if (action.startsWith('stop:')) openStop(action.slice(5));
  if (action === 'sos') $('#sosDialog').showModal();
  if (action === 'help') $('#helpDialog').showModal();
  if (action === 'reset' && confirm('Reset all demo progress on this device?')) { api.resetDemo(); location.reload(); }
  if (action === 'signout') { await api.signOut(); location.reload(); }
});

hydrateIcons();
wireSimulator();
boot();
