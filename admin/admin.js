import { CONFIG } from '../js/config.js';
import * as api from '../js/api.js';
import { distanceM } from '../js/geo.js';
import { loadMapLibre, buildStyle, whenLoaded, circlePolygon, stopMarkerElement } from '../js/map-core.js';
import { initContent, initPhotos } from './content.js';
import { initEvent } from './event.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#4285F4', '#EA4335', '#FBBC05', '#34A853'];
const ONLINE_MS = 90_000;
const KIND_LABEL = { team_created: 'Team created', team_joined: 'Joined team', team_left: 'Left team', team_kicked: 'Removed', team_locked: 'Team locked', unlock: 'Unlock', flag: 'Flag', photo: 'Photo', stop_moved: 'Stop moved', checkin: 'Base check-in', hub_flag: 'Flag handed in', qr: 'QR scan', finished: 'Finished', admin_action: 'Admin action', broadcast: 'Broadcast', discover: 'Discovered', help: 'Help request', game: 'Event control', content: 'Content edit', photo_review: 'Photo review' };

const A = {
  stops: [], live: null, teams: [], events: [], tab: 'map', skew: 0,
  selectedStop: null, draft: null, relocating: false, selectedTeam: null, teamEvents: [],
  alerts: [], map: null, maplibregl: null, stopMarkers: new Map(), coinMarkers: new Map(), logOldest: null, logFilter: { kind: '', team: '', q: '' },
};
let toastTimer;

function toast(message) {
  const el = $('#toast');
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
const hash = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const teamColor = (teamId) => (teamId ? COLORS[hash(teamId) % 4] : '#6b7390');
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
  try { A.stops = await api.adminStops(); } catch (error) { toast('Could not load stops.'); console.error(error); }
  buildFilters();
  await initMap();
  wireContent();
  await refreshLive();
  setInterval(refreshLive, 3000);
  setInterval(() => { if (A.tab === 'teams') refreshTeams(); if (A.tab === 'log' && $('#logLive').checked) loadEvents(true); }, 6000);
  refreshTeams();
  refreshAlerts();
  setInterval(refreshAlerts, 10000);
}

