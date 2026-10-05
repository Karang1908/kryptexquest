// Read-only big-screen leaderboard. Anonymous: it only works while organisers have switched the public board on.
import * as api from '../js/api.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => { const t = Math.max(0, Math.round(s)); const h = Math.floor(t / 3600); return `${h ? `${h}:` : ''}${String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0')}:${String(t % 60).padStart(2, '0')}`; };
const LABEL = { lobby: 'STARTING SOON', running: 'LIVE', paused: 'PAUSED', ended: 'FINAL RESULTS' };

async function tick() {
  let board;
  try { board = await api.publicLeaderboard(); } catch (error) { console.warn(error); return; }
  const note = $('#note');
  if (board.hidden) { $('#rows').innerHTML = ''; $('#state').textContent = ''; note.hidden = false; note.textContent = 'The leaderboard is not public yet.'; return; }
  const skew = board.now ? Date.parse(board.now) - Date.now() : 0;
  const state = $('#state');
  state.className = board.status;
  let label = LABEL[board.status] || board.status;
  if (board.status === 'lobby' && board.startsAt) label += ` · ${clock((Date.parse(board.startsAt) - (Date.now() + skew)) / 1000)}`;
  if (board.status === 'running' && board.endsAt) label += ` · ${clock((Date.parse(board.endsAt) - (Date.now() + skew)) / 1000)} left`;
  state.textContent = label;
  note.hidden = board.rows.length > 0;
  note.textContent = 'Waiting for teams to lock in…';
  const needed = board.stops || 4;
  $('#rows').innerHTML = board.rows.slice(0, 12).map((r) => `<div class="row"><span class="pos">${r.rank}</span>
    <span><strong>${esc(r.name)}</strong><small>${r.stopsCleared}/${needed} locations · ${r.hubFlags} handed in · ${r.players} player${r.players === 1 ? '' : 's'}</small>
      <div class="pips">${Array.from({ length: needed }, (_, i) => `<i class="${i < r.stopsCleared ? 'on' : i < r.hubFlags ? 'hub' : ''}"></i>`).join('')}</div></span>
    <span class="time">${r.finishedAt ? clock(r.elapsedSeconds) : r.startedAt ? `${r.flags} flags` : 'on the way'}</span></div>`).join('');
}

tick();
setInterval(tick, 5000);
