// Content management (locations, questions, answers, reference photos) and photo review for the console.
import * as api from '../js/api.js';

const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN_REFS = 3;
const TARGET_REFS = 10;

export function initContent({ toast, placeOnMap, mapCenter, onChanged }) {
  const C = { stops: [], selected: null, urls: {}, draftQuestions: [] };

  async function load(keepSelection = true) {
    try { C.stops = await api.adminContent(); } catch (error) { toast('Could not load content.'); console.error(error); return; }
    const paths = C.stops.flatMap((s) => s.puzzles.flatMap((p) => p.refs.map((r) => r.path)));
    C.urls = await api.signedUrls('puzzle-refs', paths);
    if (!keepSelection || (C.selected !== 'new' && !C.stops.some((s) => s.id === C.selected))) C.selected = C.stops[0]?.id ?? null;
    render();
  }

  const current = () => (C.selected === 'new' ? newStop() : C.stops.find((s) => s.id === C.selected));
  function newStop() {
    const c = mapCenter();
    return { id: '', ord: C.stops.length + 1, name: '', place: '', label: `${String(C.stops.length + 1).padStart(2, '0')} / NEW STOP`, type: 'custom', icon: '◆', lat: c.lat, lng: c.lng, radius: 50, description: '', exitFlag: 'KQ{}', nextClue: '', puzzles: [], isNew: true };
  }

  function render() {
    $('#locList').innerHTML = C.stops.map((s, i) => `<div class="loc-item ${C.selected === s.id ? 'active' : ''}" data-select="${esc(s.id)}">
        <span class="meta"><strong>${i + 1}. ${esc(s.place)}</strong><small>${s.puzzles.length} question${s.puzzles.length === 1 ? '' : 's'} · r ${s.radius} m</small></span>
        <span class="mv"><span data-move="${esc(s.id)}:-1" title="Move earlier">▲</span><span data-move="${esc(s.id)}:1" title="Move later">▼</span></span></div>`).join('')
      + (C.selected === 'new' ? '<div class="loc-item active"><span class="meta"><strong>New location</strong><small>not saved yet</small></span></div>' : '');
    renderEditor();
  }

  function field(id, label, value, extra = '') {
    return `<label class="field ${extra}">${label}<input id="${id}" value="${esc(value)}" autocomplete="off" /></label>`;
  }

  function renderEditor() {
    const stop = current();
    const box = $('#locEditor');
    if (!stop) { box.innerHTML = '<div class="empty">No locations yet. Add the first one.</div>'; return; }
    const questions = stop.puzzles.map((p) => questionCard(stop, p)).join('') + C.draftQuestions.filter((d) => d.stop === stop.id).map(draftCard).join('');
    box.innerHTML = `<div class="panel"><h3>${stop.isNew ? 'NEW LOCATION' : `LOCATION ${stop.ord}`}</h3>
      <div class="form-grid">
        <label class="field">ID (permanent, a-z 0-9 - _)<input id="ed-id" value="${esc(stop.id)}" ${stop.isNew ? '' : 'disabled'} placeholder="cafeteria" /></label>
        ${field('ed-place', 'PLACE NAME (SHOWN TO PLAYERS)', stop.place)}
        ${field('ed-name', 'QUEST TITLE', stop.name)}
        ${field('ed-label', 'BADGE TEXT', stop.label)}
        ${field('ed-type', 'TYPE', stop.type)}
        ${field('ed-icon', 'ICON (EMOJI OR SYMBOL)', stop.icon)}
        <label class="field wide">DESCRIPTION<textarea id="ed-desc">${esc(stop.description)}</textarea></label>
        ${field('ed-lat', 'LATITUDE', stop.lat)}
        ${field('ed-lng', 'LONGITUDE', stop.lng)}
        ${field('ed-radius', 'INTERACT RADIUS (M)', stop.radius)}
        <div class="field"><span>POSITION</span><button type="button" class="btn" id="edPlace">Place on the map…</button></div>
        ${field('ed-exit', 'HANDOFF FLAG (password of the NEXT location)', stop.exitFlag, 'wide')}
        <label class="field wide">NEXT CLUE (SHOWN WHEN THIS LOCATION IS CLEARED)<textarea id="ed-clue">${esc(stop.nextClue)}</textarea></label>
      </div>
      <div class="btn-row"><button type="button" class="btn save" id="edSaveLoc">${stop.isNew ? 'Create location' : 'Save location'}</button>
        ${stop.isNew ? '<button type="button" class="btn" id="edCancelNew">Cancel</button>' : '<button type="button" class="btn danger" id="edDeleteLoc">Delete location</button>'}</div></div>
      ${stop.isNew ? '<p class="hint">Create the location first, then add its questions.</p>' : `<div class="btn-row"><button type="button" class="btn" data-add-q="flag">+ Flag question</button><button type="button" class="btn" data-add-q="photo">+ Photo question</button></div>${questions || '<div class="empty">No questions yet.</div>'}`}`;
  }

  function questionCard(stop, p) {
    const refs = p.refs || [];
    return `<div class="q-card" data-q="${p.idx}"><h4><span>QUESTION ${p.idx + 1}</span><span class="kind-tag ${p.kind}">${p.kind === 'photo' ? 'PHOTO' : 'FLAG'}</span></h4>
      ${qFields(p, `q${p.idx}`)}
      ${p.kind === 'photo' ? `<div><div class="ref-count ${refs.length < MIN_REFS ? 'low' : ''}">${refs.length} reference photo${refs.length === 1 ? '' : 's'} · take about ${TARGET_REFS} of the real object from different angles${refs.length < MIN_REFS ? ' (at least 3 needed before players can use it)' : ''}</div>
        <div class="refs">${refs.map((r) => `<div class="ref"><img src="${esc(C.urls[r.path] || '')}" alt="reference" loading="lazy" /><button type="button" data-del-ref="${p.idx}:${esc(r.id)}" aria-label="Remove photo">×</button></div>`).join('')}
        <label class="ref-add">+ Upload photos<input type="file" accept="image/*" multiple data-upload="${p.idx}" /></label></div></div>` : ''}
      <div class="btn-row"><button type="button" class="btn save" data-save-q="${p.idx}">Save question</button><button type="button" class="btn danger" data-del-q="${p.idx}">Delete</button></div></div>`;
  }
  function qFields(p, key) {
    return `<div class="form-grid">
      <label class="field">TITLE<input data-f="${key}-title" value="${esc(p.title)}" /></label>
      <label class="field">TYPE<select data-f="${key}-kind" data-kind-switch="${key}"><option value="flag" ${p.kind === 'flag' ? 'selected' : ''}>Flag (typed answer)</option><option value="photo" ${p.kind === 'photo' ? 'selected' : ''}>Photo of a real object</option></select></label>
      <label class="field wide">QUESTION TEXT${p.kind === 'photo' ? ' (DESCRIBE THE OBJECT; THE MODEL SEES THIS TOO)' : ''}<textarea data-f="${key}-prompt">${esc(p.prompt)}</textarea></label>
      ${p.kind === 'flag' ? `<label class="field wide">ANSWER / FLAG<input data-f="${key}-flag" value="${esc(p.flag || '')}" placeholder="KQ{...}" /></label>` : ''}</div>`;
  }
  function draftCard(d) {
    return `<div class="q-card" data-draft="${esc(d.key)}"><h4><span>NEW QUESTION</span><span class="kind-tag ${d.kind}">${d.kind === 'photo' ? 'PHOTO' : 'FLAG'}</span></h4>
      ${qFields(d, d.key)}${d.kind === 'photo' ? '<p class="hint">Save the question, then upload its reference photos.</p>' : ''}
      <div class="btn-row"><button type="button" class="btn save" data-save-draft="${esc(d.key)}">Save question</button><button type="button" class="btn" data-drop-draft="${esc(d.key)}">Discard</button></div></div>`;
  }

  const val = (key, name) => document.querySelector(`[data-f="${key}-${name}"]`)?.value ?? '';
  function readQuestion(key, stopId, idx) {
    return { stop: stopId, idx, title: val(key, 'title'), prompt: val(key, 'prompt'), kind: val(key, 'kind') || 'flag', flag: val(key, 'flag') };
  }

  async function changed(message) {
    if (message) toast(message);
    await load();
    onChanged?.();
  }

  $('#addLocation').addEventListener('click', () => { C.selected = 'new'; render(); });

  $('#locList').addEventListener('click', async (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
      const [id, dir] = move.dataset.move.split(':');
      const ids = C.stops.map((s) => s.id); const at = ids.indexOf(id); const to = at + Number(dir);
      if (to < 0 || to >= ids.length) return;
      [ids[at], ids[to]] = [ids[to], ids[at]];
      const result = await api.adminReorderLocations(ids);
      return result.ok ? changed('Order saved.') : toast(result.error);
    }
    const row = e.target.closest('[data-select]');
    if (row) { C.selected = row.dataset.select; render(); }
  });

  $('#locEditor').addEventListener('click', async (e) => {
    const t = e.target;
    const stop = current();
    if (t.id === 'edCancelNew') { C.selected = C.stops[0]?.id ?? null; render(); }
    if (t.id === 'edSaveLoc') {
      const body = {
        id: stop.isNew ? $('#ed-id').value : stop.id, place: $('#ed-place').value, name: $('#ed-name').value, label: $('#ed-label').value,
        type: $('#ed-type').value, icon: $('#ed-icon').value, description: $('#ed-desc').value, lat: Number($('#ed-lat').value), lng: Number($('#ed-lng').value),
        radius: Number($('#ed-radius').value), exitFlag: $('#ed-exit').value, nextClue: $('#ed-clue').value,
      };
      const result = await api.adminSaveLocation(body);
      if (!result.ok) return toast(result.error || 'Could not save.');
      C.selected = result.id || body.id.toLowerCase();
      await changed('Location saved.');
    }
    if (t.id === 'edDeleteLoc' && confirm(`Delete "${stop.place}" and all its questions? Teams' progress on it is lost.`)) {
      const refPaths = stop.puzzles.flatMap((p) => p.refs.map((r) => r.path));
      const result = await api.adminDeleteLocation(stop.id);
      if (!result.ok) return toast(result.error);
      if (refPaths.length) await api.adminRemoveFiles(refPaths); // the rows cascade away; the files in storage need removing too
      C.selected = null; await changed('Location deleted.');
    }
    if (t.id === 'edPlace') {
      if (stop.isNew) return toast('Create the location first, then place it on the map.');
      placeOnMap(stop.id);
    }
    const add = t.closest('[data-add-q]');
    if (add) {
      C.draftQuestions.push({ key: `d${Date.now()}`, stop: stop.id, kind: add.dataset.addQ, title: '', prompt: '', flag: '' });
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

  // Changing a draft's type re-renders its fields (the answer box only exists for flag questions).
  $('#locEditor').addEventListener('change', async (e) => {
    const sw = e.target.dataset.kindSwitch;
    if (sw) {
      const draft = C.draftQuestions.find((d) => d.key === sw);
      const stop = current();
      if (draft) { Object.assign(draft, { kind: e.target.value, title: val(sw, 'title'), prompt: val(sw, 'prompt'), flag: val(sw, 'flag') }); renderEditor(); }
      else {
        const idx = Number(sw.slice(1));
        const result = await api.adminSaveQuestion({ ...readQuestion(sw, stop.id, idx), kind: e.target.value, flag: e.target.value === 'flag' ? (val(sw, 'flag') || 'KQ{}') : '' });
        return result.ok ? changed('Question type changed. Set its answer and save.') : toast(result.error);
      }
    }
    if (e.target.dataset.upload !== undefined) {
      const stop = current();
      const files = [...e.target.files];
      if (!files.length) return;
      toast(`Uploading ${files.length} photo${files.length === 1 ? '' : 's'}…`);
      const result = await api.adminUploadRefs(stop.id, Number(e.target.dataset.upload), files);
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
