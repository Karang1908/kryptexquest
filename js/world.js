import { CONFIG } from './config.js';
import { distanceM, bearingDeg } from './geo.js';

const MAPLIBRE = 'https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const ANIM = { idle: 'CharacterArmature|Idle', walk: 'CharacterArmature|Walk', run: 'CharacterArmature|Run' };

const shortestAngle = (from, to) => ((to - from + 540) % 360) - 180;

function circlePolygon(center, radiusM, steps = 48) {
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (radiusM * Math.cos(a)) / 111320;
    const dLng = (radiusM * Math.sin(a)) / (111320 * Math.cos(center.lat * Math.PI / 180));
    coords.push([center.lng + dLng, center.lat + dLat]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
}

/** Dark OpenFreeMap style with extruded Google-blue buildings and a night-time palette. */
async function buildStyle() {
  const style = await (await fetch(STYLE_URL)).json();
  const index = style.layers.findIndex((layer) => layer.id === 'building');
  if (index >= 0) {
    style.layers.splice(index, 1, {
      id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#172036', 30, '#1f2c4d', 90, '#2b3c6b'],
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.92,
      },
    });
  }
  style.layers.forEach((layer) => {
    const [prop, color] = PALETTE[layer.id] || [];
    if (prop) layer.paint = { ...layer.paint, [prop]: color };
  });
  return style;
}

// Night-time navy palette over OpenFreeMap's flat dark style (layer id -> [paint prop, colour]).
const PALETTE = {
  background: ['background-color', '#0c1222'],
  water: ['fill-color', '#12305e'],
  landuse_residential: ['fill-color', '#0f1629'],
  landcover_wood: ['fill-color', '#0f2a22'],
  landuse_park: ['fill-color', '#12352a'],
  waterway: ['line-color', '#12305e'],
  highway_path: ['line-color', '#3b4a73'],
  highway_minor: ['line-color', '#2a3558'],
  highway_major_casing: ['line-color', '#34406a'],
  highway_major_inner: ['line-color', '#232d4d'],
  highway_major_subtle: ['line-color', '#2d3a63'],
  highway_motorway_casing: ['line-color', '#34406a'],
  highway_motorway_subtle: ['line-color', '#2d3a63'],
  highway_name_other: ['text-color', '#8fa0d0'],
  highway_name_motorway: ['text-color', '#8fa0d0'],
};

export async function createWorld({ onStopTap, onFail }) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${MAPLIBRE}.css` }));
  let maplibregl;
  let map;
  try {
    maplibregl = await import(`${MAPLIBRE}.mjs`);
    const style = await buildStyle();
    map = new maplibregl.Map({
      container: 'map', style, center: [CONFIG.campus.lng, CONFIG.campus.lat], zoom: 18, pitch: 62, bearing: 0,
      minZoom: 16, maxZoom: 19.5, maxPitch: 70, attributionControl: { compact: true },
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Map style took too long to load.')), 20000);
      map.once('load', () => { clearTimeout(timer); resolve(); });
    });
  } catch (error) {
    onFail?.(error);
    throw error;
  }

  // Pokémon GO camera: the player never leaves the screen centre, the world moves under them.
  map.dragPan.disable();
  map.touchPitch.disable();
  map.keyboard.disable();
  map.scrollZoom.enable();

  const avatarEl = document.getElementById('playerAvatar');
  const stage = document.querySelector('.player-stage');
  // The pulse animates a child: MapLibre owns the marker element's own transform.
  const ringEl = document.createElement('div');
  ringEl.innerHTML = '<div class="player-ring"></div>';
  const ring = new maplibregl.Marker({ element: ringEl, pitchAlignment: 'map', rotationAlignment: 'map' }).setLngLat([CONFIG.campus.lng, CONFIG.campus.lat]).addTo(map);

  map.addSource('accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'accuracy-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#4285F4', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'accuracy-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#4285F4', 'line-opacity': 0.5, 'line-width': 1.5 } });

  let target = null;           // latest fix
  let shown = null;           // smoothed on-screen position
  let heading = 180;
  let speed = 0;
  let anim = '';
  let following = true;
  let last = performance.now();
  const markers = new Map();

  let modelReady = avatarEl.loaded === true; // the model may have finished loading before the world existed
  let appliedYaw = null;
  avatarEl.addEventListener('load', () => { modelReady = true; appliedYaw = null; });
  avatarEl.addEventListener('error', () => { modelReady = false; });

  function setAnim(name) {
    if (anim === name) return;
    anim = name;
    avatarEl.setAttribute('animation-name', name);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!target) return;
    if (!shown) shown = { lat: target.lat, lng: target.lng };

    const jump = distanceM(shown, target);
    if (jump > 150) { shown = { lat: target.lat, lng: target.lng }; speed = 0; }
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

    // The model is always seen from behind; turning is relative to how the map is rotated.
    const facing = heading - map.getBearing();
    // model-viewer 4.3.1 throws from its `orientation` setter, so turn the camera around the model instead.
    const yaw = Math.round(180 + facing) % 360;
    if (modelReady && yaw !== appliedYaw) { appliedYaw = yaw; avatarEl.setAttribute('camera-orbit', `${yaw}deg 76deg 4.2m`); }

    ring.setLngLat([shown.lng, shown.lat]);
    if (following) map.jumpTo({ center: [shown.lng, shown.lat] });
  }
  requestAnimationFrame(frame);

  function stopState(stop, status) {
    const near = target && distanceM(target, stop) <= (stop.radius || CONFIG.defaultRadiusM);
    return status === 'cleared' ? 'cleared' : status === 'locked' ? 'locked' : near ? 'near' : 'open';
  }

  return {
    map,
    setStops(stops) {
      stops.forEach((stop) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'stop-marker locked';
        el.setAttribute('aria-label', stop.place);
        el.innerHTML = `<span class="stop-pulse"></span><span class="stop-orb"><span>${stop.icon}</span></span><span class="stop-pole"></span><span class="stop-label"></span>`;
        el.querySelector('.stop-label').textContent = stop.place;
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
      map.getSource('accuracy').setData(circlePolygon(fix, Math.min(fix.accuracy, 120)));
      if (fix.heading != null && fix.source === 'sim') heading = fix.heading;
    },
    shownPosition: () => shown || target,
    heading: () => heading,
    bearing: () => map.getBearing(),
    isMoving: () => speed > 0.45,
    setAvatar(kind) {
      const src = `./assets/player-${kind}.glb`;
      if (avatarEl.getAttribute('src') !== src) { modelReady = false; avatarEl.setAttribute('src', src); }
      avatarEl.setAttribute('alt', `${kind === 'female' ? 'Female' : 'Male'} adventurer`);
    },
    recenter() {
      following = true;
      map.dragPan.disable();
      map.easeTo({ pitch: 62, zoom: 18, duration: 600 });
      stage.classList.remove('hidden');
    },
    /** Free-look: pan the map around, avatar hides until you recenter. */
    explore() {
      following = false;
      map.dragPan.enable();
      stage.classList.add('hidden');
    },
    flyToCampus() {
      this.explore();
      map.flyTo({ center: [CONFIG.campus.lng, CONFIG.campus.lat], zoom: 17.4, essential: true });
    },
    isFollowing: () => following,
    onUserTouch(cb) { map.on('dragstart', cb); },
  };
}
