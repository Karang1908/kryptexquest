import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';
import { loadMapLibre, buildStyle, whenLoaded, circlePolygon } from './map-core.js';
import { createScene3D } from './scene3d.js';

const ANIM = { idle: 'CharacterArmature|Idle', walk: 'CharacterArmature|Walk', run: 'CharacterArmature|Run' };
// Pokémon GO camera: low, tilted far enough to show the horizon, wide field of view, explorer dead centre.
const CAMERA = { zoom: 19.6, pitch: 66, fov: 58 };
const VIEW_RETURN_MS = 12000;   // the camera drifts back behind the explorer after this long untouched
const LABEL_RANGE_M = 260;
const shortestAngle = (from, to) => ((to - from + 540) % 360) - 180;

export async function createWorld({ onStopTap, getCompass, onViewChange }) {
  const maplibregl = await loadMapLibre();
  const map = new maplibregl.Map({
    container: 'map', style: await buildStyle(), center: [CONFIG.campus.lng, CONFIG.campus.lat],
    zoom: CAMERA.zoom, pitch: CAMERA.pitch, bearing: 0, minZoom: 17.5, maxZoom: 21.5, maxPitch: 85,
    attributionControl: { compact: true }, interactive: false,
  });
  await whenLoaded(map);
  map.setVerticalFieldOfView(CAMERA.fov);

  const scene3d = await createScene3D(maplibregl);
  map.addLayer(scene3d.layer);

  map.addSource('accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#4285F4', 'line-opacity': 0.35, 'line-width': 1.5 } }, 'scene3d');

  const labelsEl = document.getElementById('stopLabels');
  const labels = new Map();
  let stops = [];
  let statuses = {};
  let selectedId = null;

  let target = null;          // latest fix
  let shown = null;           // smoothed on-screen position
  let heading = 0;            // direction of travel, degrees from north
  let camBearing = 0;         // map rotation: follows heading so the explorer walks "up" the screen
  let northUp = false;
  let moveUntil = 0;          // keep walking until this time: GPS fixes arrive seconds apart, the legs must not stall between them
  let vel = { lat: 0, lng: 0 }; // deg/s from the last real movement, used to glide on between fixes
  // Orbit camera: drag to swing round the explorer, drag up/down to tilt, pinch or wheel to zoom.
  // The explorer stays the fixed point; these are offsets on top of the follow camera.
  const view = { yaw: 0, pitch: CAMERA.pitch, zoom: CAMERA.zoom, touchedAt: 0, held: 0, offset: false };
  let anchor = null;          // position + time of the last movement event
  let lastFixAt = 0;
  let anim = '';
  let last = performance.now();

  function setAnim(name) {
    if (anim === name) return;
    anim = name;
    scene3d.setAnimation(name);
  }

  function stopState(stop) {
    const status = statuses[stop.id] || 'open';
    const near = target && distanceM(target, stop) <= (stop.radius || CONFIG.defaultRadiusM);
    return status === 'cleared' ? 'cleared' : status === 'locked' ? 'locked' : near ? 'near' : 'open';
  }

  function layoutLabels() {
    const placed = new Map(scene3d.beaconScreen().map((b) => [b.id, b]));
    labels.forEach((el, id) => {
      const b = placed.get(id);
      const visible = b?.visible && b.dist < LABEL_RANGE_M && b.x > -60 && b.x < innerWidth + 60;
      el.style.opacity = visible ? String(Math.max(0.35, 1 - b.dist / LABEL_RANGE_M)) : '0';
      el.style.pointerEvents = visible ? 'auto' : 'none';
      if (visible) el.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -100%) translateY(-30px) scale(${Math.min(1.15, Math.max(0.6, 160 / (b.dist + 60)))})`;
    });
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!target) return;
    if (!shown) shown = { lat: target.lat, lng: target.lng };

    const moving = now < moveUntil;
    // Glide along the last velocity for up to 2.5 s so the explorer keeps walking between sparse GPS fixes.
    const ahead = moving ? Math.min(2.5, (now - lastFixAt) / 1000) : 0;
    const aim = { lat: target.lat + vel.lat * ahead, lng: target.lng + vel.lng * ahead };

    let travelHeading = null;
    if (distanceM(shown, aim) > 150) { shown = { ...aim }; }
    else {
      const k = 1 - Math.exp(-dt / 0.45);
      const next = { lat: shown.lat + (aim.lat - shown.lat) * k, lng: shown.lng + (aim.lng - shown.lng) * k };
      const step = distanceM(shown, next);
      if (dt > 0 && step / dt > 0.2 && step > 0.001) travelHeading = bearingDeg(shown, next);
      shown = next;
    }

    if (moving) setAnim(anchor?.mps > 2.6 ? ANIM.run : ANIM.walk);
    else setAnim(ANIM.idle);

    // Facing: the phone's compass says where the player is looking; without it, face the way we walk.
    const compass = getCompass?.() ?? null;
    if (compass !== null) heading += shortestAngle(heading, compass) * (1 - Math.exp(-dt / 0.15));
    else if (travelHeading !== null) heading += shortestAngle(heading, travelHeading) * Math.min(1, dt * 7);

    // Third person: the camera swings in behind the explorer. With a compass it follows quickly (it IS the player's
    // view); otherwise slowly and only while walking, to avoid whiplash.
    if (northUp) camBearing += shortestAngle(camBearing, 0) * (1 - Math.exp(-dt / 0.5));
    else if (compass !== null) camBearing += shortestAngle(camBearing, heading) * (1 - Math.exp(-dt / 0.3));
    else if (moving) camBearing += shortestAngle(camBearing, heading) * (1 - Math.exp(-dt / 1.1));
    camBearing = (camBearing + 360) % 360;

    if (view.held === 0 && view.offset && now - view.touchedAt > VIEW_RETURN_MS) {
      const k = 1 - Math.exp(-dt / 0.5);
      view.yaw += shortestAngle(view.yaw, 0) * k; view.pitch += (CAMERA.pitch - view.pitch) * k; view.zoom += (CAMERA.zoom - view.zoom) * k;
      if (Math.abs(view.yaw) < 0.5 && Math.abs(view.pitch - CAMERA.pitch) < 0.5 && Math.abs(view.zoom - CAMERA.zoom) < 0.02) resetView(true);
    }
    const bearing = (camBearing + view.yaw + 360) % 360;
    scene3d.update({ origin: shown, heading, bearing });
    map.jumpTo({ center: [shown.lng, shown.lat], bearing, pitch: view.pitch, zoom: view.zoom });
    layoutLabels();
  }
  requestAnimationFrame(frame);

  function resetView(snap) {
    if (snap) { view.yaw = 0; view.pitch = CAMERA.pitch; view.zoom = CAMERA.zoom; }
    else view.touchedAt = -Infinity; // let the easing in frame() glide back right away
    if (snap && view.offset) { view.offset = false; onViewChange?.(false); }
  }
  function touchView() {
    view.touchedAt = performance.now();
    if (!view.offset) { view.offset = true; onViewChange?.(true); }
  }

  // Gestures on the canvas. A real drag must not also count as a tap on a beacon.
  const canvas = map.getCanvas();
  canvas.style.touchAction = 'none';
  const pointers = new Map();
  let pinchPrev = 0; let dragged = false;
  const pinchDistance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    view.held = pointers.size; dragged = false;
    if (pointers.size === 2) pinchPrev = pinchDistance();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x; const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) dragged = true;
    if (!dragged) return;
    if (pointers.size === 1) {
      view.yaw = shortestAngle(0, view.yaw - dx * 0.35);
      view.pitch = Math.min(80, Math.max(25, view.pitch - dy * 0.25));
    } else if (pointers.size === 2) {
      const d = pinchDistance();
      if (pinchPrev > 0) view.zoom = Math.min(21.5, Math.max(17.8, view.zoom + Math.log2(d / pinchPrev)));
      pinchPrev = d;
    }
    touchView();
  });
  const release = (e) => { pointers.delete(e.pointerId); view.held = pointers.size; view.touchedAt = performance.now(); pinchPrev = 0; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.zoom = Math.min(21.5, Math.max(17.8, view.zoom - e.deltaY * 0.002)); touchView(); }, { passive: false });
  canvas.addEventListener('click', (e) => { if (dragged) { e.stopImmediatePropagation(); dragged = false; } }, true);

  // Tapping a floating beacon opens that stop.
  map.getCanvas().addEventListener('click', (event) => {
    const rect = map.getCanvas().getBoundingClientRect();
    const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    const hit = scene3d.beaconScreen().filter((b) => b.visible).map((b) => ({ ...b, d: Math.hypot(b.x - x, b.y - y) })).sort((a, b) => a.d - b.d)[0];
    if (hit && hit.d < 70) onStopTap(hit.id);
  });

  return {
    map,
    setStops(next) {
      stops = next;
      scene3d.setStops(next);
      labels.forEach((el) => el.remove()); labels.clear();
      next.forEach((stop) => {
        const el = document.createElement('button');
        el.type = 'button'; el.className = 'beacon-label';
        el.innerHTML = '<span class="bl-icon"></span><span class="bl-name"></span>';
        el.querySelector('.bl-icon').textContent = stop.icon;
        el.querySelector('.bl-name').textContent = stop.place;
        el.addEventListener('click', (e) => { e.stopPropagation(); onStopTap(stop.id); });
        labelsEl.append(el);
        labels.set(stop.id, el);
      });
    },
    /** statuses: { stopId: 'locked' | 'open' | 'cleared' } */
    refreshStops(next, selected) {
      statuses = next; selectedId = selected;
      const resolved = Object.fromEntries(stops.map((s) => [s.id, stopState(s)]));
      scene3d.setStatuses(resolved, selectedId);
      labels.forEach((el, id) => { el.dataset.state = resolved[id]; el.classList.toggle('selected', id === selectedId); });
    },
    setFix(fix) {
      const nowMs = performance.now();
      target = fix; lastFixAt = nowMs;
      map.getSource('accuracy').setData(circlePolygon(fix, Math.min(fix.accuracy || 0, 120)));
      if (fix.heading != null && fix.source === 'sim' && getCompass?.() == null) heading = fix.heading;
      // A "movement event" is >1 m away from the previous one; it starts/extends walking and sets the glide velocity.
      if (!anchor) { anchor = { lat: fix.lat, lng: fix.lng, at: nowMs, mps: 0 }; return; }
      const d = distanceM(anchor, fix);
      if (d > 1.0) {
        const secs = Math.max(0.3, (nowMs - anchor.at) / 1000);
        vel = { lat: (fix.lat - anchor.lat) / secs, lng: (fix.lng - anchor.lng) / secs };
        anchor = { lat: fix.lat, lng: fix.lng, at: nowMs, mps: Math.min(d / secs, 6) };
        moveUntil = nowMs + 3500;
      }
    },
    shownPosition: () => shown || target,
    bearing: () => camBearing,
    isMoving: () => performance.now() < moveUntil,
    setAvatar(kind) { return scene3d.setAvatarKind(kind); },
    setNorthUp(on) { northUp = on; },
    isNorthUp: () => northUp,
    resetView: () => resetView(false),
  };
}
