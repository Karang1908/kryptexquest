const CAMPUS = { lat: 25.13133, lng: 55.41898 };
const STATIONS = [
  {
    id: 'lobby', name: 'The Arrival', place: 'Main Lobby', label: '01 / START HERE', type: 'lobby', icon: '✳',
    lat: 25.13111, lng: 55.41864, description: 'The first signal is hiding where every campus story begins.',
    gate: null, exitFlag: 'KQ{OPEN_BOOK}', nextClue: 'A place where you study, search, and get lost in stories.',
    puzzles: [
      { title: 'First contact', prompt: 'Decode the welcome terminal. Enter the sample flag to initialize your expedition.', flag: 'KQ{HELLO_CAMPUS}', kind: 'flag' },
      { title: 'Emergency eyes', prompt: 'Find the red device used to alert people in an emergency. Photograph it.', flag: 'KQ{ALARM_FOUND}', kind: 'photo' },
      { title: 'The last digit', prompt: 'Every quest needs a key. Enter the sample flag to finish this location.', flag: 'KQ{LOBBY_CLEAR}', kind: 'flag' },
    ],
  },
  {
    id: 'library', name: 'Between the Lines', place: 'Library', label: '02 / KNOWLEDGE', type: 'library', icon: '⌘',
    lat: 25.13152, lng: 55.41886, description: 'Quiet shelves. Loud secrets. Follow the first handoff flag here.',
    gate: 'KQ{OPEN_BOOK}', exitFlag: 'KQ{BUILD_IDEA}', nextClue: 'Where hands and tools turn ideas into things.',
    puzzles: [
      { title: 'Shelf signal', prompt: 'A place where books stand shoulder to shoulder. Enter the sample flag.', flag: 'KQ{STACKS}', kind: 'flag' },
      { title: 'Study light', prompt: 'Photograph a lamp or light used at a study desk.', flag: 'KQ{BRIGHT_MIND}', kind: 'photo' },
      { title: 'Final page', prompt: 'Complete the reading trail with this sample flag.', flag: 'KQ{PAGE_TURNER}', kind: 'flag' },
    ],
  },
  {
    id: 'lab', name: 'Maker Mode', place: 'Academic Block', label: '03 / DISCOVERY', type: 'lab', icon: '⚙',
    lat: 25.1317, lng: 55.41946, description: 'Look for a place where experiments take shape.',
    gate: 'KQ{BUILD_IDEA}', exitFlag: 'KQ{GREEN_SIGNAL}', nextClue: 'Go where the campus opens up to the sky.',
    puzzles: [
      { title: 'Prototype zero', prompt: 'A simple start to a complex build. Enter the sample flag.', flag: 'KQ{MAKER}', kind: 'flag' },
      { title: 'Safety first', prompt: 'Photograph an exit sign or another clearly marked safety sign.', flag: 'KQ{SAFE_ROUTE}', kind: 'photo' },
      { title: 'The circuit', prompt: 'Close the circuit with the sample flag.', flag: 'KQ{CIRCUIT}', kind: 'flag' },
    ],
  },
  {
    id: 'courtyard', name: 'Final Frequency', place: 'Campus Courtyard', label: '04 / FINAL STOP', type: 'courtyard', icon: '◆',
    lat: 25.1309, lng: 55.41933, description: 'The trail ends in the open. One final burst of signal remains.',
    gate: 'KQ{GREEN_SIGNAL}', exitFlag: 'KQ{QUEST_COMPLETE}', nextClue: 'The Kryptex has been found. You finished the campus trail.',
    puzzles: [
      { title: 'Open air', prompt: 'Enter the sample flag for the final location.', flag: 'KQ{OUTSIDE}', kind: 'flag' },
      { title: 'Living clue', prompt: 'Photograph a tree or planted greenery on campus.', flag: 'KQ{ROOTED}', kind: 'photo' },
      { title: 'Kryptex found', prompt: 'Enter the final sample flag.', flag: 'KQ{FOUND_IT}', kind: 'flag' },
    ],
  },
];

