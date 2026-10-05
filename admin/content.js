// Content management (locations, questions, answers, reference photos, QR codes) and photo review for the console.
import * as api from '../js/api.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN_REFS = 3;
const TARGET_REFS = 10;
const ROLE_ICON = { hub: '⌂', stop: '', bonus: '★' };
const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

/** Where a stop's QR code points. Players scan it with the phone camera to prove they are there. */
function qrLink(stop) {
  const base = location.origin + location.pathname.replace(/admin\/?(index\.html)?$/, '');
  return `${base}?qr=${encodeURIComponent(stop.id)}.${encodeURIComponent(stop.qrToken || '')}`;
}
async function qrImages(stops) {
  const { default: QRCode } = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
  return Promise.all(stops.map(async (s) => ({ stop: s, link: qrLink(s), img: await QRCode.toDataURL(qrLink(s), { width: 520, margin: 2, errorCorrectionLevel: 'M' }) })));
}
async function printQrSheet(stops) {
  const cards = await qrImages(stops);
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.write(`<!doctype html><title>Kryptex Quest QR codes</title><style>
    body{font-family:system-ui,sans-serif;margin:0;display:grid;grid-template-columns:repeat(2,1fr);gap:0}
    .card{box-sizing:border-box;height:50vh;padding:24px;border:1px dashed #999;display:grid;place-items:center;text-align:center;page-break-inside:avoid}
    img{width:300px;height:300px} h1{margin:8px 0 2px;font-size:28px} p{margin:0;color:#444}
    @media print{.card{height:48vh}}</style>${cards.map((c) => `<div class="card"><div><img src="${c.img}" alt="QR"/><h1>${esc(c.stop.place)}</h1><p>Scan with your phone camera to prove you are here.</p><p style="font-size:11px;color:#888;margin-top:6px">Kryptex Quest · ${esc(c.stop.id)}</p></div></div>`).join('')}<script>onload=()=>setTimeout(()=>print(),300)<\/script>`);
  w.document.close();
  return true;
}

