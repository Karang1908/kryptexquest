// The "Event" tab: start / pause / end, broadcast, quest area + no-go zones, help requests, standings, exports, data purge.
import * as api from '../js/api.js';

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

export function initEvent({ toast, mapCenter, flyTo, onZonesChanged, ago }) {
  const E = { game: null, zones: [], bounds: null, help: [], standings: null };

  async function load() {
    try { E.game = await api.adminGame(); } catch (error) { console.warn(error); return; }
    E.zones = (E.game.noGo || []).map((z) => ({ ...z }));
    E.bounds = E.game.bounds ? { ...E.game.bounds } : null;
    renderStatus(); renderBroadcast(); renderSafety(); renderData();
    await refreshLive();
  }

  async function refreshLive() {
    try { E.help = await api.adminHelpRequests(); renderHelp(); } catch (error) { console.warn(error); }
    try { E.standings = await api.adminLeaderboard(); renderStandings(); } catch (error) { console.warn(error); }
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
        <label class="field">HINTS AT THE BASE<select id="evReveal"><option value="all" ${g.hubReveal === 'all' ? 'selected' : ''}>Show every location's hint after check-in</option><option value="progressive" ${g.hubReveal === 'progressive' ? 'selected' : ''}>Reveal a hint only after the previous location is cleared</option></select></label>
        <label class="field">PUBLIC BIG-SCREEN BOARD<select id="evBoard"><option value="false" ${!g.boardPublic ? 'selected' : ''}>Off</option><option value="true" ${g.boardPublic ? 'selected' : ''}>On (open /board/ on the projector)</option></select></label></div>
      <div class="btn-row"><button type="button" class="btn save" id="evSaveSchedule">Save schedule and options</button></div>
      <p class="hint">While the quest is not running, players can look around but check-ins, unlocks, photos and flags are refused. Starting requires teams to be locked in.</p>`;
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
    return `<div class="nogo-row" data-zone="${i}"><input data-z="label" value="${esc(z.label)}" placeholder="Label" /><input data-z="lat" value="${z.lat}" placeholder="lat" /><input data-z="lng" value="${z.lng}" placeholder="lng" /><input data-z="radius" value="${z.radius}" placeholder="r (m)" /><button type="button" class="btn danger" data-rm-zone="${i}">×</button></div>`;
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
    $('#evStandings').innerHTML = `<h3>STANDINGS</h3><table><thead><tr><th>#</th><th>Team</th><th>Players</th><th>Locations cleared</th><th>Flags</th><th>Handed in</th><th>Time</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r.rank}</td><td><b>${esc(r.name)}</b></td><td>${r.players}</td><td>${r.stopsCleared}</td><td>${r.flags}</td><td>${r.hubFlags}</td><td>${r.finishedAt ? `🏁 ${mmss(r.elapsedSeconds)}` : r.startedAt ? 'playing' : 'not started'}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No locked teams yet.</td></tr>'}</tbody></table>`;
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
    toast(message); await load();
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
    if (t.id === 'evSaveSchedule') return send({ startsAt: fromLocalInput($('#evStart').value), endsAt: fromLocalInput($('#evEnd').value), hubReveal: $('#evReveal').value, boardPublic: $('#evBoard').value === 'true' }, 'Saved.');
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