const STORAGE_KEY = 'kryptex-quest-preview-v1';
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } })();
const state = {
  selected: STATIONS.some((station) => station.id === saved.selected) ? saved.selected : 'lobby',
  unlocked: Array.isArray(saved.unlocked) ? saved.unlocked : ['lobby'],
  solved: Array.isArray(saved.solved) ? saved.solved : [],
  avatar: saved.avatar === 'female' ? 'female' : 'male',
  expandedPuzzle: 0,
  photoApproved: new Set(),
  photo: null,
  sampleShown: false,
  location: null,
  previewMode: true,
};
let map;
let maplibregl;
let mapMarkers = [];
let locationMarker;
let toastTimer;

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ selected: state.selected, unlocked: state.unlocked, solved: state.solved, avatar: state.avatar }));
}
function stationIndex() { return STATIONS.findIndex((station) => station.id === state.selected); }
function stationNow() { return STATIONS[stationIndex()]; }
function puzzleId(station, index) { return `${station.id}:${index}`; }
function solvedCount(station) { return station.puzzles.filter((_, index) => state.solved.includes(puzzleId(station, index))).length; }
function isComplete(station) { return solvedCount(station) === station.puzzles.length; }
function isUnlocked(station) { return state.unlocked.includes(station.id); }
function stationStatus(station) { return isComplete(station) ? 'completed' : isUnlocked(station) ? 'current' : 'locked'; }
function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(6371000 * 2 * Math.asin(Math.sqrt(h)));
}
function canInteract(station) { return state.previewMode || (state.location && distanceMeters(state.location, station) <= 60); }
function showToast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3300);
}

function renderRoute() {
  $('#routeCount').textContent = `${STATIONS.filter(isComplete).length} / ${STATIONS.length}`;
  $('#routeList').innerHTML = STATIONS.map((station, index) => {
    const status = stationStatus(station);
    return `<button class="route-item ${status} ${state.selected === station.id ? 'active' : ''}" type="button" data-action="select" data-station="${station.id}" aria-current="${state.selected === station.id ? 'location' : 'false'}"><span class="route-index">${status === 'completed' ? '✓' : String(index + 1).padStart(2, '0')}</span><span class="route-text"><strong>${escapeHtml(station.place)}</strong><small>${status === 'completed' ? 'Location cleared' : status === 'current' ? 'Ready to explore' : 'Needs a handoff flag'}</small></span><span class="route-end">${status === 'locked' ? '♧' : '›'}</span></button>`;
  }).join('');
  $('#hudProgress').textContent = String(STATIONS.filter(isComplete).length).padStart(2, '0');
}

function renderPuzzle(station, puzzle, index) {
  const id = puzzleId(station, index);
  const solved = state.solved.includes(id);
  const expanded = state.expandedPuzzle === index && !solved;
  const approved = state.photoApproved.has(id);
  const hasPhoto = state.photo?.id === id;
  return `<article class="puzzle-card ${solved ? 'solved' : ''}">
    <button class="puzzle-trigger" type="button" data-action="expand-puzzle" data-index="${index}" aria-expanded="${expanded}"><span class="puzzle-card-head" style="width:100%"><span class="puzzle-num">${solved ? '✓' : String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(puzzle.title)}</strong><small>${solved ? 'CLEARED' : puzzle.kind === 'photo' ? 'PHOTO + FLAG' : 'ENTER FLAG'}</small></span></button>
    ${expanded ? `<div class="puzzle-detail"><p>${escapeHtml(puzzle.prompt)}</p>
      ${puzzle.kind === 'photo' ? `<label class="photo-upload">📷 &nbsp; ${hasPhoto ? 'Replace photo' : 'Capture or choose an object photo'}<input id="photoInput" type="file" accept="image/*" capture="environment" aria-label="Capture or choose object photo" /></label>${hasPhoto ? `<img class="photo-preview" src="${state.photo.url}" alt="Captured object preview" /><div class="photo-name">${escapeHtml(state.photo.name)}</div>` : ''}${approved ? `<div class="photo-status">✓ Demo review approved · flag issued: <b>${puzzle.flag}</b></div>` : `<button class="ghost-button" type="button" data-action="review-photo">Simulate photo verification</button>`}` : ''}
      <form class="flag-row" data-action="submit-puzzle" data-index="${index}"><input class="flag-input" name="flag" autocomplete="off" spellcheck="false" placeholder="KQ{YOUR_FLAG}" aria-label="Puzzle flag" ${puzzle.kind === 'photo' && !approved ? 'disabled' : ''} /><button class="small-action" type="submit" ${puzzle.kind === 'photo' && !approved ? 'disabled' : ''}>VERIFY</button></form>
      ${puzzle.kind === 'flag' ? `<button class="demo-link" type="button" data-action="show-sample" data-index="${index}">${state.sampleShown ? `Sample flag: ${puzzle.flag}` : 'Show sample flag for preview'}</button>` : ''}
    </div>` : ''}
  </article>`;
}

