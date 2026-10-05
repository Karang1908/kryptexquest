import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';
import { loadMapLibre, buildStyle, whenLoaded, circlePolygon } from './map-core.js';
import { createScene3D } from './scene3d.js';
import { stopIcon } from './icons.js';

const ANIM = { idle: 'CharacterArmature|Idle', walk: 'CharacterArmature|Walk', run: 'CharacterArmature|Run' };
// Pokémon GO camera: low, tilted far enough to show the horizon, wide field of view, explorer dead centre. Starts close in so the explorer fills the screen.
const CAMERA = { zoom: 20.6, pitch: 64, fov: 70 };
const LABEL_RANGE_M = 260;
const FEET_Y = 0.74;            // where the explorer's feet stand, as a fraction of the screen height. Fixed on purpose: tying it to the "next signal" card made the camera jump when the card appeared
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

  // Teammates: a coloured dot with a name, updated from the location ping. The marker's own element is only positioned;
  // the visuals live on a child (MapLibre owns the marker element's transform).
  const mateMarkers = new Map();
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
  let ringAccuracy = -99;
  let ringAt = 0;
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
    // grey = discovered but locked, blue = unlocked and being solved, green = cleared, red = the base
    return status;
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

    const filtered = Boolean(target.filtered || target.source === 'sim');
    const moving = now < moveUntil;
    // Glide along the last velocity for up to 2.5 s so the explorer keeps walking between sparse GPS fixes.
    const ahead = moving && !filtered ? Math.min(2.5, (now - lastFixAt) / 1000) : 0;
    const aim = { lat: target.lat + vel.lat * ahead, lng: target.lng + vel.lng * ahead };

    let travelHeading = null;
    if (distanceM(shown, aim) > 150) { shown = { ...aim }; }
    else {
      const k = 1 - Math.exp(-dt / (filtered ? 0.12 : 0.45)); // filtered fixes arrive at 10 Hz already smooth: follow them closely
      const next = { lat: shown.lat + (aim.lat - shown.lat) * k, lng: shown.lng + (aim.lng - shown.lng) * k };
      const step = distanceM(shown, next);
      if (dt > 0 && step / dt > 0.2 && step > 0.001) travelHeading = bearingDeg(shown, next);
      shown = next;
    }

    if (moving) setAnim((filtered ? target.speed : anchor?.mps) > 2.6 ? ANIM.run : ANIM.walk);
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

    const bearing = (camBearing + view.yaw + 360) % 360;
    scene3d.update({ origin: shown, heading, bearing });
    // Top padding pushes the camera's focal point down the screen so the explorer stands low, with more of the world
    // ahead visible. Padding is part of the projection, so beacons and labels follow.
    const height = map.getCanvas().clientHeight;
    const top = Math.round(height * (2 * FEET_Y - 1));
    map.jumpTo({ center: [shown.lng, shown.lat], bearing, pitch: view.pitch, zoom: view.zoom, padding: { top, bottom: 0, left: 0, right: 0 } });
    layoutLabels();
  }
  requestAnimationFrame(frame);

  // The view stays wherever the player puts it; only the reset button brings it back behind the explorer.
  function resetView() {
    view.yaw = 0; view.pitch = CAMERA.pitch; view.zoom = CAMERA.zoom;
    if (view.offset) { view.offset = false; onViewChange?.(false); }
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
        el.querySelector('.bl-icon').innerHTML = stopIcon(stop);
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
      // The accuracy ring is a GeoJSON update: only redo it when it visibly changed.
      if (Math.abs((fix.accuracy || 0) - ringAccuracy) > 1.5 || nowMs - ringAt > 1500) {
        ringAccuracy = fix.accuracy || 0; ringAt = nowMs;
        map.getSource('accuracy').setData(circlePolygon(fix, Math.min(ringAccuracy, 120)));
      }
      if (fix.heading != null && fix.source === 'sim' && getCompass?.() == null) heading = fix.heading;
      if (fix.moving !== undefined) { moveUntil = fix.moving ? nowMs + 1200 : 0; return; }
      // Legacy path (no motion info): a "movement event" is >1 m away from the previous one.
      if (!anchor) { anchor = { lat: fix.lat, lng: fix.lng, at: nowMs, mps: 0 }; return; }
      const d = distanceM(anchor, fix);
      if (d > 1.0) {
        const secs = Math.max(0.3, (nowMs - anchor.at) / 1000);
        vel = { lat: (fix.lat - anchor.lat) / secs, lng: (fix.lng - anchor.lng) / secs };
        anchor = { lat: fix.lat, lng: fix.lng, at: nowMs, mps: Math.min(d / secs, 6) };
        moveUntil = nowMs + 3500;
      }
    },
    setMates(list) {
      const seen = new Set();
      list.forEach((m) => {
        seen.add(m.id);
        let marker = mateMarkers.get(m.id);
        if (!marker) {
          const wrap = document.createElement('div');
          const pin = document.createElement('div'); pin.className = 'mate-pin';
          pin.innerHTML = '<i class="mate-dot"></i><span class="mate-name"></span>';
          pin.querySelector('.mate-name').textContent = m.name;
          wrap.append(pin);
          marker = new maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat([m.lng, m.lat]).addTo(map);
          mateMarkers.set(m.id, marker);
        } else marker.setLngLat([m.lng, m.lat]);
      });
      mateMarkers.forEach((marker, id) => { if (!seen.has(id)) { marker.remove(); mateMarkers.delete(id); } });
    },
    shownPosition: () => shown || target,
    bearing: () => camBearing,
    isMoving: () => performance.now() < moveUntil,
    setAvatar(kind) { return scene3d.setAvatarKind(kind); },
    setNorthUp(on) { northUp = on; },
    isNorthUp: () => northUp,
    resetView,
  };
}