export function initContent({ toast, placeOnMap, mapCenter, onChanged }) {
  const C = { stops: [], selected: null, working: null, urls: {}, draftQuestions: [], stats: {} };

  async function load(keepSelection = true) {
    try { C.stops = await api.adminContent(); } catch (error) { toast('Could not load content.'); console.error(error); return; }
    const paths = C.stops.flatMap((s) => s.puzzles.flatMap((p) => (p.refs || []).map((r) => r.path)));
    C.urls = await api.signedUrls('puzzle-refs', paths);
    C.stats = Object.fromEntries((await api.adminQuestionStats().catch(() => [])).map((x) => [`${x.stopId}:${x.idx}`, x]));
    if (!keepSelection || (C.selected !== 'new' && !C.stops.some((s) => s.id === C.selected))) C.selected = C.stops.find((s) => s.role !== 'hub')?.id ?? C.stops[0]?.id ?? null;
    select(C.selected);
  }

  const playable = () => C.stops.filter((s) => s.role !== 'hub');
  /** The location being edited: a working copy, so switching role or unlock mode keeps what was typed. */
  const current = () => C.working;
  function select(id) {
    C.selected = id;
    C.working = id === 'new' ? newStop() : structuredClone(C.stops.find((s) => s.id === id) ?? null);
    render();
  }
  function newStop() {
    const c = mapCenter();
    const n = playable().length + 1;
    const hasHub = C.stops.some((s) => s.role === 'hub');
    return { id: '', ord: n, role: hasHub ? 'stop' : 'hub', entryMode: 'chain', name: '', place: '', label: `${String(n).padStart(2, '0')} / NEW STOP`, type: 'custom', icon: '◆', lat: c.lat, lng: c.lng, radius: 50, description: '', hint: '', entryQuestion: '', entryAnswer: '', exitFlag: 'KQ{}', nextClue: '', puzzles: [], isNew: true };
  }

  function render() {
    const hub = C.stops.find((s) => s.role === 'hub');
    const row = (s, i, fixed) => `<div class="loc-item ${C.selected === s.id ? 'active' : ''} ${fixed ? 'fixed-row' : ''}" data-select="${esc(s.id)}">
        <span class="meta"><strong>${fixed ? '⌂' : `${i + 1}.${ROLE_ICON[s.role] ? ' ' + ROLE_ICON[s.role] : ''}`} ${esc(s.place)}</strong><small>${s.role === 'hub' ? 'Base · players start and hand in flags here' : `${s.role === 'bonus' ? 'Bonus · ' : ''}${s.entryMode === 'open' ? 'released from the start · ' : ''}${s.puzzles.length} question${s.puzzles.length === 1 ? '' : 's'} · r ${s.radius} m`}</small></span>
        ${fixed ? '' : `<span class="mv"><span data-move="${esc(s.id)}:-1" title="Move earlier">▲</span><span data-move="${esc(s.id)}:1" title="Move later">▼</span></span>`}</div>`;
    $('#locList').innerHTML = (hub ? row(hub, 0, true) : '<div class="hint">No base yet. Add a location and make it the Base.</div>')
      + playable().map((s, i) => row(s, i, false)).join('')
      + (C.selected === 'new' ? '<div class="loc-item active"><span class="meta"><strong>New location</strong><small>not saved yet</small></span></div>' : '')
      + (C.stops.length ? '<button type="button" class="btn" id="printAllQr">Print all QR codes</button>' : '');
    renderEditor();
  }

  function field(id, label, value, extra = '') {
    return `<label class="field ${extra}">${label}<input id="${id}" value="${esc(value)}" autocomplete="off" /></label>`;
  }

  function renderEditor() {
    const stop = current();
    const box = $('#locEditor');
    if (!stop) { box.innerHTML = '<div class="empty">No locations yet. Add the base first, then the locations.</div>'; return; }
    const isHubStop = stop.role === 'hub';
    const questions = isHubStop ? '' : stop.puzzles.map((p) => questionCard(stop, p)).join('') + C.draftQuestions.filter((d) => d.stop === stop.id).map(draftCard).join('');
    const roleOptions = ['hub', 'stop', 'bonus'].map((r) => `<option value="${r}" ${stop.role === r ? 'selected' : ''}>${{ hub: 'Base (start / hand-in point)', stop: 'Location', bonus: 'Bonus question (finish screen, needs no location)' }[r]}</option>`).join('');
    const modeOptions = [['chain', 'Sequential: hint + entry question are released at the base after the previous location\'s code is handed in'], ['open', 'Released right after check-in']].map(([v, l]) => `<option value="${v}" ${stop.entryMode === v ? 'selected' : ''}>${l}</option>`).join('');
    box.innerHTML = `<div class="panel"><h3>${stop.isNew ? 'NEW LOCATION' : isHubStop ? 'BASE' : `LOCATION ${stop.ord}`}</h3>
      <div class="form-grid">
        <label class="field">ID (permanent, a-z 0-9 - _)<input id="ed-id" value="${esc(stop.id)}" ${stop.isNew ? '' : 'disabled'} placeholder="cafeteria" /></label>
        <label class="field">ROLE<select id="ed-role">${roleOptions}</select></label>
        ${field('ed-place', 'PLACE NAME (SHOWN WHEN A TEAM UNLOCKS IT)', stop.place)}
        ${field('ed-name', 'QUEST TITLE', stop.name)}
        ${field('ed-label', 'BADGE TEXT', stop.label)}
        ${field('ed-icon', 'ICON (EMOJI OR SYMBOL)', stop.icon)}
        ${field('ed-type', 'TYPE', stop.type)}
        ${field('ed-radius', 'INTERACT RADIUS (M)', stop.radius)}
        <label class="field wide">DESCRIPTION<textarea id="ed-desc">${esc(stop.description)}</textarea></label>
        ${field('ed-lat', 'LATITUDE', stop.lat)}
        ${field('ed-lng', 'LONGITUDE', stop.lng)}
        <div class="field"><span>POSITION</span><button type="button" class="btn" id="edPlaceMap">Place on the map…</button></div>
        ${isHubStop || stop.role === 'bonus' ? '' : `<label class="field wide">HINT SHOWN AT THE BASE ONCE RELEASED (HOW PLAYERS FIND THIS HIDDEN PLACE)<textarea id="ed-hint">${esc(stop.hint)}</textarea></label>`}
        ${stop.role === 'stop' ? `<label class="field wide">WHEN DOES THE BASE RELEASE ITS HINT?<select id="ed-mode">${modeOptions}</select></label>` : ''}
        ${stop.role === 'stop' ? `${field('ed-eq', 'ENTRY QUESTION (OPTIONAL, SHOWN AT THE BASE ONCE RELEASED; ITS ANSWER IS THE ENTRY FLAG)', stop.entryQuestion || '', 'wide')}${field('ed-ea', 'ENTRY FLAG (TYPED AT THE LOCATION TO UNLOCK IT; BLANK = UNLOCKS WHEN DISCOVERED)', stop.entryAnswer || '', 'wide')}` : ''}
        ${stop.role === 'stop' ? field('ed-exit', 'LOCATION CODE (shown when cleared; handed in at the base to unlock the NEXT location)', stop.exitFlag || '', 'wide') : ''}
        ${stop.role === 'stop' ? `<label class="field wide">NEXT CLUE (SHOWN WHEN THIS LOCATION IS CLEARED)<textarea id="ed-clue">${esc(stop.nextClue || '')}</textarea></label>` : ''}
      </div>
      <div class="btn-row"><button type="button" class="btn save" id="edSaveLoc">${stop.isNew ? 'Create location' : 'Save location'}</button>
        ${stop.isNew ? '<button type="button" class="btn" id="edCancelNew">Cancel</button>' : `<button type="button" class="btn" id="edQr">QR code</button><button type="button" class="btn danger" id="edDeleteLoc">Delete</button>`}</div></div>
      ${stop.isNew || isHubStop ? (stop.isNew ? '<p class="hint">Create the location first, then add its questions.</p>' : '<p class="hint">The base has no questions. Players check in here, read each released location\'s hint and entry question, and hand in location codes.</p>')
        : `<div class="btn-row"><button type="button" class="btn" data-add-q="photo">+ Photo question (clue, photo, then question)</button><button type="button" class="btn" data-add-q="flag">+ Flag question</button></div>${questions || '<div class="empty">No questions yet. Aim for 2-3 per location.</div>'}`}`;
  }

  function statLine(stopId, idx) {
    const x = C.stats[`${stopId}:${idx}`];
    if (!x) return '';
    return `<div class="qstat">Solved by ${x.teamsSolved} team${x.teamsSolved === 1 ? '' : 's'} · avg ${mmss(x.avgSeconds)} after unlocking · ${x.wrongGuesses} wrong guess${x.wrongGuesses === 1 ? '' : 'es'}${x.photoMisses ? ` · ${x.photoMisses} photo misses` : ''}${x.photoReviews ? ` · ${x.photoReviews} awaiting review` : ''}</div>`;
  }

  function questionCard(stop, p) {
    const refs = p.refs || [];
    return `<div class="q-card" data-q="${p.idx}"><h4><span>QUESTION ${p.idx + 1}</span><span class="kind-tag ${p.kind}">${p.kind === 'photo' ? 'PHOTO → QUESTION' : 'FLAG'}</span></h4>
      ${qFields(p, `q${p.idx}`)}${statLine(stop.id, p.idx)}
      ${p.kind === 'photo' ? `<div><div class="ref-count ${refs.length < MIN_REFS ? 'low' : ''}">${refs.length} reference photo${refs.length === 1 ? '' : 's'} · take about ${TARGET_REFS} of the real object from different angles${refs.length < MIN_REFS ? ' (at least 3 needed before players can use it)' : ''}</div>
        <div class="refs">${refs.map((r) => `<div class="ref"><img src="${esc(C.urls[r.path] || '')}" alt="reference" loading="lazy" /><button type="button" data-del-ref="${p.idx}:${esc(r.id)}" aria-label="Remove photo">×</button></div>`).join('')}
        <label class="ref-add">+ Upload photos<input type="file" accept="image/*" multiple data-upload="${p.idx}" /></label></div></div>` : ''}
      <div class="btn-row"><button type="button" class="btn save" data-save-q="${p.idx}">Save question</button><button type="button" class="btn danger" data-del-q="${p.idx}">Delete</button></div></div>`;
  }
  function qFields(p, key) {
    const photo = p.kind === 'photo';
    return `<div class="form-grid">
      <label class="field">TITLE<input data-f="${key}-title" value="${esc(p.title)}" /></label>
      <label class="field">TYPE<select data-f="${key}-kind" data-kind-switch="${key}"><option value="photo" ${photo ? 'selected' : ''}>Photo of a real object, then a question</option><option value="flag" ${!photo ? 'selected' : ''}>Question only</option></select></label>
      <label class="field wide">${photo ? 'CLUE (DESCRIBE THE OBJECT TO FIND; THE AI SEES THIS TOO)' : 'QUESTION TEXT'}<textarea data-f="${key}-prompt">${esc(p.prompt)}</textarea></label>
      ${photo ? `<label class="field wide">QUESTION (REVEALED ONLY AFTER THE PHOTO IS VERIFIED)<textarea data-f="${key}-question">${esc(p.question || '')}</textarea></label>` : ''}
      <label class="field wide">ANSWER / FLAG<input data-f="${key}-flag" value="${esc(p.flag || '')}" placeholder="KQ{...}" /></label></div>`;
  }
  function draftCard(d) {
    return `<div class="q-card" data-draft="${esc(d.key)}"><h4><span>NEW QUESTION</span><span class="kind-tag ${d.kind}">${d.kind === 'photo' ? 'PHOTO → QUESTION' : 'FLAG'}</span></h4>
      ${qFields(d, d.key)}${d.kind === 'photo' ? '<p class="hint">Save the question, then upload its reference photos.</p>' : ''}
      <div class="btn-row"><button type="button" class="btn save" data-save-draft="${esc(d.key)}">Save question</button><button type="button" class="btn" data-drop-draft="${esc(d.key)}">Discard</button></div></div>`;
  }

  const val = (key, name) => document.querySelector(`[data-f="${key}-${name}"]`)?.value ?? '';
  function readQuestion(key, stopId, idx) {
    return { stop: stopId, idx, title: val(key, 'title'), prompt: val(key, 'prompt'), kind: val(key, 'kind') || 'flag', flag: val(key, 'flag'), question: val(key, 'question') };
  }
  function readLocation(stop) {
    const v = (id) => $(id)?.value ?? '';
    return {
      id: stop.isNew ? v('#ed-id') : stop.id, role: v('#ed-role') || stop.role, entryMode: v('#ed-mode') || stop.entryMode, place: v('#ed-place'), name: v('#ed-name'), label: v('#ed-label'),
      type: v('#ed-type'), icon: v('#ed-icon'), description: v('#ed-desc'), lat: Number(v('#ed-lat')), lng: Number(v('#ed-lng')), radius: Number(v('#ed-radius')),
      hint: v('#ed-hint'), entryQuestion: v('#ed-eq'), entryAnswer: v('#ed-ea'), exitFlag: v('#ed-exit'), nextClue: v('#ed-clue'),
    };
  }

  async function changed(message) {
    if (message) toast(message);
    await load();
    onChanged?.();
  }

  $('#addLocation').addEventListener('click', () => select('new'));

  $('#locList').addEventListener('click', async (e) => {
    if (e.target.id === 'printAllQr') { if (!(await printQrSheet(C.stops).catch(() => false))) toast('Allow pop-ups to print the QR codes.'); return; }
    const move = e.target.closest('[data-move]');
    if (move) {
      const [id, dir] = move.dataset.move.split(':');
      const ids = playable().map((s) => s.id); const at = ids.indexOf(id); const to = at + Number(dir);
      if (to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to], ids[at]];
      const result = await api.adminReorderLocations(ids);
      return result.ok ? changed('Order saved.') : toast(result.error);
    }
    const row = e.target.closest('[data-select]');
    if (row) select(row.dataset.select);
  });

  $('#locEditor').addEventListener('click', async (e) => {
    const t = e.target;
    const stop = current();
    if (t.id === 'edCancelNew') select(playable()[0]?.id ?? null);
    if (t.id === 'edSaveLoc') {
      const body = readLocation(stop);
      const result = await api.adminSaveLocation(body);
      if (!result.ok) return toast(result.error || 'Could not save.');
      C.selected = result.id || body.id.toLowerCase();
      await changed('Location saved.');
    }
    if (t.id === 'edQr') { if (!(await printQrSheet([stop]).catch(() => false))) toast('Allow pop-ups to print the QR code.'); }
    if (t.id === 'edDeleteLoc' && confirm(`Delete "${stop.place}" and all its questions? Teams' progress on it is lost.`)) {
      const refPaths = stop.puzzles.flatMap((p) => (p.refs || []).map((r) => r.path));
      const result = await api.adminDeleteLocation(stop.id);
      if (!result.ok) return toast(result.error);
      if (refPaths.length) await api.adminRemoveFiles(refPaths);
      C.selected = null; await changed('Location deleted.');
    }
    if (t.id === 'edPlaceMap') {
      if (stop.isNew) return toast('Create the location first, then place it on the map.');
      placeOnMap(stop.id);
    }
    const add = t.closest('[data-add-q]');
    if (add) {
      C.draftQuestions.push({ key: `d${Date.now()}`, stop: stop.id, kind: add.dataset.addQ, title: '', prompt: '', question: '', flag: '' });
      renderEditor();
    }
    const saveQ = t.closest('[data-save-q]');
    if (saveQ) {
      const idx = Number(saveQ.dataset.saveQ);
      const result = await api.adminSaveQuestion(readQuestion(`q${idx}`, stop.id, idx));
      return result.ok ? changed('Question saved.') : toast(result.error);
    }
    const saveDraft = t.closest('[data-save-draft]');
    if (saveDraft) {
      const key = saveDraft.dataset.saveDraft;
      const result = await api.adminSaveQuestion(readQuestion(key, stop.id, null));
      if (!result.ok) return toast(result.error);
      C.draftQuestions = C.draftQuestions.filter((d) => d.key !== key);
      await changed('Question added.');
    }
    const drop = t.closest('[data-drop-draft]');
    if (drop) { C.draftQuestions = C.draftQuestions.filter((d) => d.key !== drop.dataset.dropDraft); renderEditor(); }
    const delQ = t.closest('[data-del-q]');
    if (delQ && confirm('Delete this question? Teams that solved it lose that solve.')) {
      const result = await api.adminDeleteQuestion(stop.id, Number(delQ.dataset.delQ));
      return result.ok ? changed('Question deleted.') : toast(result.error);
    }
    const delRef = t.closest('[data-del-ref]');
    if (delRef) {
      const [idx, id] = delRef.dataset.delRef.split(':');
      const ref = stop.puzzles.find((p) => p.idx === Number(idx))?.refs.find((r) => r.id === id);
      const result = await api.adminDeleteRef(stop.id, Number(idx), ref);
      return result.ok ? changed() : toast(result.error);
    }
  });

  $('#locEditor').addEventListener('change', async (e) => {
    const t = e.target;
    // Role / unlock mode change which fields exist: redraw from the working copy.
    if (t.id === 'ed-role' || t.id === 'ed-mode') {
      C.working = { ...C.working, ...readLocation(C.working), role: $('#ed-role').value, entryMode: $('#ed-mode')?.value || C.working.entryMode };
      renderEditor();
      return;
    }
    const sw = t.dataset.kindSwitch;
    if (sw) {
      const draft = C.draftQuestions.find((d) => d.key === sw);
      const stop = current();
      if (draft) { Object.assign(draft, { kind: t.value, title: val(sw, 'title'), prompt: val(sw, 'prompt'), question: val(sw, 'question'), flag: val(sw, 'flag') }); renderEditor(); }
      else {
        const idx = Number(sw.slice(1));
        const current_ = stop.puzzles.find((p) => p.idx === idx);
        Object.assign(current_, { kind: t.value, title: val(sw, 'title'), prompt: val(sw, 'prompt'), question: val(sw, 'question') || current_.question, flag: val(sw, 'flag') });
        renderEditor();
        toast('Type changed. Fill the new fields and press Save question.');
      }
      return;
    }
    if (t.dataset.upload !== undefined) {
      const stop = current();
      const files = [...t.files];
      if (!files.length) return;
      toast(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
      const result = await api.adminUploadRefs(stop.id, Number(t.dataset.upload), files);
      return result.ok ? changed(`${result.count} photo${result.count === 1 ? '' : 's'} added.`) : toast(result.error);
    }
  });

  return { show: load, selectedStopId: () => (C.selected === 'new' ? null : C.selected) };
}