function renderMission() {
  const station = stationNow();
  const index = stationIndex();
  const unlocked = isUnlocked(station);
  const complete = isComplete(station);
  const count = solvedCount(station);
  const dist = state.location ? `${distanceMeters(state.location, station)} m away` : 'GPS not connected';
  $('#mobileMissionName').textContent = station.name;
  $('#missionPanel').innerHTML = `<div class="intel-header"><div class="intel-topline"><span>FIELD INTEL / ${String(index + 1).padStart(2, '0')}</span><button type="button" data-action="close-sheet" aria-label="Close mission panel">⌄</button></div></div>
    <div class="intel-art ${station.type}"><span class="intel-art-caption">KQ // ${escapeHtml(station.place.toUpperCase())}</span><span class="intel-art-shape"></span><span class="intel-art-orb">${station.icon}</span></div>
    <div class="intel-body"><div class="station-meta"><span class="mini-tag">${escapeHtml(station.label)}</span><span class="station-distance">⌖ ${dist}</span></div><h2>${escapeHtml(station.name)}</h2><p class="station-description">${escapeHtml(station.description)}</p>
    ${unlocked ? `<div class="gate-success"><span>✓</span> ACCESS GRANTED · ${state.previewMode ? 'PREVIEW MODE' : 'GPS MODE'}</div><div class="section-label"><span>THREE SIGNALS TO DECODE</span><span>${count} / 3</span></div><div class="progress-track"><span style="width:${count / 3 * 100}%"></span></div><div class="puzzle-list" style="margin-top:14px">${station.puzzles.map((puzzle, puzzleIndex) => renderPuzzle(station, puzzle, puzzleIndex)).join('')}</div>
      ${complete ? `<div class="clue-box"><h3>✳ &nbsp; Location cleared</h3><p>Your next clue has been decrypted:</p><strong>“${escapeHtml(station.nextClue)}”</strong><p>Handoff flag for the next stop</p><code>${station.exitFlag}</code></div>${index < STATIONS.length - 1 ? `<button class="primary-button" data-action="select" data-station="${STATIONS[index + 1].id}" type="button">Open next location <span>↗</span></button>` : `<button class="primary-button" type="button" data-action="celebrate">Quest complete <span>✳</span></button>`}` : `<p class="question-count">Clear all 3 flags to reveal your next location.</p>`}`
      : `<div class="gate-box"><h3>♧ &nbsp; Location locked</h3><p>Bring the handoff flag from the previous stop to access this location.</p><form class="flag-row" data-action="unlock"><input class="flag-input" name="gate" autocomplete="off" spellcheck="false" placeholder="KQ{PREVIOUS_FLAG}" aria-label="Location password" /><button class="small-action" type="submit">UNLOCK</button></form><button class="demo-link" type="button" data-action="show-handoff">Show preview handoff flag</button></div>`}
    <div class="divider"></div><button class="primary-button" type="button" data-action="focus-map">See this stop on the map <span>↗</span></button></div>
    <div class="intel-footer">Sample quest content · stop coordinates are provisional. <button type="button" data-action="toggle-gps">${state.previewMode ? 'Use GPS distance gate' : 'Return to preview mode'}</button> · <button type="button" data-action="reset">Reset preview</button></div>`;
}

function renderFallbackPins() {
  const positions = [[37, 57], [51, 42], [68, 53], [56, 72]];
  $('#fallbackPins').innerHTML = STATIONS.map((station, index) => `<button class="quest-marker fallback-pin ${stationStatus(station)} ${state.selected === station.id ? 'selected' : ''}" style="left:${positions[index][0]}%;top:${positions[index][1]}%" type="button" data-action="select" data-station="${station.id}" aria-label="${escapeHtml(station.place)}"><span class="marker-core"><span>${station.icon}</span></span><span class="marker-label">${escapeHtml(station.place)}</span></button>`).join('');
}
function updateMapMarkers() {
  mapMarkers.forEach(({ station, el }) => {
    el.className = `maplibregl-marker quest-marker ${stationStatus(station)} ${state.selected === station.id ? 'selected' : ''}`;
  });
}
function renderAvatar() {
  $('#playerName').textContent = state.avatar === 'female' ? 'The Trailblazer' : 'The Adventurer';
  $('#playerPortrait').classList.toggle('female', state.avatar === 'female');
  const avatarModel = $('#mapAvatar');
  const source = `./assets/player-${state.avatar}.glb`;
  if (avatarModel.getAttribute('src') !== source) avatarModel.setAttribute('src', source);
  avatarModel.setAttribute('alt', `${state.avatar === 'female' ? 'Female' : 'Male'} Adventurer character by Quaternius`);
  document.querySelectorAll('.avatar-option').forEach((option) => option.classList.toggle('selected', option.dataset.avatar === state.avatar));
}
function render() { persist(); renderRoute(); renderMission(); renderFallbackPins(); renderAvatar(); updateMapMarkers(); }

