import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';
import { loadMapLibre, buildStyle, whenLoaded, circlePolygon, stopMarkerElement } from './map-core.js';

const ANIM = { idle: 'CharacterArmature|Idle', walk: 'CharacterArmature|Walk', run: 'CharacterArmature|Run' };
const CAMERA = { zoom: 19.4, pitch: 67 };          // third-person: low, tilted, close to the explorer
const PEEK_RETURN_MS = 8000;                        // snap back to the explorer after this long without touching the map
const shortestAngle = (from, to) => ((to - from + 540) % 360) - 180;

export async function createWorld({ onStopTap, onPeekChange }) {
  const maplibregl = await loadMapLibre();
  const map = new maplibregl.Map({
    container: 'map', style: await buildStyle(), center: [CONFIG.campus.lng, CONFIG.campus.lat],
    zoom: CAMERA.zoom, pitch: CAMERA.pitch, bearing: 0, minZoom: 16.5, maxZoom: 21, maxPitch: 75,
    attributionControl: { compact: true },
  });
  await whenLoaded(map);

  const game = document.getElementById('game');
  const avatarEl = document.getElementById('playerAvatar');
  const stage = document.querySelector('.player-stage');

  // The ring lives under the explorer's feet; its centre dot only shows while you look around the map.
  // The pulse animates a child because MapLibre owns the marker element's own transform.
  const ringEl = document.createElement('div');
  ringEl.innerHTML = '<div class="player-ring"></div><div class="player-dot"></div>';
  const ring = new maplibregl.Marker({ element: ringEl, pitchAlignment: 'map', rotationAlignment: 'map' })
    .setLngLat([CONFIG.campus.lng, CONFIG.campus.lat]).addTo(map);

  map.addSource('accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#4285F4', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#4285F4', 'line-opacity': 0.5, 'line-width': 1.5 } });

  let target = null;          // latest fix
  let shown = null;           // smoothed on-screen position
  let heading = 0;            // direction of travel, degrees from north
  let camBearing = 0;         // map rotation; follows heading so the explorer always walks "up" the screen
  let northUp = false;
  let speed = 0;
  let anim = '';
  let following = true;
  let easing = false;
  let touching = false;       // a finger is down on the map: stop steering the camera so the drag can start
  let peekTimer = null;
  let last = performance.now();
  let modelReady = avatarEl.loaded === true; // the model may have finished loading before the world existed
  let appliedYaw = null;
  const markers = new Map();

  avatarEl.addEventListener('load', () => { modelReady = true; appliedYaw = null; });
  avatarEl.addEventListener('error', () => { modelReady = false; });

  function setAnim(name) {
    if (anim === name) return;
    anim = name;
    avatarEl.setAttribute('animation-name', name);
  }

  function lockGestures(follow) {
    // Dragging is always on: the first drag is what switches to look-around. Rotation and tilt only unlock then,
    // because while following the camera owns them.
    map.dragPan.enable();
    if (follow) { map.touchZoomRotate.disableRotation(); map.touchPitch.disable(); map.dragRotate.disable(); }
    else { map.touchZoomRotate.enableRotation(); map.touchPitch.enable(); map.dragRotate.enable(); }
  }
  lockGestures(true);
  map.scrollZoom.enable();
  map.keyboard.disable();

  function enterPeek() {
    if (!following && !easing) return;
    following = false; easing = false;
    clearTimeout(peekTimer);
    game.classList.add('peeking');
    stage.classList.add('hidden');
    lockGestures(false);
    onPeekChange?.(true);
  }
  function armPeekReturn() {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => api.recenter(), PEEK_RETURN_MS);
  }
  // jumpTo() cancels an in-flight gesture, so the camera must let go while a finger is down.
  ['mousedown', 'touchstart'].forEach((name) => map.on(name, () => { touching = true; }));
  ['mouseup', 'touchend', 'touchcancel'].forEach((name) => map.on(name, () => { touching = false; }));
  // Putting a finger on the map leaves follow mode. Zooming alone does not.
  map.on('dragstart', (e) => { if (e.originalEvent) { enterPeek(); armPeekReturn(); } });
  map.on('rotatestart', (e) => { if (e.originalEvent && following) { enterPeek(); armPeekReturn(); } });
  map.on('pitchstart', (e) => { if (e.originalEvent && following) { enterPeek(); armPeekReturn(); } });
  map.on('moveend', (e) => { if (e.originalEvent && !following) armPeekReturn(); });

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!target) return;
    if (!shown) shown = { lat: target.lat, lng: target.lng };

    if (distanceM(shown, target) > 150) { shown = { lat: target.lat, lng: target.lng }; speed = 0; }
    else {
      const k = 1 - Math.exp(-dt / 0.45);
      const next = { lat: shown.lat + (target.lat - shown.lat) * k, lng: shown.lng + (target.lng - shown.lng) * k };
      const step = distanceM(shown, next);
      const instant = dt > 0 ? step / dt : 0;
      speed += (instant - speed) * 0.12;
      if (instant > 0.25 && step > 0.001) heading += shortestAngle(heading, bearingDeg(shown, next)) * Math.min(1, dt * 7);
      shown = next;
    }

    if (speed > 2.6) setAnim(ANIM.run);
    else if (speed > 0.45) setAnim(ANIM.walk);
    else if (speed < 0.2) setAnim(ANIM.idle);

    // Third person: turn the world, not the explorer. Only while actually moving, and slowly, to avoid whiplash.
    if (northUp) camBearing += shortestAngle(camBearing, 0) * (1 - Math.exp(-dt / 0.5));
    else if (speed > 0.6) camBearing += shortestAngle(camBearing, heading) * (1 - Math.exp(-dt / 0.9));
    camBearing = (camBearing + 360) % 360;

    // Seen from behind. With north-up (or while the camera catches up) the explorer visibly turns instead.
    // model-viewer 4.3.1 throws from its `orientation` setter, so turn the camera around the model.
    const facing = heading - camBearing;
    const yaw = Math.round(180 + facing + 360) % 360;
    if (modelReady && yaw !== appliedYaw) { appliedYaw = yaw; avatarEl.setAttribute('camera-orbit', `${yaw}deg 78deg 4.2m`); }

    ring.setLngLat([shown.lng, shown.lat]);
    if (following && !easing && !touching) map.jumpTo({ center: [shown.lng, shown.lat], bearing: camBearing });
  }
  requestAnimationFrame(frame);

  function stopState(stop, status) {
    const near = target && distanceM(target, stop) <= (stop.radius || CONFIG.defaultRadiusM);
    return status === 'cleared' ? 'cleared' : status === 'locked' ? 'locked' : near ? 'near' : 'open';
  }

  const api = {
    map,
    setStops(stops) {
      markers.forEach(({ marker }) => marker.remove());
      markers.clear();
      stops.forEach((stop) => {
        const el = stopMarkerElement(stop);
        el.addEventListener('click', (event) => { event.stopPropagation(); onStopTap(stop.id); });
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([stop.lng, stop.lat]).addTo(map);
        markers.set(stop.id, { stop, el, marker });
      });
    },
    /** statuses: { stopId: 'locked' | 'open' | 'cleared' } */
    refreshStops(statuses, selectedId) {
      markers.forEach(({ stop, el }) => {
        el.className = `stop-marker ${stopState(stop, statuses[stop.id])}${selectedId === stop.id ? ' selected' : ''}`;
      });
    },
    setFix(fix) {
      target = fix;
      map.getSource('accuracy').setData(circlePolygon(fix, Math.min(fix.accuracy || 0, 120)));
      if (fix.heading != null && fix.source === 'sim') heading = fix.heading;
    },
    shownPosition: () => shown || target,
    bearing: () => camBearing,
    isMoving: () => speed > 0.45,
    setAvatar(kind) {
      const src = `./assets/player-${kind}.glb`;
      if (avatarEl.getAttribute('src') !== src) { modelReady = false; avatarEl.setAttribute('src', src); }
      avatarEl.setAttribute('alt', `${kind === 'female' ? 'Female' : 'Male'} adventurer`);
    },
    setNorthUp(on) { northUp = on; },
    isNorthUp: () => northUp,
    isPeeking: () => !following,
    /** Fly the camera back behind the explorer. */
    recenter() {
      clearTimeout(peekTimer);
      if (following && !easing) return;
      easing = true;
      const done = () => {
        easing = false; following = true;
        game.classList.remove('peeking');
        stage.classList.remove('hidden');
        lockGestures(true);
        onPeekChange?.(false);
      };
      map.once('moveend', done);
      const here = shown || target || CONFIG.campus;
      map.easeTo({ center: [here.lng, here.lat], bearing: camBearing, pitch: CAMERA.pitch, zoom: CAMERA.zoom, duration: 700, essential: true });
    },
  };
  return api;
}
