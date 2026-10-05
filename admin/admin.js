import { CONFIG } from '../js/config.js';
import * as api from '../js/api.js';
import { distanceM } from '../js/geo.js';
import { icon, stopIcon, hydrateIcons } from '../js/icons.js';
import { loadMapLibre, buildStyle, whenLoaded, circlePolygon, stopMarkerElement } from '../js/map-core.js';
import { initContent, initPhotos } from './content.js';
import { initEvent } from './event.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];
const ONLINE_MS = 90_000;
const KIND_LABEL = { team_created: 'Team created', team_joined: 'Joined team', team_left: 'Left team', team_kicked: 'Removed', team_locked: 'Team locked', discover: 'Discovered', unlock: 'Unlock', flag: 'Flag', photo: 'Photo', stop_moved: 'Location moved', checkin: 'Base check-in', hub_flag: 'Code handed in', qr: 'QR scan', finished: 'Finished', admin_action: 'Admin action', broadcast: 'Broadcast', help: 'Help request', game: 'Event control', content: 'Content edit', photo_review: 'Photo review' };
const STATUS_LABEL = { lobby: 'Not started', running: 'Running', paused: 'Paused', ended: 'Ended' };

const A = {
  stops: [], live: null, teams: [], events: [], tab: 'map', skew: 0, alerts: [],
  selectedStop: null, draft: null, relocating: false, selectedTeam: null, teamQuery: '', pane: 'teams',
  map: null, maplibregl: null, stopMarkers: new Map(), coinMarkers: new Map(), logOldest: null, logFilter: { kind: '', team: '', q: '' },
};
let toastTimer;

