import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';
import { loadMapLibre, buildStyle, whenLoaded, circlePolygon } from './map-core.js';
import { createScene3D } from './scene3d.js';

const ANIM = { idle: 'CharacterArmature|Idle', walk: 'CharacterArmature|Walk', run: 'CharacterArmature|Run' };
// Pokémon GO camera: low, tilted far enough to show the horizon, wide field of view, explorer dead centre.
const CAMERA = { zoom: 18.6, pitch: 66, fov: 58 };
const LABEL_RANGE_M = 260;
const shortestAngle = (from, to) => ((to - from + 540) % 360) - 180;

export async function createWorld({ onStopTap }) {
  const maplibregl = await loadMapLibre();
  const map = new maplibregl.Map({
    container: 'map', style: await buildStyle(), center: [CONFIG.campus.lng, CONFIG.campus.lat],
    zoom: CAMERA.zoom, pitch: CAMERA.pitch, bearing: 0, minZoom: 17, maxZoom: 20.5, maxPitch: 85,
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
  let speed = 0;
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

    // Third person: the camera swings in behind the explorer, slowly and only while walking, to avoid whiplash.
    if (northUp) camBearing += shortestAngle(camBearing, 0) * (1 - Math.exp(-dt / 0.5));
    else if (speed > 0.6) camBearing += shortestAngle(camBearing, heading) * (1 - Math.exp(-dt / 1.1));
    camBearing = (camBearing + 360) % 360;

    scene3d.update({ origin: shown, heading, bearing: camBearing });
    map.jumpTo({ center: [shown.lng, shown.lat], bearing: camBearing });
    layoutLabels();
  }
  requestAnimationFrame(frame);

  // Tapping a floating beacon opens that stop. (The map itself is not draggable; this is a game camera.)
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
      target = fix;
      map.getSource('accuracy').setData(circlePolygon(fix, Math.min(fix.accuracy || 0, 120)));
      if (fix.heading != null && fix.source === 'sim') heading = fix.heading;
    },
    shownPosition: () => shown || target,
    bearing: () => camBearing,
    isMoving: () => speed > 0.45,
    setAvatar(kind) { return scene3d.setAvatarKind(kind); },
    setNorthUp(on) { northUp = on; },
    isNorthUp: () => northUp,
  };
}