export function initPhotos({ toast, ago, onChanged }) {
  const P = { rows: [] };
  const pct = (c) => (c == null ? '—' : `${Math.round(c * 100)}%`);

  async function load() {
    const status = $('#photoStatus').value || null;
    try { P.rows = await api.adminPhotoSubmissions(status); } catch (error) { console.warn(error); return; }
    const own = await api.signedUrls('submissions', P.rows.map((r) => r.path));
    const refs = await api.signedUrls('puzzle-refs', P.rows.flatMap((r) => r.refPaths || []));
    P.urls = { ...own, ...refs };
    render();
  }

  function render() {
    $('#photoCount').textContent = `${P.rows.length} shown`;
    $('#photoList').innerHTML = P.rows.length ? P.rows.map((r) => `<div class="photo-card" data-id="${esc(r.id)}">
      <div class="pair"><img class="main" src="${esc(P.urls[r.path] || '')}" alt="player photo" loading="lazy" />
        <div class="stack">${(r.refPaths || []).slice(0, 2).map((p) => `<img src="${esc(P.urls[p] || '')}" alt="reference" loading="lazy" />`).join('')}</div></div>
      <div><strong>${esc(r.puzzleTitle || '')}</strong> <small style="color:var(--muted)">· ${esc(r.stopPlace || '')}</small></div>
      <div class="chips"><span class="pill">${esc(r.teamName || '')}</span><span class="pill">${esc(r.userName || '')}</span><span class="pill">${ago(r.at)}</span>
        <span class="pill ${r.status === 'approved' ? 'good' : r.status === 'rejected' ? 'rejected' : 'warn'}">${esc(r.status)}</span><span class="pill">${esc(r.verdict)} · <b>${pct(r.confidence)}</b></span></div>
      <div class="conf"><i style="width:${(r.confidence || 0) * 100}%"></i></div>
      <div class="hint">${esc(r.reason || '')}</div>
      <div class="btn-row">${r.status !== 'approved' ? '<button type="button" class="btn save" data-approve="1">Approve (counts as solved)</button>' : ''}${r.status !== 'rejected' ? '<button type="button" class="btn danger" data-approve="0">Reject</button>' : ''}</div></div>`).join('')
      : '<div class="empty">Nothing here.</div>';
  }

  $('#photoStatus').addEventListener('change', load);
  $('#photoList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-approve]');
    if (!btn) return;
    const id = btn.closest('[data-id]').dataset.id;
    const result = await api.adminReviewPhoto(id, btn.dataset.approve === '1');
    if (!result.ok) return toast(result.error || 'Could not save.');
    toast(btn.dataset.approve === '1' ? 'Approved. The team gets the flag.' : 'Rejected.');
    await load(); onChanged?.();
  });

  async function pendingCount() {
    try { return (await api.adminPhotoSubmissions('pending')).length; } catch { return 0; }
  }
  return { show: load, pendingCount };
}