function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}
const hash = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const teamColor = (teamId) => (teamId ? COLORS[hash(teamId) % 4] : '#6b7590');
const now = () => Date.now() + A.skew;
const age = (iso) => (iso ? now() - Date.parse(iso) : Infinity);
function ago(iso) {
  const ms = age(iso);
  if (!Number.isFinite(ms)) return 'never';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const totalFlags = () => A.stops.reduce((n, s) => n + s.puzzles.length, 0);
const isOnline = (player) => age(player.updatedAt) < ONLINE_MS;

// ---------- gate ----------
async function boot() {
  hydrateIcons();
  if (!api.hasBackend) return startConsole('Demo admin');
  const user = await api.getUser();
  if (!user) { $('#signIn').hidden = false; return; }
  if (!(await api.adminCheck().catch(() => false))) { $('#notFound').hidden = false; return; }
  startConsole(user.email);
}

async function startConsole(who) {
  $('#console').hidden = false;
  $('#who').textContent = who;
  $('#demoBanner').hidden = api.hasBackend;
  try { A.stops = await api.adminStops(); } catch (error) { toast('Could not load locations.'); console.error(error); }
  buildFilters();
  try { await initMap(); } catch (error) {
    // The map library comes from a CDN: if it is unreachable the rest of the console must still work.
    console.error(error); A.map = null;
    toast('The map could not load. Teams, locations, photos and the event tab still work; reload to retry.');
    $('#map').innerHTML = '<div class="empty big">The map could not load (check the connection and reload).</div>';
  }
  wireContent();
  await refreshLive();
  setInterval(refreshLive, 3000);
  setInterval(() => { if (A.tab === 'teams' && A.pane === 'teams') refreshTeams(); if (A.tab === 'teams' && A.pane === 'log' && $('#logLive').checked) loadEvents(true); }, 6000);
  refreshTeams();
  refreshAlerts();
  refreshStatus();
  setInterval(refreshAlerts, 10000);
  setInterval(refreshStatus, 8000);
}

/** The event clock at a glance, in the navbar, on every tab. */
async function refreshStatus() {
  try {
    const game = await api.adminGame();
    const eff = game.effective || game.status;
    const pill = $('#statusPill');
    pill.dataset.status = eff;
    pill.querySelector('span').textContent = STATUS_LABEL[eff] || eff;
  } catch (error) { console.warn('status refresh failed', error); }
}
$('#statusPill').addEventListener('click', () => switchTab('event'));

// ---------- live counters ----------
function renderCounters() {
  const live = A.live;
  if (!live) return;
  const online = live.players.filter(isOnline).length;
  const cell = (label, value, sub) => `<div><span class="engrave">${label}</span><strong class="digits">${value}</strong>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#counters').innerHTML = cell('Online', online, `of ${live.registered} signed up`) + cell('Teams', live.lockedTeams, `${live.teams} formed`) + cell('Flags', live.flagsSolved, `of ${totalFlags() * Math.max(1, live.lockedTeams)}`);
  $('#playerCount').textContent = `${online} online`;
}

// ---------- map ----------
async function initMap() {
  A.maplibregl = await loadMapLibre();
  const first = A.stops[0];
  A.map = new A.maplibregl.Map({
    container: 'map', style: await buildStyle(), center: [first?.lng ?? CONFIG.campus.lng, first?.lat ?? CONFIG.campus.lat],
    zoom: 17.6, pitch: 50, bearing: 0, maxZoom: 21, attributionControl: { compact: true },
  });
  await whenLoaded(A.map);
  A.map.addSource('radius', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  A.map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#FBBC04', 'fill-opacity': 0.14 } });
  A.map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#FBBC04', 'line-width': 2, 'line-dasharray': [2, 2] } });
  A.map.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  A.map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'nogo'], paint: { 'fill-color': '#EA4335', 'fill-opacity': 0.22 } });
  A.map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'nogo'], '#EA4335', '#4285F4'], 'line-width': 2, 'line-dasharray': [3, 2] } });
  api.adminGame().then((g) => drawZones(g.bounds, g.noGo)).catch(() => {});
  A.stops.forEach(addStopMarker);
  A.map.on('click', (e) => { if (A.relocating) setDraft({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
}

function drawZones(bounds, noGo) {
  if (!A.map) return;
  const features = [];
  if (bounds) features.push({ ...circlePolygon(bounds, bounds.radius), properties: { kind: 'bounds' } });
  (noGo || []).forEach((z) => features.push({ ...circlePolygon(z, z.radius), properties: { kind: 'nogo' } }));
  A.map.getSource('zones')?.setData({ type: 'FeatureCollection', features });
}

function addStopMarker(stop) {
  if (!A.map) return;
  const el = stopMarkerElement(stop);
  el.classList.remove('locked'); el.classList.add(stop.role === 'hub' ? 'hub' : 'open');
  el.addEventListener('click', (e) => { e.stopPropagation(); selectStop(stop.id); });
  const marker = new A.maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([stop.lng, stop.lat]).addTo(A.map);
  A.stopMarkers.set(stop.id, { el, marker });
}

function renderCoins() {
  if (!A.map) return;
  const players = A.live?.players || [];
  const seen = new Set();
  players.forEach((p) => {
    seen.add(p.id);
    let entry = A.coinMarkers.get(p.id);
    if (!entry) {
      const el = document.createElement('div');
      el.className = 'coin';
      el.innerHTML = '<div class="coin-face"></div><div class="coin-tag"><b></b><small></small></div>';
      el.addEventListener('click', () => focusPlayer(p.id));
      entry = { el, marker: new A.maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([p.lng, p.lat]).addTo(A.map) };
      A.coinMarkers.set(p.id, entry);
    }
    entry.el.style.setProperty('--c', teamColor(p.teamId));
    entry.el.classList.toggle('stale', !isOnline(p));
    entry.el.querySelector('.coin-face').textContent = (p.name || '?').slice(0, 1).toUpperCase();
    entry.el.querySelector('b').textContent = p.name;
    entry.el.querySelector('small').textContent = p.teamName || 'no team';
    entry.el.title = `${p.name} · ${p.email || ''} · ±${Math.round(p.accuracy || 0)} m · ${ago(p.updatedAt)}`;
    entry.marker.setLngLat([p.lng, p.lat]);
  });
  A.coinMarkers.forEach((entry, id) => { if (!seen.has(id)) { entry.marker.remove(); A.coinMarkers.delete(id); } });
}

function focusPlayer(id) {
  const p = A.live.players.find((x) => x.id === id);
  if (p && A.map) A.map.flyTo({ center: [p.lng, p.lat], zoom: 19, essential: true });
}

// ---------- moving a location on the map (the bar at the bottom of the map) ----------
const stopById = (id) => A.stops.find((s) => s.id === id);
function renderMarkers() { A.stopMarkers.forEach(({ el }, id) => el.classList.toggle('selected', id === A.selectedStop)); }

function selectStop(id) {
  if (A.relocating) cancelEdit();
  A.selectedStop = id;
  const stop = stopById(id);
  if (!stop) return;
  A.draft = { lat: stop.lat, lng: stop.lng, radius: stop.radius };
  A.relocating = false;
  A.map?.flyTo({ center: [stop.lng, stop.lat], zoom: Math.max(A.map.getZoom(), 18.4), essential: true });
  renderMarkers(); renderReloc(); drawRadius();
}

function dirty() {
  const stop = stopById(A.selectedStop);
  return Boolean(stop && A.draft && (stop.lat !== A.draft.lat || stop.lng !== A.draft.lng || stop.radius !== A.draft.radius));
}

function renderReloc() {
  const el = $('#relocBar');
  const stop = stopById(A.selectedStop);
  el.hidden = !stop;
  if (!stop) return;
  const moved = Math.round(distanceM(stop, A.draft));
  el.innerHTML = `<div class="rb-title"><span class="rb-icon">${stopIcon(stop)}</span><div><strong>${esc(stop.place)}</strong><small class="code">${A.draft.lat.toFixed(6)}, ${A.draft.lng.toFixed(6)}${moved ? ` · moved ${moved} m` : ''}</small></div></div>
    <label class="rb-radius"><span class="engrave">Radius <b id="edRadiusVal" class="digits">${A.draft.radius} m</b></span><input type="range" id="edRadius" min="10" max="200" step="5" value="${A.draft.radius}" /></label>
    <div class="rb-buttons">
      <button type="button" class="btn ${A.relocating ? 'on' : ''}" id="edRelocate">${A.relocating ? 'Click the map…' : 'Move on map'}</button>
      <button type="button" class="btn" id="edCancel">Reset</button>
      <button type="button" class="btn save" id="edSave" ${dirty() ? '' : 'disabled'}>Save</button>
      <button type="button" class="icon-key" id="edClose" aria-label="Close">${icon('x')}</button>
    </div>`;
}

function setDraft(patch) {
  A.draft = { ...A.draft, ...patch };
  A.stopMarkers.get(A.selectedStop)?.marker.setLngLat([A.draft.lng, A.draft.lat]);
  if (patch.lat != null) A.relocating = false;
  drawRadius(); renderReloc();
}
function drawRadius() {
  if (!A.map) return;
  const features = A.draft && A.selectedStop ? [circlePolygon(A.draft, A.draft.radius)] : [];
  A.map.getSource('radius').setData({ type: 'FeatureCollection', features });
}
function cancelEdit() {
  const stop = stopById(A.selectedStop);
  if (!stop) return;
  A.stopMarkers.get(stop.id)?.marker.setLngLat([stop.lng, stop.lat]);
  A.draft = { lat: stop.lat, lng: stop.lng, radius: stop.radius };
  A.relocating = false;
  drawRadius(); renderReloc();
}
function closeReloc() { cancelEdit(); A.selectedStop = null; A.draft = null; renderMarkers(); renderReloc(); drawRadius(); }

$('#relocBar').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'edRelocate') { A.relocating = !A.relocating; renderReloc(); }
  if (t.id === 'edCancel') cancelEdit();
  if (t.id === 'edClose') closeReloc();
  if (t.id === 'edSave') {
    const id = A.selectedStop;
    const result = await api.adminSaveStop(id, { lat: A.draft.lat, lng: A.draft.lng, radius: A.draft.radius });
    if (!result.ok) { toast(result.error || 'Could not save.'); return; }
    A.stops = await api.adminStops();
    const stop = stopById(id);
    A.draft = { lat: stop.lat, lng: stop.lng, radius: stop.radius };
    renderReloc(); toast(`${stop.place} saved. Players see the new spot on their next load.`);
  }
});
$('#relocBar').addEventListener('input', (e) => {
  if (e.target.id === 'edRadius') { A.draft.radius = Number(e.target.value); $('#edRadiusVal').textContent = `${A.draft.radius} m`; drawRadius(); $('#edSave').disabled = !dirty(); }
});

$('#tilt').addEventListener('click', () => A.map?.easeTo({ pitch: A.map.getPitch() > 10 ? 0 : 55, duration: 500 }));
$('#fitAll').addEventListener('click', () => {
  if (!A.map) return;
  const bounds = new A.maplibregl.LngLatBounds();
  A.stops.forEach((s) => bounds.extend([s.lng, s.lat]));
  A.live?.players.forEach((p) => bounds.extend([p.lng, p.lat]));
  A.map.fitBounds(bounds, { padding: 90, maxZoom: 19, duration: 600 });
});

// ---------- players ----------
function renderPlayers() {
  const players = [...(A.live?.players || [])].sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || String(a.name).localeCompare(b.name));
  $('#playerList').innerHTML = players.length ? players.map((p) => `<button type="button" class="player-row ${isOnline(p) ? '' : 'stale'}" data-player="${esc(p.id)}" style="--c:${teamColor(p.teamId)}"><span class="dot"></span><span class="meta"><strong>${esc(p.name)}</strong><small>${esc(p.teamName || 'no team')} · ±${Math.round(p.accuracy || 0)} m</small></span><small>${ago(p.updatedAt)}</small></button>`).join('')
    : '<div class="empty">No players have reported a location yet.</div>';
}
$('#playerList').addEventListener('click', (e) => { const row = e.target.closest('[data-player]'); if (row) focusPlayer(row.dataset.player); });

async function refreshLive() {
  try {
    A.live = await api.adminLive();
    A.skew = Date.parse(A.live.now) - Date.now();
    renderCounters(); renderCoins(); renderPlayers();
  } catch (error) { console.warn('live refresh failed', error); }
}

// ---------- alerts: teams that need an organiser ----------
async function refreshAlerts() {
  try { A.alerts = await api.adminAlerts(); } catch (error) { console.warn('alerts failed', error); return; }
  const bar = $('#alertBar');
  bar.hidden = !A.alerts.length;
  bar.innerHTML = A.alerts.map((a, i) => `<div class="alert ${a.kind}">${icon(a.kind === 'stalled' ? 'clock' : 'flag')}<span>${a.kind === 'stalled'
      ? `<b>${esc(a.teamName)}</b> has done nothing for ${a.minutes} min`
      : `<b>${esc(a.teamName)}</b> got “${esc(a.title || 'a question')}” wrong ${a.wrong}× in 15 min`}</span>
      <button type="button" data-alert-hint="${i}">Send hint</button><button type="button" data-alert-open="${i}">Open team</button></div>`).join('');
  if (A.tab === 'teams' && A.pane === 'teams') renderTeamList();
}
$('#alertBar').addEventListener('click', async (e) => {
  const hint = e.target.closest('[data-alert-hint]'); const open = e.target.closest('[data-alert-open]');
  if (hint) await sendHint(A.alerts[Number(hint.dataset.alertHint)].teamId);
  if (open) { A.selectedTeam = A.alerts[Number(open.dataset.alertOpen)].teamId; switchTab('teams'); setPane('teams'); await refreshTeams(); }
});
/** A one-team broadcast: the organiser types a nudge, only that team sees it. */
async function sendHint(teamId) {
  const team = A.teams.find((t) => t.id === teamId);
  const message = prompt(`Hint for ${team?.name || 'this team'} (only they will see it):`);
  if (!message) return;
  const result = await api.adminBroadcast(message, teamId, 'info');
  toast(result.ok ? 'Hint sent to that team.' : result.error);
}

// ---------- teams ----------
const stopsCleared = (team) => A.stops.filter((s) => s.role !== 'hub' && s.puzzles.length && s.puzzles.every((p) => team.solved.some((x) => x.stopId === s.id && x.idx === p.idx))).length;
const regularStops = () => A.stops.filter((s) => s.role === 'stop');
const isOpenFor = (team, stop) => stop.entryMode === 'open' || team.unlocked.some((u) => u.stopId === stop.id);

async function refreshTeams() {
  try { A.teams = await api.adminTeams(); } catch (error) { console.warn(error); return; }
  fillTeamFilter();
  renderTeamList();
  await renderTeamDetail();
}

function renderTeamList() {
  const q = A.teamQuery.trim().toLowerCase();
  const sorted = [...A.teams].filter((t) => !q || t.name.toLowerCase().includes(q)).sort((a, b) => b.solved.length - a.solved.length || String(a.name).localeCompare(b.name));
  $('#teamList').innerHTML = sorted.length ? sorted.map((t) => `<button type="button" class="team-item ${A.selectedTeam === t.id ? 'active' : ''}" data-team="${esc(t.id)}">
      <div class="top"><strong>${esc(t.name)}${t.isTest ? ' <span class="mini test">TEST</span>' : ''}${A.alerts.some((a) => a.teamId === t.id) ? `<span class="flag-alert" title="Needs attention">${icon('bell')}</span>` : ''}</strong><span class="score digits">${t.solved.length}/${totalFlags()}</span></div>
      <div class="pips">${A.stops.flatMap((s) => s.puzzles.map((p) => `<i class="${p.kind} ${t.solved.some((x) => x.stopId === s.id && x.idx === p.idx) ? 'on' : ''}"></i>`)).join('')}</div>
      <small>${t.members.length} players · ${stopsCleared(t)}/${A.stops.length} locations cleared · ${t.finishedAt ? 'finished' : t.locked ? 'playing' : 'not locked'} · active ${ago(t.lastActivity)}</small></button>`).join('')
    : '<div class="empty">No teams match.</div>';
}
$('#teamSearch').addEventListener('input', (e) => { A.teamQuery = e.target.value; renderTeamList(); });

async function renderTeamDetail() {
  const t = A.teams.find((x) => x.id === A.selectedTeam);
  const box = $('#teamDetail');
  if (!t) { box.innerHTML = '<div class="empty big">Pick a team to see where they are, open a location for them, or send a hint.</div>'; return; }
  A.teamEvents = await api.adminEvents({ limit: 60, team: t.id }).catch(() => []);
  const playable = A.stops.filter((s) => s.role !== 'hub');
  const maxSolves = Math.max(1, ...t.members.map((m) => m.solves));
  const act = (a, extra = '') => `data-act="${a}" ${extra}`;
  const lockedStops = playable.filter((s) => !isOpenFor(t, s) && !t.solved.some((x) => x.stopId === s.id));
  const stopRows = playable.map((s) => {
    const solvedN = t.solved.filter((x) => x.stopId === s.id).length;
    const cleared = s.puzzles.length > 0 && solvedN === s.puzzles.length;
    const open = isOpenFor(t, s);
    const handed = t.hubFlags?.includes(s.id);
    const state = cleared ? (handed ? 'Handed in' : 'Cleared') : open ? 'Open' : 'Locked';
    return `<div class="stop-prog ${cleared ? 'cleared' : open ? 'open' : 'locked'}"><div class="head"><span class="sp-icon">${stopIcon(s)}</span><strong>${esc(s.place)}</strong><span class="state-chip">${state}</span><span class="sp-count digits">${solvedN}/${s.puzzles.length}</span>
        <span class="sp-actions">${!open && !cleared ? `<button type="button" class="mini" ${act('open_stop', `data-stop="${esc(s.id)}"`)} title="Unlock this location for the team, nothing solved">Open</button>` : ''}
        ${!cleared ? `<button type="button" class="mini" ${act('grant_stop', `data-stop="${esc(s.id)}"`)} title="Unlock it and mark every question solved">Solve all</button>` : ''}
        ${s.role === 'stop' && cleared && !handed ? `<button type="button" class="mini" ${act('grant_hub_flag', `data-stop="${esc(s.id)}"`)} title="Count this location's code as handed in at the base">Hand in</button>` : ''}</span></div>
      <details class="qs"><summary>Questions</summary>${s.puzzles.map((p) => { const hit = t.solved.find((x) => x.stopId === s.id && x.idx === p.idx); return hit
        ? `<div class="flag-line"><span class="tick">${icon('check')}</span><span>${esc(p.title)}</span><span>by <b>${esc(hit.userName)}</b> <small>${clock(hit.at)}</small></span><button type="button" class="mini" ${act('revoke_puzzle', `data-stop="${esc(s.id)}" data-idx="${p.idx}"`)}>Undo</button></div>`
        : `<div class="flag-line todo"><span class="tick"></span><span>${esc(p.title)}</span><span></span><button type="button" class="mini" ${act('grant_puzzle', `data-stop="${esc(s.id)}" data-idx="${p.idx}"`)}>Mark solved</button></div>`; }).join('')}</details></div>`;
  }).join('');
  const others = A.teams.filter((x) => x.id !== t.id);
  box.innerHTML = `<header class="td-head"><div><h2>${esc(t.name)}${t.isTest ? ' <span class="mini test">TEST</span>' : ''}</h2>
      <div class="chips"><span class="pill code">${esc(t.code)}</span><span class="pill ${t.finishedAt ? 'good' : t.locked ? '' : 'warn'}">${t.finishedAt ? `Finished ${clock(t.finishedAt)}` : t.locked ? (t.startedAt ? `Started ${clock(t.startedAt)}` : 'Locked in, not checked in') : 'Not locked yet'}</span>
      <span class="pill">Flags <b class="digits">${t.solved.length}/${totalFlags()}</b></span><span class="pill">Cleared <b class="digits">${stopsCleared(t)}/${playable.length}</b></span><span class="pill">Handed in <b class="digits">${t.hubFlags?.length ?? 0}/${regularStops().length}</b></span><span class="pill">Active <b>${ago(t.lastActivity)}</b></span></div></div>
      <div class="td-actions"><button type="button" class="btn" ${act('hint')}>${icon('send')} Send hint</button>${t.startedAt ? '' : `<button type="button" class="btn" ${act('check_in')}>Check in for them</button>`}</div></header>
    <section class="td-open"><span class="engrave">Open a location for this team</span>
      <div class="td-open-row"><select id="tdOpenStop" class="field-input" ${lockedStops.length ? '' : 'disabled'}>${lockedStops.length ? lockedStops.map((s) => `<option value="${esc(s.id)}">${esc(s.place)}</option>`).join('') : '<option>Everything is already open</option>'}</select>
      <button type="button" class="btn save" id="tdOpenBtn" ${lockedStops.length ? '' : 'disabled'}>${icon('unlock')} Open it</button></div></section>
    <section><h3 class="sec">Locations</h3><div class="stops-prog">${stopRows}</div></section>
    <section><h3 class="sec">Players</h3><table class="tbl"><thead><tr><th>Player</th><th>Flags</th><th>Wrong</th><th>Last seen</th><th></th></tr></thead><tbody>
      ${t.members.map((m) => `<tr><td><b>${esc(m.name)}</b>${m.isLeader ? ' <span class="mini warn">leader</span>' : ''}<br><small class="muted">${esc(m.email)}</small></td>
        <td class="bar-cell"><span class="digits">${m.solves}</span><div class="mini-bar"><i style="width:${(m.solves / maxSolves) * 100}%"></i></div></td><td class="digits">${m.wrong}</td><td>${ago(m.lastSeen)}</td>
        <td class="row-actions"><button type="button" class="mini" ${act('remove_member', `data-user="${esc(m.id)}"`)}>Remove</button>${others.length ? `<select class="mini-select" data-move-to="${esc(m.id)}" aria-label="Move ${esc(m.name)} to another team"><option value="">Move to…</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>` : ''}</td></tr>`).join('')}</tbody></table></section>
    <details class="fold"><summary>Team controls</summary><div class="team-actions">
      <button type="button" class="btn" ${act(t.locked ? 'unlock_team' : 'lock_team')}>${t.locked ? 'Unlock team (let them edit)' : 'Lock team'}</button>
      <button type="button" class="btn" ${act('rename')}>Rename</button>
      ${t.finishedAt ? `<button type="button" class="btn" ${act('clear_finish')}>Clear finish</button>` : ''}
      <button type="button" class="btn danger" ${act('reset_progress')}>Reset progress</button>
      <button type="button" class="btn danger" ${act('disband')}>Disband team</button></div></details>
    <details class="fold"><summary>Timeline</summary>${eventsTable(A.teamEvents, false) || '<div class="empty">Nothing yet.</div>'}</details>`;
}
$('#teamDetail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act], #tdOpenBtn');
  if (!b || !A.selectedTeam) return;
  const team = A.teams.find((x) => x.id === A.selectedTeam);
  let action = b.dataset.act;
  if (b.id === 'tdOpenBtn') action = 'open_stop';
  if (action === 'hint') return sendHint(A.selectedTeam);
  const body = { action, team: A.selectedTeam, stop: b.id === 'tdOpenBtn' ? $('#tdOpenStop').value : b.dataset.stop, idx: b.dataset.idx != null ? Number(b.dataset.idx) : undefined, user: b.dataset.user };
  if (action === 'rename') { body.name = prompt('New team name', team.name); if (!body.name) return; }
  if (action === 'reset_progress' && !confirm(`Reset ALL progress for ${team.name}? Their solves, unlocks, check-in and photos are erased.`)) return;
  if (action === 'disband' && !confirm(`Disband ${team.name}? The team and its progress are deleted.`)) return;
  if (action === 'grant_stop' && !confirm('Unlock this location for the team and mark all its questions solved?')) return;
  const result = await api.adminTeamAction(body);
  if (!result.ok) return toast(result.error || 'Could not do that.');
  toast(result.note || (action === 'open_stop' ? 'Location opened for the team.' : 'Done.'));
  if (action === 'disband') A.selectedTeam = null;
  await refreshTeams();
});
$('#teamDetail').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-move-to]');
  if (!sel || !sel.value) return;
  const result = await api.adminTeamAction({ action: 'move_member', team: A.selectedTeam, user: sel.dataset.moveTo, to: sel.value });
  toast(result.ok ? (result.note || 'Moved.') : result.error);
  await refreshTeams();
});
$('#teamList').addEventListener('click', (e) => { const item = e.target.closest('[data-team]'); if (item) { A.selectedTeam = item.dataset.team; renderTeamList(); renderTeamDetail(); } });

// ---------- activity (inside the Teams tab) ----------
function buildFilters() {
  $('#logKind').innerHTML = '<option value="">All events</option>' + Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
}
function fillTeamFilter() {
  const select = $('#logTeam');
  const current = select.value;
  select.innerHTML = '<option value="">All teams</option>' + A.teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  select.value = current;
}

function eventRow(e, withTeam = true) {
  const where = e.stopPlace ? `${esc(e.stopPlace)}${e.idx != null ? ` · #${e.idx + 1}` : ''}` : '';
  const result = e.ok === null ? '' : e.ok ? '<span class="res-ok">ok</span>' : '<span class="res-no">failed</span>';
  const dist = e.distM != null ? `${Math.round(e.distM)} m` : '';
  return `<tr><td class="digits">${clock(e.at)}</td>${withTeam ? `<td>${esc(e.teamName || '')}</td>` : ''}<td>${esc(e.userName || '')}</td><td><span class="tag-k ${esc(e.kind)}">${esc(KIND_LABEL[e.kind] || e.kind)}</span></td><td>${where}</td><td>${result}</td><td class="digits">${dist}</td><td class="detail">${esc(e.detail || '')}</td></tr>`;
}
function eventsTable(rows, withTeam = true) {
  if (!rows.length) return '';
  return `<table class="tbl"><thead><tr><th>Time</th>${withTeam ? '<th>Team</th>' : ''}<th>Player</th><th>Event</th><th>Where</th><th>Result</th><th>Dist</th><th>Detail</th></tr></thead><tbody>${rows.map((e) => eventRow(e, withTeam)).join('')}</tbody></table>`;
}

function matches(e) {
  const q = A.logFilter.q.toLowerCase();
  return !q || [e.userName, e.teamName, e.stopPlace, e.detail, e.kind].some((v) => String(v || '').toLowerCase().includes(q));
}
function renderLog() {
  const rows = A.events.filter(matches);
  $('#logBody').innerHTML = rows.map((e) => eventRow(e)).join('') || '<tr><td colspan="8" class="empty">No events match.</td></tr>';
  $('#logCount').textContent = `${rows.length} shown${rows.length !== A.events.length ? ` of ${A.events.length}` : ''}`;
}

async function loadEvents(reset) {
  const before = reset ? null : A.logOldest;
  try {
    const rows = await api.adminEvents({ limit: 100, before, team: A.logFilter.team || null, kind: A.logFilter.kind || null });
    A.events = reset ? rows : [...A.events, ...rows];
    A.logOldest = A.events.length ? Math.min(...A.events.map((e) => e.id)) : null;
    $('#logMore').hidden = rows.length < 100;
    renderLog();
  } catch (error) { console.warn(error); }
}
$('#logKind').addEventListener('change', (e) => { A.logFilter.kind = e.target.value; loadEvents(true); });
$('#logTeam').addEventListener('change', (e) => { A.logFilter.team = e.target.value; loadEvents(true); });
$('#logSearch').addEventListener('input', (e) => { A.logFilter.q = e.target.value; renderLog(); });
$('#logMore').addEventListener('click', () => loadEvents(false));

// ---------- players report: everyone, with how many questions they solved, sortable ----------
const SORTERS = {
  name: (a, b) => String(a.name).localeCompare(String(b.name)),
  team: (a, b) => String(a.teamName ?? '~').localeCompare(String(b.teamName ?? '~')),
  solves: (a, b) => a.solves - b.solves,
  wrong: (a, b) => a.wrong - b.wrong,
  unlocks: (a, b) => a.unlocks - b.unlocks,
  lastSeen: (a, b) => (Date.parse(a.lastSeen || 0) || 0) - (Date.parse(b.lastSeen || 0) || 0),
};
A.players = []; A.plSort = { key: 'solves', dir: 'desc' };
function sortedPlayers() {
  const q = $('#plSearch').value.trim().toLowerCase();
  const rows = A.players.filter((p) => !q || [p.name, p.email, p.teamName].some((v) => String(v ?? '').toLowerCase().includes(q)));
  const { key, dir } = A.plSort;
  return rows.sort((a, b) => (SORTERS[key](a, b) || SORTERS.name(a, b)) * (dir === 'desc' ? -1 : 1));
}
function renderPlayersReport() {
  const rows = sortedPlayers();
  $('#plCount').textContent = `${rows.length} player${rows.length === 1 ? '' : 's'} · ${rows.reduce((n, p) => n + p.solves, 0)} questions solved`;
  $('#plBody').innerHTML = rows.map((p) => `<tr><td><b>${esc(p.name)}</b><br><small class="muted">${esc(p.email)}</small></td><td>${p.teamName ? esc(p.teamName) : '<span class="muted">no team</span>'}${p.finished ? ' <span class="mini warn">finished</span>' : ''}</td><td class="digits solved-n">${p.solves}</td><td class="digits">${p.wrong}</td><td class="digits">${p.unlocks}</td><td>${p.lastSeen ? ago(p.lastSeen) : '<span class="muted">never</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No players match.</td></tr>';
  document.querySelectorAll('.pl-table th button').forEach((b) => { b.dataset.dir = b.dataset.sort === A.plSort.key ? A.plSort.dir : ''; });
  $('#plSort').value = `${A.plSort.key}:${A.plSort.dir}` in Object.fromEntries([...$('#plSort').options].map((o) => [o.value, 1])) ? `${A.plSort.key}:${A.plSort.dir}` : $('#plSort').value;
}
async function refreshPlayersReport() {
  try { A.players = await api.adminPlayers(); } catch (error) { console.warn(error); return; }
  renderPlayersReport();
}
$('#plSearch').addEventListener('input', renderPlayersReport);
$('#plSort').addEventListener('change', (e) => { const [key, dir] = e.target.value.split(':'); A.plSort = { key, dir }; renderPlayersReport(); });
document.querySelector('.pl-table thead').addEventListener('click', (e) => {
  const key = e.target.closest('[data-sort]')?.dataset.sort;
  if (!key) return;
  A.plSort = { key, dir: A.plSort.key === key && A.plSort.dir === 'desc' ? 'asc' : 'desc' };
  renderPlayersReport();
});
$('#plExport').addEventListener('click', () => {
  const rows = [['Player', 'Email', 'Team', 'Questions solved', 'Wrong guesses', 'Unlocks', 'Last seen'], ...sortedPlayers().map((p) => [p.name, p.email, p.teamName ?? '', p.solves, p.wrong, p.unlocks, p.lastSeen ?? ''])];
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: 'kryptex-players.csv' }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

function setPane(pane) {
  A.pane = pane;
  $('#paneTeams').hidden = pane !== 'teams';
  $('#panePlayers').hidden = pane !== 'players';
  $('#paneLog').hidden = pane !== 'log';
  $('#segTeams').setAttribute('aria-selected', String(pane === 'teams'));
  $('#segPlayers').setAttribute('aria-selected', String(pane === 'players'));
  $('#segLog').setAttribute('aria-selected', String(pane === 'log'));
  if (pane === 'teams') refreshTeams(); else if (pane === 'players') refreshPlayersReport(); else loadEvents(true);
}
$('#segTeams').addEventListener('click', () => setPane('teams'));
$('#segLog').addEventListener('click', () => setPane('log'));
$('#segPlayers').addEventListener('click', () => setPane('players'));

// ---------- locations + photos + event tabs ----------
let content; let photos; let ev;
function wireContent() {
  content = initContent({
    toast,
    mapCenter: () => { const c = A.map?.getCenter() ?? { lat: CONFIG.campus.lat, lng: CONFIG.campus.lng }; return { lat: c.lat, lng: c.lng }; },
    placeOnMap(id) { switchTab('map'); selectStop(id); A.relocating = true; renderReloc(); toast('Click the map where this location should be, then Save.'); },
    onChanged: refreshStopsFromContent,
  });
  photos = initPhotos({ toast, ago, onChanged: refreshPhotoBadge });
  ev = initEvent({ toast, ago, mapCenter: () => { const c = A.map?.getCenter() ?? { lat: CONFIG.campus.lat, lng: CONFIG.campus.lng }; return { lat: c.lat, lng: c.lng }; }, flyTo: (lat, lng) => { switchTab('map'); A.map?.flyTo({ center: [lng, lat], zoom: 19, essential: true }); }, onZonesChanged: drawZones, onStatusChanged: refreshStatus });
  setInterval(async () => { const n = await ev.helpCount(); const b = $('#helpBadge'); b.hidden = n === 0; b.textContent = n; if (A.tab === 'event') ev.refresh(); }, 8000);
  refreshPhotoBadge();
  setInterval(refreshPhotoBadge, 10000);
}
async function refreshStopsFromContent() {
  A.stops = await api.adminStops();
  A.stopMarkers.forEach(({ marker }) => marker.remove()); A.stopMarkers.clear();
  A.stops.forEach(addStopMarker);
  if (A.selectedStop && !stopById(A.selectedStop)) { A.selectedStop = null; A.draft = null; }
  renderMarkers(); renderReloc(); drawRadius();
}
async function refreshPhotoBadge() {
  const n = await photos.pendingCount();
  const badge = $('#photoBadge');
  badge.hidden = n === 0; badge.textContent = n;
}

// ---------- tabs ----------
function switchTab(tab) {
  A.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  ['map', 'teams', 'content', 'photos', 'event'].forEach((name) => { $(`#view-${name}`).hidden = name !== tab; });
  $('#alertBar').classList.toggle('off', !['map', 'teams'].includes(tab));
  if (tab === 'map') A.map?.resize();
  if (tab === 'teams') setPane(A.pane);
  if (tab === 'content') content.show();
  if (tab === 'photos') photos.show();
  if (tab === 'event') ev.show();
}
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]')?.dataset.tab;
  if (tab) switchTab(tab);
});

$('#signInButton').addEventListener('click', () => api.signInWithGoogle().catch((error) => toast(error.message)));
$('#signOut').addEventListener('click', async () => { await api.signOut(); location.reload(); });

boot();