// ---------- counters ----------
function renderCounters() {
  const live = A.live;
  if (!live) return;
  const online = live.players.filter(isOnline).length;
  const cell = (label, value, extra = '', hot = '') => `<div class="counter ${hot}"><small>${label}</small><strong>${value}${extra}</strong></div>`;
  $('#counters').innerHTML = cell('PLAYERS ONLINE', online, ` <i>/ ${live.registered} registered</i>`, 'hot') +
    cell('TEAMS', live.teams, ` <i>${live.lockedTeams} locked</i>`) +
    cell('FLAGS SOLVED', live.flagsSolved, ` <i>/ ${totalFlags() * Math.max(1, live.lockedTeams)}</i>`);
  $('#playerCount').textContent = `· ${online} online`;
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
  A.map.addLayer({ id: 'radius-fill', type: 'fill', source: 'radius', paint: { 'fill-color': '#FBBC05', 'fill-opacity': 0.14 } });
  A.map.addLayer({ id: 'radius-line', type: 'line', source: 'radius', paint: { 'line-color': '#FBBC05', 'line-width': 2, 'line-dasharray': [2, 2] } });
  A.map.addSource('zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  A.map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', filter: ['==', ['get', 'kind'], 'nogo'], paint: { 'fill-color': '#EA4335', 'fill-opacity': 0.22 } });
  A.map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'nogo'], '#EA4335', '#4285F4'], 'line-width': 2, 'line-dasharray': [3, 2] } });
  api.adminGame().then((g) => drawZones(g.bounds, g.noGo)).catch(() => {});
  A.stops.forEach(addStopMarker);
  A.map.on('click', (e) => { if (A.relocating) setDraft({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
  renderStops();
}

function drawZones(bounds, noGo) {
  const features = [];
  if (bounds) features.push({ ...circlePolygon(bounds, bounds.radius), properties: { kind: 'bounds' } });
  (noGo || []).forEach((z) => features.push({ ...circlePolygon(z, z.radius), properties: { kind: 'nogo' } }));
  A.map.getSource('zones')?.setData({ type: 'FeatureCollection', features });
}

function addStopMarker(stop) {
  const el = stopMarkerElement(stop);
  el.classList.remove('locked'); el.classList.add('open');
  el.addEventListener('click', (e) => { e.stopPropagation(); selectStop(stop.id); });
  const marker = new A.maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([stop.lng, stop.lat]).addTo(A.map);
  A.stopMarkers.set(stop.id, { el, marker });
}

function renderCoins() {
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
  if (p) A.map.flyTo({ center: [p.lng, p.lat], zoom: 19, essential: true });
}

// ---------- stops: list + editor ----------
const stopById = (id) => A.stops.find((s) => s.id === id);
function hereCount(stop) {
  return (A.live?.players || []).filter((p) => isOnline(p) && distanceM(p, stop) <= stop.radius).length;
}
function renderStopList() {
  $('#stopList').innerHTML = A.stops.map((s) => `<button type="button" class="stop-row ${A.selectedStop === s.id ? 'active' : ''}" data-stop="${esc(s.id)}"><span class="ico">${esc(s.icon)}</span><span class="meta"><strong>${esc(s.place)}${s.role === 'hub' ? ' <span class="role-badge">base</span>' : s.role === 'bonus' ? ' <span class="role-badge">bonus</span>' : ''}</strong><small>${esc(s.label)} · r ${s.radius} m${hereCount(s) ? ` · <b style="color:var(--green)">${hereCount(s)} here now</b>` : ''}</small></span></button>`).join('');
  A.stopMarkers.forEach(({ el }, id) => el.classList.toggle('selected', id === A.selectedStop));
}
function renderStops() { renderStopList(); renderEditor(); }

function selectStop(id) {
  if (A.relocating) cancelEdit();
  A.selectedStop = id;
  const stop = stopById(id);
  A.draft = { lat: stop.lat, lng: stop.lng, radius: stop.radius, place: stop.place, name: stop.name };
  A.relocating = false;
  A.map.flyTo({ center: [stop.lng, stop.lat], zoom: Math.max(A.map.getZoom(), 18.4), essential: true });
  renderStops(); drawRadius();
}

function dirty() {
  const stop = stopById(A.selectedStop);
  if (!stop || !A.draft) return false;
  return stop.lat !== A.draft.lat || stop.lng !== A.draft.lng || stop.radius !== A.draft.radius || stop.place !== A.draft.place || stop.name !== A.draft.name;
}

function renderEditor() {
  const el = $('#stopEditor');
  const stop = stopById(A.selectedStop);
  el.hidden = !stop;
  $('#relocateHint').hidden = !A.relocating;
  if (!stop) return;
  const moved = Math.round(distanceM(stop, A.draft));
  el.innerHTML = `<strong>${esc(stop.label)}</strong>
    <label>PLACE NAME<input type="text" id="edPlace" value="${esc(A.draft.place)}" maxlength="40" /></label>
    <label>QUEST TITLE<input type="text" id="edName" value="${esc(A.draft.name)}" maxlength="40" /></label>
    <label><span>INTERACT RADIUS · <b id="edRadiusVal">${A.draft.radius} m</b></span><input type="range" id="edRadius" min="10" max="200" step="5" value="${A.draft.radius}" /></label>
    <div class="coords">${A.draft.lat.toFixed(6)}, ${A.draft.lng.toFixed(6)}${moved ? ` · moved ${moved} m` : ''}</div>
    <div class="row"><button type="button" class="relocate ${A.relocating ? 'on' : ''}" id="edRelocate">${A.relocating ? 'Click the map…' : 'Move on map'}</button></div>
    <div class="row"><button type="button" id="edCancel">Reset</button><button type="button" class="save" id="edSave" ${dirty() ? '' : 'disabled'}>Save</button></div>`;
}

function setDraft(patch) {
  A.draft = { ...A.draft, ...patch };
  const entry = A.stopMarkers.get(A.selectedStop);
  entry?.marker.setLngLat([A.draft.lng, A.draft.lat]);
  if (patch.lat != null) A.relocating = false;
  drawRadius(); renderEditor();
}
function drawRadius() {
  const features = A.draft && A.selectedStop ? [circlePolygon(A.draft, A.draft.radius)] : [];
  A.map.getSource('radius').setData({ type: 'FeatureCollection', features });
}
function cancelEdit() {
  const stop = stopById(A.selectedStop);
  if (!stop) return;
  A.stopMarkers.get(stop.id)?.marker.setLngLat([stop.lng, stop.lat]);
  A.draft = { lat: stop.lat, lng: stop.lng, radius: stop.radius, place: stop.place, name: stop.name };
  A.relocating = false;
  drawRadius(); renderEditor();
}

$('#stopList').addEventListener('click', (e) => { const row = e.target.closest('[data-stop]'); if (row) selectStop(row.dataset.stop); });
$('#stopEditor').addEventListener('click', async (e) => {
  if (e.target.id === 'edRelocate') { A.relocating = !A.relocating; renderEditor(); }
  if (e.target.id === 'edCancel') cancelEdit();
  if (e.target.id === 'edSave') {
    const id = A.selectedStop;
    const result = await api.adminSaveStop(id, { lat: A.draft.lat, lng: A.draft.lng, radius: A.draft.radius, place: A.draft.place.trim(), name: A.draft.name.trim() });
    if (!result.ok) { toast(result.error || 'Could not save.'); return; }
    A.stops = await api.adminStops();
    const stop = stopById(id);
    A.draft = { lat: stop.lat, lng: stop.lng, radius: stop.radius, place: stop.place, name: stop.name };
    const marker = A.stopMarkers.get(id).el;
    marker.querySelector('.stop-label').textContent = stop.place; marker.setAttribute('aria-label', stop.place);
    renderStops(); toast(`${stop.place} saved. Players see the new spot on their next load.`);
  }
});
$('#stopEditor').addEventListener('input', (e) => {
  if (e.target.id === 'edPlace') { A.draft.place = e.target.value; $('#edSave').disabled = !dirty(); }
  if (e.target.id === 'edName') { A.draft.name = e.target.value; $('#edSave').disabled = !dirty(); }
  if (e.target.id === 'edRadius') { A.draft.radius = Number(e.target.value); $('#edRadiusVal').textContent = `${A.draft.radius} m`; drawRadius(); $('#edSave').disabled = !dirty(); }
});

$('#tilt').addEventListener('click', () => A.map.easeTo({ pitch: A.map.getPitch() > 10 ? 0 : 55, duration: 500 }));
$('#fitAll').addEventListener('click', () => {
  const bounds = new A.maplibregl.LngLatBounds();
  A.stops.forEach((s) => bounds.extend([s.lng, s.lat]));
  A.live?.players.forEach((p) => bounds.extend([p.lng, p.lat]));
  A.map.fitBounds(bounds, { padding: 90, maxZoom: 19, duration: 600 });
});

// ---------- players ----------
function renderPlayers() {
  const players = [...(A.live?.players || [])].sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || a.name.localeCompare(b.name));
  $('#playerList').innerHTML = players.length ? players.map((p) => `<button type="button" class="player-row ${isOnline(p) ? '' : 'stale'}" data-player="${esc(p.id)}" style="--c:${teamColor(p.teamId)}"><span class="dot"></span><span class="meta"><strong>${esc(p.name)}</strong><small>${esc(p.teamName || 'no team')} · ±${Math.round(p.accuracy || 0)} m</small></span><small>${ago(p.updatedAt)}</small></button>`).join('')
    : '<div class="empty">No players have reported a location yet.</div>';
}
$('#playerList').addEventListener('click', (e) => { const row = e.target.closest('[data-player]'); if (row) focusPlayer(row.dataset.player); });

async function refreshLive() {
  try {
    A.live = await api.adminLive();
    A.skew = Date.parse(A.live.now) - Date.now();
    renderCounters(); renderCoins(); renderPlayers(); renderStopList();
  } catch (error) { console.warn('live refresh failed', error); }
}

// ---------- alerts: teams that need an organiser ----------
async function refreshAlerts() {
  try { A.alerts = await api.adminAlerts(); } catch (error) { console.warn('alerts failed', error); return; }
  const bar = $('#alertBar');
  bar.hidden = !A.alerts.length;
  bar.innerHTML = A.alerts.map((a, i) => `<div class="alert ${a.kind}">${a.kind === 'stalled'
      ? `⏱ <b>${esc(a.teamName)}</b> has done nothing for ${a.minutes} min`
      : `⚠ <b>${esc(a.teamName)}</b> got “${esc(a.title || 'a question')}” wrong ${a.wrong}× in 15 min`}
      <button type="button" data-alert-hint="${i}">Send hint</button><button type="button" data-alert-open="${i}">Open team</button></div>`).join('');
  if (A.tab === 'teams') renderTeamList();
}
$('#alertBar').addEventListener('click', async (e) => {
  const hint = e.target.closest('[data-alert-hint]'); const open = e.target.closest('[data-alert-open]');
  if (hint) await sendHint(A.alerts[Number(hint.dataset.alertHint)].teamId);
  if (open) { A.selectedTeam = A.alerts[Number(open.dataset.alertOpen)].teamId; document.querySelector('[data-tab=teams]').click(); await refreshTeams(); }
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

async function refreshTeams() {
  try { A.teams = await api.adminTeams(); } catch (error) { console.warn(error); return; }
  fillTeamFilter();
  renderTeamList();
  await renderTeamDetail();
}

function renderTeamList() {
  const sorted = [...A.teams].sort((a, b) => b.solved.length - a.solved.length || String(a.name).localeCompare(b.name));
  $('#teamList').innerHTML = sorted.length ? sorted.map((t) => `<button type="button" class="team-item ${A.selectedTeam === t.id ? 'active' : ''}" data-team="${esc(t.id)}">
      <div class="top"><strong>${esc(t.name)}${t.isTest ? ' <span class="mini test">TEST</span>' : ''}${A.alerts.some((a) => a.teamId === t.id) ? '<span class="flag-alert" title="Needs attention">⚠</span>' : ''}</strong><span class="score">${t.solved.length}/${totalFlags()}</span></div>
      <div class="pips">${A.stops.flatMap((s) => s.puzzles.map((p) => `<i class="${p.kind} ${t.solved.some((x) => x.stopId === s.id && x.idx === p.idx) ? 'on' : ''}"></i>`)).join('')}</div>
      <small>${t.members.length} players · ${stopsCleared(t)}/${A.stops.length} stops cleared · ${t.locked ? 'locked' : 'not locked'} · active ${ago(t.lastActivity)}</small></button>`).join('')
    : '<div class="empty">No teams yet.</div>';
}

async function renderTeamDetail() {
  const t = A.teams.find((x) => x.id === A.selectedTeam);
  const box = $('#teamDetail');
  if (!t) { box.innerHTML = '<div class="empty">Pick a team to see every flag and who solved it.</div>'; return; }
  const maxSolves = Math.max(1, ...t.members.map((m) => m.solves));
  A.teamEvents = await api.adminEvents({ limit: 60, team: t.id }).catch(() => []);
  const playable = A.stops.filter((s) => s.role !== 'hub');
  const act = (a, extra = '') => `data-act="${a}" ${extra}`;
  const byStop = playable.map((s) => `<div class="stop-prog"><div class="head"><span>${esc(s.icon)} ${esc(s.place)}${t.hubFlags?.includes(s.id) ? ' <span class="mini">flag handed in</span>' : ''}</span><span>${t.solved.filter((x) => x.stopId === s.id).length}/${s.puzzles.length}${t.unlocked.some((u) => u.stopId === s.id) || s.entryMode === 'open' ? '' : ' · locked'}
        <button type="button" class="mini" ${act('grant_stop', `data-stop="${esc(s.id)}"`)} title="Unlock and mark every question solved (use when a location is blocked)">bypass</button>${s.role === 'stop' && !t.hubFlags?.includes(s.id) ? `<button type="button" class="mini" ${act('grant_hub_flag', `data-stop="${esc(s.id)}"`)} title="Count this location's flag as handed in at the base">hand in</button>` : ''}</span></div>
      ${s.puzzles.map((p) => { const hit = t.solved.find((x) => x.stopId === s.id && x.idx === p.idx); return hit
        ? `<div class="flag-line"><span class="tick">✓</span><span>${esc(p.title)} <small style="color:var(--muted)">${p.kind}</small></span><span>by <b>${esc(hit.userName)}</b></span><span class="t">${clock(hit.at)} <button type="button" class="mini" ${act('revoke_puzzle', `data-stop="${esc(s.id)}" data-idx="${p.idx}"`)}>revoke</button></span></div>`
        : `<div class="flag-line todo"><span>○</span><span>${esc(p.title)} <small>${p.kind}</small></span><span class="t"><button type="button" class="mini" ${act('grant_puzzle', `data-stop="${esc(s.id)}" data-idx="${p.idx}"`)}>mark solved</button></span></div>`; }).join('')}</div>`).join('');
  const others = A.teams.filter((x) => x.id !== t.id);
  const actionsPanel = `<div class="panel"><h3>ORGANISER ACTIONS</h3><div class="team-actions">
      <button type="button" class="btn" ${act(t.locked ? 'unlock_team' : 'lock_team')}>${t.locked ? 'Unlock team (let them edit)' : 'Lock team'}</button>
      <button type="button" class="btn" ${act('hint')}>Send them a hint</button>
      <button type="button" class="btn" ${act('rename')}>Rename</button>
      ${t.startedAt ? '' : `<button type="button" class="btn" ${act('check_in')}>Check in for them</button>`}
      ${t.finishedAt ? `<button type="button" class="btn" ${act('clear_finish')}>Clear finish</button>` : ''}
      <button type="button" class="btn danger" ${act('reset_progress')}>Reset progress</button>
      <button type="button" class="btn danger" ${act('disband')}>Disband team</button></div>
      <table><thead><tr><th>Member</th><th></th></tr></thead><tbody>${t.members.map((m) => `<tr><td>${esc(m.name)}${m.isLeader ? ' <span class="mini warn">leader</span>' : ''}</td><td class="team-actions"><button type="button" class="mini" ${act('remove_member', `data-user="${esc(m.id)}"`)}>remove</button>
        ${others.length ? `<select data-move-to="${esc(m.id)}"><option value="">move to…</option>${others.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
  box.innerHTML = `<div><h2>${esc(t.name)}</h2><div class="chips" style="margin-top:8px">
      <span class="pill">Code <b>${esc(t.code)}</b></span><span class="pill ${t.locked ? 'good' : 'warn'}">${t.locked ? `Locked ${t.lockedAt ? clock(t.lockedAt) : ''}` : 'Not locked yet'}</span>
      <span class="pill">Flags <b>${t.solved.length}/${totalFlags()}</b></span><span class="pill">Locations cleared <b>${stopsCleared(t)}/${playable.length}</b></span><span class="pill">Handed in <b>${t.hubFlags?.length ?? 0}/${playable.filter((s) => s.role === 'stop').length}</b></span>
      <span class="pill ${t.startedAt ? 'good' : 'warn'}">${t.startedAt ? `Started ${clock(t.startedAt)}` : 'Not checked in'}</span>${t.finishedAt ? `<span class="pill good">🏁 Finished ${clock(t.finishedAt)}</span>` : ''}
      <span class="pill">Wrong guesses <b>${t.members.reduce((n, m) => n + m.wrong, 0)}</b></span><span class="pill">Last activity <b>${ago(t.lastActivity)}</b></span></div></div>
    <div class="panel"><h3>PLAYER CONTRIBUTION</h3><table><thead><tr><th>Player</th><th>Flags solved</th><th>Unlocks</th><th>Wrong guesses</th><th>Last seen</th></tr></thead><tbody>
      ${t.members.map((m) => `<tr><td><b>${esc(m.name)}</b>${m.isLeader ? ' <span class="pill warn">leader</span>' : ''}<br><small style="color:var(--muted)">${esc(m.email)}</small></td>
        <td class="bar-cell">${m.solves} <small style="color:var(--muted)">(${t.solved.length ? Math.round((m.solves / t.solved.length) * 100) : 0}%)</small><div class="mini-bar"><i style="width:${(m.solves / maxSolves) * 100}%"></i></div></td>
        <td>${m.unlocks}</td><td>${m.wrong}</td><td>${ago(m.lastSeen)}</td></tr>`).join('')}</tbody></table></div>
    ${actionsPanel}
    <div class="panel"><h3>FLAGS BY STOP</h3><div style="display:grid;gap:10px">${byStop}</div></div>
    <div class="panel"><h3>TEAM TIMELINE</h3>${eventsTable(A.teamEvents, false) || '<div class="empty">Nothing yet.</div>'}</div>`;
}
$('#teamDetail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !A.selectedTeam) return;
  const action = b.dataset.act;
  const team = A.teams.find((x) => x.id === A.selectedTeam);
  if (action === 'hint') return sendHint(A.selectedTeam);
  const body = { action, team: A.selectedTeam, stop: b.dataset.stop, idx: b.dataset.idx != null ? Number(b.dataset.idx) : undefined, user: b.dataset.user };
  if (action === 'rename') { body.name = prompt('New team name', team.name); if (!body.name) return; }
  if (action === 'reset_progress' && !confirm(`Reset ALL progress for ${team.name}? Their solves, unlocks, check-in and photos are erased.`)) return;
  if (action === 'disband' && !confirm(`Disband ${team.name}? The team and its progress are deleted.`)) return;
  if (action === 'grant_stop' && !confirm('Unlock this location for the team and mark all its questions solved?')) return;
  const result = await api.adminTeamAction(body);
  if (!result.ok) return toast(result.error || 'Could not do that.');
  toast(result.note || 'Done.');
  if (action === 'disband') A.selectedTeam = null;
  await refreshTeams();
});
$('#teamDetail').addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-move-to]');
  if (!sel || !sel.value) return;
  const result = await api.adminTeamAction({ action: 'move_member', team: A.selectedTeam, user: sel.dataset.moveTo, to: sel.value });
  toast(result.ok ? 'Moved.' : result.error);
  await refreshTeams();
});
$('#teamList').addEventListener('click', (e) => { const item = e.target.closest('[data-team]'); if (item) { A.selectedTeam = item.dataset.team; renderTeamList(); renderTeamDetail(); } });

// ---------- activity log ----------
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
  const result = e.ok === null ? '' : e.ok ? '<span class="res-ok">✓ ok</span>' : '<span class="res-no">✗ failed</span>';
  const dist = e.distM != null ? `${Math.round(e.distM)} m` : '';
  return `<tr><td>${clock(e.at)}</td>${withTeam ? `<td>${esc(e.teamName || '')}</td>` : ''}<td>${esc(e.userName || '')}</td><td><span class="tag-k ${esc(e.kind)}">${esc(KIND_LABEL[e.kind] || e.kind)}</span></td><td>${where}</td><td>${result}</td><td>${dist}</td><td>${esc(e.detail || '')}</td></tr>`;
}
function eventsTable(rows, withTeam = true) {
  if (!rows.length) return '';
  return `<table><thead><tr><th>Time</th>${withTeam ? '<th>Team</th>' : ''}<th>Player</th><th>Event</th><th>Where</th><th>Result</th><th>Dist</th><th>Detail</th></tr></thead><tbody>${rows.map((e) => eventRow(e, withTeam)).join('')}</tbody></table>`;
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

// ---------- content + photos tabs ----------
let content; let photos; let ev;
function wireContent() {
  content = initContent({
    toast,
    mapCenter: () => { const c = A.map.getCenter(); return { lat: c.lat, lng: c.lng }; },
    placeOnMap(id) { switchTab('map'); selectStop(id); A.relocating = true; renderEditor(); toast('Click the map where this location should be, then Save.'); },
    onChanged: refreshStopsFromContent,
  });
  photos = initPhotos({ toast, ago, onChanged: refreshPhotoBadge });
  ev = initEvent({ toast, ago, mapCenter: () => { const c = A.map.getCenter(); return { lat: c.lat, lng: c.lng }; }, flyTo: (lat, lng) => { switchTab('map'); A.map.flyTo({ center: [lng, lat], zoom: 19, essential: true }); }, onZonesChanged: drawZones });
  setInterval(async () => { const n = await ev.helpCount(); const b = $('#helpBadge'); b.hidden = n === 0; b.textContent = n; if (A.tab === 'event') ev.refresh(); }, 8000);
  refreshPhotoBadge();
  setInterval(refreshPhotoBadge, 10000);
}
async function refreshStopsFromContent() {
  A.stops = await api.adminStops();
  A.stopMarkers.forEach(({ marker }) => marker.remove()); A.stopMarkers.clear();
  A.stops.forEach(addStopMarker);
  if (A.selectedStop && !stopById(A.selectedStop)) { A.selectedStop = null; A.draft = null; }
  renderStops(); drawRadius();
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
  ['map', 'teams', 'log', 'content', 'photos', 'event'].forEach((name) => { $(`#view-${name}`).hidden = name !== tab; });
  if (tab === 'map') A.map.resize();
  if (tab === 'teams') refreshTeams();
  if (tab === 'log') loadEvents(true);
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