function selectStation(id) {
  const station = STATIONS.find((item) => item.id === id); if (!station) return;
  state.selected = id; state.expandedPuzzle = 0; state.sampleShown = false;
  if (state.photo?.url) URL.revokeObjectURL(state.photo.url);
  state.photo = null; render();
  if (map) map.flyTo({ center: [station.lng, station.lat], zoom: 18.1, speed: 1.1, essential: true });
  document.body.classList.add('sheet-open');
}
function resetProgress() {
  if (!window.confirm('Reset all local preview progress?')) return;
  state.unlocked = ['lobby']; state.solved = []; state.selected = 'lobby'; state.expandedPuzzle = 0; state.photoApproved.clear();
  if (state.photo?.url) URL.revokeObjectURL(state.photo.url); state.photo = null;
  render(); showToast('Preview progress reset.');
}
function submitPuzzle(form) {
  const station = stationNow(); const index = Number(form.dataset.index);
  if (!canInteract(station)) { showToast('Move within 60 m of this stop or return to preview mode.'); return; }
  const puzzle = station.puzzles[index]; const entered = new FormData(form).get('flag')?.toString().trim().toUpperCase();
  if (puzzle.kind === 'photo' && !state.photoApproved.has(puzzleId(station, index))) { showToast('Capture and review the object photo first.'); return; }
  if (entered !== puzzle.flag) { showToast('That flag is not quite right. Check the clue and try again.'); return; }
  const id = puzzleId(station, index); if (!state.solved.includes(id)) state.solved.push(id);
  const next = station.puzzles.findIndex((_, puzzleIndex) => !state.solved.includes(puzzleId(station, puzzleIndex)));
  state.expandedPuzzle = next >= 0 ? next : null; state.sampleShown = false;
  render(); showToast(isComplete(station) ? 'Location cleared! Your next clue is ready.' : 'Flag verified. One signal closer.');
}
function submitUnlock(form) {
  const station = stationNow();
  const previous = STATIONS[stationIndex() - 1];
  if (previous && !isComplete(previous)) { showToast(`Clear ${previous.place} before unlocking this stop.`); return; }
  if (!canInteract(station)) { showToast('Move within 60 m of this stop or return to preview mode.'); return; }
  const entered = new FormData(form).get('gate')?.toString().trim().toUpperCase();
  if (entered !== station.gate) { showToast('Access denied. The previous stop holds this password.'); return; }
  if (!state.unlocked.includes(station.id)) state.unlocked.push(station.id);
  render(); showToast(`${station.place} unlocked. Three puzzles await.`);
}
function receivePhoto(file) {
  if (!file || !file.type.startsWith('image/')) { showToast('Choose an image file to continue.'); return; }
  if (state.photo?.url) URL.revokeObjectURL(state.photo.url);
  state.photo = { id: puzzleId(stationNow(), state.expandedPuzzle), name: file.name, url: URL.createObjectURL(file) };
  renderMission(); showToast('Photo ready for the preview review step.');
}
function locate() {
  if (!navigator.geolocation) { showToast('Location is not available in this browser.'); return; }
  showToast('Requesting your location…');
  navigator.geolocation.getCurrentPosition((position) => {
    state.location = { lat: position.coords.latitude, lng: position.coords.longitude };
    if (map && maplibregl) {
      locationMarker?.remove(); const el = document.createElement('div'); el.className = 'user-marker'; el.textContent = '●';
      locationMarker = new maplibregl.Marker({ element: el }).setLngLat([state.location.lng, state.location.lat]).addTo(map);
    }
    renderMission();
    const distance = distanceMeters(state.location, CAMPUS);
    showToast(distance < 800 ? `Location found · ${distance} m from campus center.` : `Location found · ${Math.round(distance / 1000)} km from campus. Preview mode stays available.`);
  }, (error) => showToast(`Location unavailable: ${error.message}`), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (action === 'select') selectStation(button.dataset.station);
  if (action === 'close-sheet') document.body.classList.remove('sheet-open');
  if (action === 'expand-puzzle') { state.expandedPuzzle = Number(button.dataset.index); state.sampleShown = false; renderMission(); }
  if (action === 'show-sample') { state.sampleShown = true; renderMission(); }
  if (action === 'show-handoff') {
    const previous = STATIONS[stationIndex() - 1];
    showToast(previous && isComplete(previous) ? `Preview handoff flag: ${stationNow().gate}` : `Clear ${previous?.place || 'the previous stop'} to earn its handoff flag.`);
  }
  if (action === 'review-photo') {
    const id = puzzleId(stationNow(), state.expandedPuzzle);
    if (state.photo?.id !== id) { showToast('Capture or choose a photo first.'); return; }
    state.photoApproved.add(id); renderMission(); showToast('Demo approval only. A server would verify the object and location.');
  }
  if (action === 'focus-map') { document.body.classList.remove('sheet-open'); if (map) map.flyTo({ center: [stationNow().lng, stationNow().lat], zoom: 18.4, essential: true }); }
  if (action === 'toggle-gps') { state.previewMode = !state.previewMode; renderMission(); showToast(state.previewMode ? 'Preview mode enabled.' : 'GPS distance gate enabled. Use the locate button first.'); }
  if (action === 'reset') resetProgress();
  if (action === 'celebrate') showToast('Kryptex found. Quest complete!');
});
document.addEventListener('submit', (event) => {
  const action = event.target.dataset.action; if (!action) return;
  event.preventDefault(); if (action === 'submit-puzzle') submitPuzzle(event.target); if (action === 'unlock') submitUnlock(event.target);
});
document.addEventListener('change', (event) => { if (event.target.id === 'photoInput') receivePhoto(event.target.files?.[0]); });
$('#avatarButton').addEventListener('click', () => $('#avatarDialog').showModal());
$('#avatarButtonMobile').addEventListener('click', () => $('#avatarDialog').showModal());
document.querySelectorAll('.avatar-option').forEach((button) => button.addEventListener('click', () => { state.avatar = button.dataset.avatar; renderAvatar(); persist(); $('#avatarDialog').close(); showToast('Explorer updated.'); }));
document.querySelectorAll('.avatar-art model-viewer').forEach((viewer) => viewer.addEventListener('load', () => viewer.parentElement.classList.add('model-ready')));
$('#helpButton').addEventListener('click', () => $('#helpDialog').showModal());
$('#mobileQuestTrigger').addEventListener('click', () => document.body.classList.add('sheet-open'));
$('#locateButton').addEventListener('click', locate);
$('#recenterButton').addEventListener('click', () => { if (map) map.flyTo({ center: [CAMPUS.lng, CAMPUS.lat], zoom: 17.4, essential: true }); else showToast('Campus preview centered.'); });
$('#zoomInButton').addEventListener('click', () => map ? map.zoomIn() : showToast('Live map tiles are still loading.'));
$('#zoomOutButton').addEventListener('click', () => map ? map.zoomOut() : showToast('Live map tiles are still loading.'));

async function startMap() {
  try {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.css'; document.head.append(css);
    maplibregl = await import('https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.mjs');
    map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', center: [CAMPUS.lng, 25.13156], zoom: 17.2, pitch: 38, bearing: -17, minZoom: 15, maxZoom: 19.5, attributionControl: true });
    map.scrollZoom.disable();
    STATIONS.forEach((station) => {
      const el = document.createElement('button'); el.type = 'button'; el.dataset.action = 'select'; el.dataset.station = station.id;
      el.setAttribute('aria-label', station.place); el.innerHTML = `<span class="marker-core"><span>${station.icon}</span></span><span class="marker-label">${escapeHtml(station.place)}</span>`;
      new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([station.lng, station.lat]).addTo(map);
      mapMarkers.push({ station, el });
    });
    updateMapMarkers();
    map.once('idle', () => { $('#map').classList.add('is-ready'); $('#mapFallback').classList.add('is-hidden'); $('.world').classList.add('map-live'); });
  } catch (error) {
    console.warn('Live map unavailable; illustrated campus preview remains visible.', error);
    showToast('Live map unavailable. Illustrated campus preview is ready.');
  }
}

render();
startMap();
