// The "Event" tab: start / pause / end, broadcast, quest area + no-go zones, help requests, standings, exports, data purge.
import * as api from '../js/api.js';
import { icon } from '../js/icons.js';
import { DEMO_STOPS } from '../js/data.js';
import { distanceM } from '../js/geo.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);
const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}h ` : ''}${Math.floor((s % 3600) / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);

function download(name, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function initEvent({ toast, mapCenter, flyTo, onZonesChanged, onStatusChanged, ago }) {
  const E = { game: null, zones: [], bounds: null, help: [], standings: null };

  async function load() {
    try { E.game = await api.adminGame(); } catch (error) { console.warn(error); return; }
    E.zones = (E.game.noGo || []).map((z) => ({ ...z }));
    E.bounds = E.game.bounds ? { ...E.game.bounds } : null;
    renderStatus(); renderSurprise(); renderBroadcast(); renderSafety(); renderData();
    renderReady();
    await refreshLive();
  }

  async function refreshLive() {
    try { E.help = await api.adminHelpRequests(); renderHelp(); } catch (error) { console.warn(error); }
    try { E.standings = await api.adminLeaderboard(); renderStandings(); } catch (error) { console.warn(error); }
  }

  // ---------- pre-event checklist ----------
  const PRINTED_KEY = 'kq-admin-qr-printed';
  const printed = () => { try { return JSON.parse(localStorage.getItem(PRINTED_KEY) || '{}'); } catch { return {}; } };
  const MIN_REFS = 3; const GOOD_REFS = 8;
  /** Everything an organiser should be sure of before the doors open. level: bad (blocks play) | warn | ok */
  function checks(stops, game) {
    const out = [];
    const add = (level, text) => out.push({ level, text });
    const sample = new Map(DEMO_STOPS.map((d) => [d.id, d]));
    const hub = stops.find((s) => s.role === 'hub');
    const regular = stops.filter((s) => s.role === 'stop');
    if (!hub) add('bad', 'No base location exists. Players cannot check in.');
    if (!regular.length) add('bad', 'No regular locations exist.');
    const flags = new Map();
    const seen = (flag, where) => { const k = String(flag || '').trim().toUpperCase(); if (k) flags.set(k, [...(flags.get(k) || []), where]); };
    stops.forEach((s) => {
      const label = s.place || s.id;
      const d = sample.get(s.id);
      if (d && Math.abs(d.lat - s.lat) < 1e-5 && Math.abs(d.lng - s.lng) < 1e-5) add('warn', `${label}: still at the provisional sample coordinates. Walk there and drag it into place.`);
      if (s.role === 'stop') {
        if (s.puzzles.length < 2) add('bad', `${label}: has ${s.puzzles.length} question${s.puzzles.length === 1 ? '' : 's'} (the plan is 2-3).`);
        if (!String(s.exitFlag || '').trim()) add('bad', `${label}: no location code (handed in at the base).`);
        if (!String(s.hint || '').trim()) add('warn', `${label}: no hint. The base shows nothing to find it by.`);
        if (s.entryKind === 'photo') {
          const n = (s.entryRefs || []).length;
          if (!String(s.entryQuestion || '').trim()) add('bad', `${label}: image unlock has no clue.`);
          if (n < GOOD_REFS) add(n < MIN_REFS ? 'bad' : 'warn', `${label}: ${n} unlock reference photos (${MIN_REFS} is the minimum, aim for about 10).`);
        } else {
          if (String(s.entryQuestion || '').trim() && !String(s.entryAnswer || '').trim()) add('bad', `${label}: has an unlock question but no flag, so nobody can answer it.`);
          if (!String(s.entryAnswer || '').trim()) add('warn', `${label}: no unlock flag, so it unlocks the moment a team discovers it (out-of-order discoveries still stay locked).`);
        }
        seen(s.exitFlag, `${label} code`); seen(s.entryAnswer, `${label} entry flag`);
      }
      s.puzzles.forEach((p) => {
        const q = `${label} Q${p.idx + 1}`;
        if (p.kind === 'photo') {
          if (!String(p.prompt || '').trim()) add('bad', `${q}: image question has no clue.`);
          if ((p.refs || []).length < GOOD_REFS) add((p.refs || []).length < MIN_REFS ? 'bad' : 'warn', `${q}: ${(p.refs || []).length} reference photos (${MIN_REFS} is the minimum, aim for about 10).`);
        } else {
          if (!String(p.flag || '').trim()) add('bad', `${q}: no answer flag.`);
          if (!String(p.questionUrl || '').trim()) add('bad', `${q}: no link to the question page, so players cannot open it.`);
        }
        if (p.kind !== 'photo') seen(p.flag, q);
      });
    });
    flags.forEach((where, flag) => { if (where.length > 1) add('warn', `Same flag ${flag} used in: ${where.join(', ')}.`); });
    const sampleFlags = new Set(DEMO_STOPS.flatMap((d) => [d.exitFlag, d.entryAnswer, ...d.puzzles.map((p) => p.flag)]).filter(Boolean).map((f) => f.toUpperCase()));
    const stillSample = [...flags.keys()].filter((f) => sampleFlags.has(f));
    if (stillSample.length) add('warn', `${stillSample.length} flag${stillSample.length > 1 ? 's are' : ' is'} still a sample from the demo (${stillSample.slice(0, 3).join(', ')}…). Use real, secret flags.`);
    for (let i = 0; i < stops.length; i += 1) for (let j = i + 1; j < stops.length; j += 1) {
      const a = stops[i]; const b = stops[j];
      if (a.role === 'bonus' || b.role === 'bonus') continue;
      const gap = distanceM(a, b);
      if (gap < a.radius + b.radius + 50) add('warn', `${a.place} and ${b.place} are only ${Math.round(gap)} m apart: walking into one can discover or unlock-range the other (radius ${a.radius} + ${b.radius} m + GPS slack).`);
    }
    const done = printed();
    regular.concat(hub ? [hub] : []).forEach((s) => { if (!done[s.id]) add('warn', `${s.place}: QR code not marked as printed and posted (indoor GPS fallback).`); });
    if (!game?.bounds) add('warn', 'No quest area set in the Safety panel (players could wander off campus).');
    if (!out.some((c) => c.level === 'bad')) add('ok', 'No blockers found.');
    return out;
  }
  async function renderReady() {
    let stops;
    try { stops = await api.adminContent(); } catch (error) { $('#evReady').innerHTML = '<h3>READY FOR THE EVENT?</h3><div class="empty">Could not load the content.</div>'; return; }
    const list = checks(stops, E.game);
    const bad = list.filter((c) => c.level === 'bad').length; const warn = list.filter((c) => c.level === 'warn').length;
    const done = printed();
    const qrRows = stops.filter((s) => s.role !== 'bonus').map((s) => `<label class="ready-row"><input type="checkbox" data-printed="${esc(s.id)}" ${done[s.id] ? 'checked' : ''} /> <span>${esc(s.place)}: QR printed &amp; posted</span></label>`).join('');
    $('#evReady').innerHTML = `<h3>READY FOR THE EVENT?</h3>
      <p class="ready-sum"><b style="color:${bad ? '#f28b82' : '#7fdc99'}">${bad} blocker${bad === 1 ? '' : 's'}</b> · <b style="color:#fdd663">${warn} warning${warn === 1 ? '' : 's'}</b> <button type="button" class="mini" id="evReadyRefresh">re-check</button></p>
      <div class="ready-list">${list.map((c) => `<div class="ready-row ${c.level}"><span>${icon({ bad: 'x', warn: 'bell', ok: 'check' }[c.level])}</span><span>${esc(c.text)}</span></div>`).join('')}</div>
      <details><summary class="hint">Tick off QR codes as you post them</summary><div class="ready-list">${qrRows}</div></details>`;
  }

  const statusLabel = { lobby: 'NOT STARTED', running: 'RUNNING', paused: 'PAUSED', ended: 'ENDED' };
  function renderStatus() {
    const g = E.game;
    const eff = g.effective || g.status;
    $('#evStatus').innerHTML = `<h3>QUEST STATUS</h3>
      <div><span class="status-pill ${eff}">${statusLabel[eff] || eff}</span>${g.status !== eff ? ` <span class="mini warn">set to ${g.status}, schedule decides</span>` : ''}</div>
      <div class="btn-row">
        <button type="button" class="btn save" data-game="running">${eff === 'paused' ? 'Resume' : 'Start now'}</button>
        <button type="button" class="btn" data-game="paused">Pause</button>
        <button type="button" class="btn danger" data-game="ended">End quest</button>
        <button type="button" class="btn" data-game="lobby">Back to lobby</button></div>
      <div class="form-grid">
        <label class="field">SCHEDULED START (OPTIONAL)<input type="datetime-local" id="evStart" value="${toLocalInput(g.startsAt)}" /></label>
        <label class="field">HARD END (OPTIONAL)<input type="datetime-local" id="evEnd" value="${toLocalInput(g.endsAt)}" /></label>
        <label class="field">PUBLIC BIG-SCREEN BOARD<select id="evBoard"><option value="false" ${!g.boardPublic ? 'selected' : ''}>Off</option><option value="true" ${g.boardPublic ? 'selected' : ''}>On (open /board/ on the projector)</option></select></label></div>
      <div class="btn-row"><button type="button" class="btn" id="evSaveSchedule">Save schedule and options</button></div>
      <p class="hint">While the quest is not running, players can look around but check-ins, unlocks, photos and flags are refused. Starting requires teams to be locked in.</p>`;
  }

  async function renderSurprise() {
    const list = await api.adminSurprises().catch(() => []);
    const live = list.find((q) => !q.closedAt);
    $('#evSurprise').innerHTML = `<h3>SURPRISE QUESTION</h3>
      <p class="hint">Drop a question mid-event. Every phone gets a banner, and it appears at the top of the base for each team to answer once. Dropping a new one closes the previous one.</p>
      ${live ? `<div class="qstat"><b>Live now:</b> ${esc(live.title)} · solved by ${live.solvedBy.length} team${live.solvedBy.length === 1 ? '' : 's'}${live.solvedBy.length ? ` (${esc(live.solvedBy.join(', '))})` : ''} <button type="button" class="btn danger" data-close-surprise="${live.id}">Close it</button></div>` : '<p class="hint">No surprise question is live.</p>'}
      <label class="field">QUESTION TITLE<textarea id="evSqTitle" rows="2" maxlength="300" placeholder="Which building has the largest reading room?"></textarea></label>
      <div class="form-grid"><label class="field">QUESTION LINK (OPTIONAL, HTTPS://...)<input id="evSqUrl" /></label>
        <label class="field">FLAG THAT SOLVES IT<input id="evSqFlag" autocomplete="off" /></label></div>
      <label class="field">BANNER TEXT (OPTIONAL)<input id="evSqAnnounce" maxlength="280" placeholder="Surprise question! Head to the base to answer it." /></label>
      <div class="btn-row"><button type="button" class="btn save" id="evSqDrop">Drop it now</button></div>
      ${list.length > (live ? 1 : 0) ? `<details class="fold"><summary>Earlier surprise questions</summary>${list.filter((q) => q.closedAt).map((q) => `<p class="hint">${esc(q.title)} · solved by ${q.solvedBy.length}${q.solvedBy.length ? ` (${esc(q.solvedBy.join(', '))})` : ''}</p>`).join('')}</details>` : ''}`;
  }

  function renderBroadcast() {
    $('#evBroadcast').innerHTML = `<h3>BROADCAST A MESSAGE</h3>
      <label class="field">MESSAGE (SHOWN AS A BANNER ON EVERY PHONE)<textarea id="evMsg" maxlength="280" placeholder="e.g. Quest ends in 10 minutes. Head back to the base."></textarea></label>
      <div class="form-grid"><label class="field">TO<select id="evTo"><option value="">Everyone</option></select></label>
        <label class="field">STYLE<select id="evLevel"><option value="info">Info</option><option value="warn">Warning</option></select></label></div>
      <div class="btn-row"><button type="button" class="btn save" id="evSend">Send</button></div>`;
    api.adminTeams().then((teams) => { $('#evTo').innerHTML += teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join(''); }).catch(() => {});
  }

  function zoneRow(z, i) {
    return `<div class="nogo-row" data-zone="${i}"><input data-z="label" value="${esc(z.label)}" placeholder="Label" /><input data-z="lat" value="${z.lat}" placeholder="lat" /><input data-z="lng" value="${z.lng}" placeholder="lng" /><input data-z="radius" value="${z.radius}" placeholder="r (m)" /><button type="button" class="btn danger" data-rm-zone="${i}">${icon('x')}</button></div>`;
  }
  function renderSafety() {
    const b = E.bounds;
    $('#evSafety').innerHTML = `<h3>SAFETY: QUEST AREA AND NO-GO ZONES</h3>
      <p class="hint">Players get a warning banner and a buzz when they leave the quest area or step into a no-go zone. Both are drawn on the Live map.</p>
      <div class="field"><span>QUEST AREA (CIRCLE)</span></div>
      <div class="nogo-row" id="boundsRow"><input data-b="lat" value="${b?.lat ?? ''}" placeholder="center lat" /><input data-b="lng" value="${b?.lng ?? ''}" placeholder="center lng" /><input data-b="radius" value="${b?.radius ?? ''}" placeholder="radius (m)" /><button type="button" class="btn" id="boundsHere">Use map centre</button><button type="button" class="btn danger" id="boundsClear">Clear</button></div>
      <div class="field"><span>NO-GO ZONES (CIRCLES)</span></div>
      <div id="zoneList" style="display:grid;gap:6px">${E.zones.map(zoneRow).join('')}</div>
      <div class="btn-row"><button type="button" class="btn" id="zoneAdd">+ Add zone at map centre</button><button type="button" class="btn save" id="safetySave">Save safety settings</button></div>`;
  }

  function renderHelp() {
    const open = E.help.filter((h) => h.status === 'open').length;
    const badge = $('#helpBadge'); badge.hidden = open === 0; badge.textContent = open;
    $('#evHelp').innerHTML = `<h3>HELP REQUESTS ${open ? `· ${open} OPEN` : ''}</h3>` + (E.help.length ? E.help.slice(0, 20).map((h) => `<div class="help-row ${h.status}"><div><strong>${esc(h.name)}</strong> <span class="mini">${esc(h.teamName || 'no team')}</span> <small style="color:var(--muted)">${ago(h.at)}</small></div>
      ${h.message ? `<div>${esc(h.message)}</div>` : ''}<div class="btn-row">${h.lat != null ? `<button type="button" class="btn" data-locate="${h.lat},${h.lng}">Show on map</button>` : ''}${h.status === 'open' ? `<button type="button" class="btn save" data-resolve="${h.id}">Mark resolved</button>` : '<small style="color:var(--muted)">resolved</small>'}</div></div>`).join('') : '<div class="empty">No help requests.</div>');
  }

  function renderStandings() {
    const rows = E.standings?.rows || [];
    $('#evStandings').innerHTML = `<h3>STANDINGS</h3><table><thead><tr><th>#</th><th>Team</th><th>Players</th><th>Locations cleared</th><th>Flags</th><th>Handed in</th><th>Time</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.rank}</td><td><b>${esc(r.name)}</b></td><td>${r.players}</td><td>${r.stopsCleared}</td><td>${r.flags}</td><td>${r.hubFlags}</td><td>${r.finishedAt ? `${icon('flag')} ${mmss(r.elapsedSeconds)}` : r.startedAt ? 'playing' : 'not started'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No locked teams yet.</td></tr>'}</tbody></table>`;
  }

  function renderData() {
    $('#evData').innerHTML = `<h3>EXPORT AND DATA</h3><div class="btn-row">
      <button type="button" class="btn" id="exResults">Download results (CSV)</button>
      <button type="button" class="btn" id="exLog">Download full activity log (CSV)</button>
      <button type="button" class="btn danger" id="purgeLoc">Delete all player locations</button>
      <button type="button" class="btn danger" id="purgePhotos">Delete all player photos</button></div>
      <p class="hint">After the event, export what you need, then delete locations and photos. Teams, results and the activity log (without coordinates) are kept.</p>`;
  }

  const send = async (patch, message) => {
    const result = await api.adminSetGame(patch);
    if (!result.ok) return toast(result.error || 'Could not save.');
    toast(message); await load(); onStatusChanged?.();
  };

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!$('#view-event') || $('#view-event').hidden) return;
    const game = t.closest('[data-game]');
    if (game) {
      const status = game.dataset.game;
      if (status === 'ended' && !confirm('End the quest for everyone? Nobody can submit anything afterwards.')) return;
      return send({ status }, { running: 'The quest is running.', paused: 'Quest paused.', ended: 'Quest ended.', lobby: 'Back to the lobby.' }[status]);
    }
    if (t.id === 'evSaveSchedule') return send({ startsAt: fromLocalInput($('#evStart').value), endsAt: fromLocalInput($('#evEnd').value), boardPublic: $('#evBoard').value === 'true' }, 'Saved.');
    if (t.id === 'evReadyRefresh') return renderReady();
    if (t.dataset?.printed) { const done = printed(); done[t.dataset.printed] = t.checked; try { localStorage.setItem(PRINTED_KEY, JSON.stringify(done)); } catch { /* optional */ } return; }
    if (t.id === 'evSqDrop') {
      const result = await api.adminSaveSurprise({ title: $('#evSqTitle').value, url: $('#evSqUrl').value, flag: $('#evSqFlag').value, announce: $('#evSqAnnounce').value });
      if (!result.ok) return toast(result.error);
      toast('Dropped. Phones show the banner and the question is at the base.'); return renderSurprise();
    }
    if (t.dataset?.closeSurprise) { await api.adminCloseSurprise(Number(t.dataset.closeSurprise)); toast('Closed.'); return renderSurprise(); }
    if (t.id === 'evSend') {
      const result = await api.adminBroadcast($('#evMsg').value, $('#evTo').value || null, $('#evLevel').value);
      if (!result.ok) return toast(result.error);
      $('#evMsg').value = ''; return toast('Sent. Phones pick it up within a few seconds.');
    }
    if (t.id === 'boundsHere') { const c = mapCenter(); E.bounds = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), radius: E.bounds?.radius || 600 }; return renderSafety(); }
    if (t.id === 'boundsClear') { E.bounds = null; return renderSafety(); }
    if (t.id === 'zoneAdd') { const c = mapCenter(); E.zones.push({ label: 'No-go zone', lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), radius: 20 }); return renderSafety(); }
    const rm = t.closest('[data-rm-zone]'); if (rm) { E.zones.splice(Number(rm.dataset.rmZone), 1); return renderSafety(); }
    if (t.id === 'safetySave') {
      const b = {}; document.querySelectorAll('#boundsRow [data-b]').forEach((i) => { b[i.dataset.b] = Number(i.value); });
      const bounds = Number.isFinite(b.lat) && Number.isFinite(b.lng) && b.radius > 0 && $('#boundsRow [data-b=lat]').value !== '' ? b : null;
      const noGo = [...document.querySelectorAll('[data-zone]')].map((row) => Object.fromEntries([...row.querySelectorAll('[data-z]')].map((i) => [i.dataset.z, i.dataset.z === 'label' ? i.value : Number(i.value)]))).filter((z) => Number.isFinite(z.lat) && Number.isFinite(z.lng) && z.radius > 0);
      await send({ bounds, noGo }, 'Safety settings saved.'); onZonesChanged?.(bounds, noGo); return;
    }
    const locate = t.closest('[data-locate]'); if (locate) { const [lat, lng] = locate.dataset.locate.split(',').map(Number); return flyTo(lat, lng); }
    const resolve = t.closest('[data-resolve]'); if (resolve) { await api.adminResolveHelp(Number(resolve.dataset.resolve)); return refreshLive(); }
    if (t.id === 'exResults') {
      const [board, teams] = await Promise.all([api.adminLeaderboard(), api.adminTeams()]);
      const byId = Object.fromEntries(teams.map((x) => [x.id, x]));
      return download('kryptex-results.csv', [['Rank', 'Team', 'Players', 'Locations cleared', 'Flags solved', 'Flags handed in', 'Started', 'Finished', 'Elapsed seconds', 'Members (flags solved)'],
        ...board.rows.map((r) => [r.rank, r.name, r.players, r.stopsCleared, r.flags, r.hubFlags, r.startedAt, r.finishedAt, r.elapsedSeconds, (byId[r.teamId]?.members || []).map((m) => `${m.name} (${m.solves})`).join('; ')])]);
    }
    if (t.id === 'exLog') {
      const rows = []; let before = null;
      for (let page = 0; page < 20; page += 1) {
        const batch = await api.adminEvents({ limit: 500, before });
        rows.push(...batch);
        if (batch.length < 500) break;
        before = Math.min(...batch.map((x) => x.id));
      }
      return download('kryptex-activity-log.csv', [['Time', 'Event', 'Team', 'Player', 'Location', 'Question #', 'OK', 'Distance (m)', 'Detail'], ...rows.map((r) => [r.at, r.kind, r.teamName, r.userName, r.stopPlace, r.idx != null ? r.idx + 1 : '', r.ok, r.distM != null ? Math.round(r.distM) : '', r.detail])]);
    }
    if (t.id === 'purgeLoc' && confirm('Delete every stored player location (and coordinates in the log)? This cannot be undone.')) { const r = await api.adminPurge('locations'); toast(r.ok ? 'Locations deleted.' : r.error); }
    if (t.id === 'purgePhotos' && confirm('Delete every player photo and its review record? This cannot be undone.')) { const r = await api.adminPurge('photos'); toast(r.ok ? 'Photos deleted.' : r.error); }
  });

  return { show: load, refresh: refreshLive, helpCount: async () => (await api.adminHelpRequests().catch(() => [])).filter((h) => h.status === 'open').length };
}
