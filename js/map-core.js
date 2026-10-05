import { stopIcon } from './icons.js';
// Map plumbing shared by the player world and the admin console, so both show the same map.
const MAPLIBRE = 'https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

// Night-time navy palette over OpenFreeMap's flat dark style (layer id -> [paint prop, colour]).
const PALETTE = {
  background: ['background-color', '#23212f'],
  water: ['fill-color', '#494660'],
  landuse_residential: ['fill-color', '#2b293b'],
  landcover_wood: ['fill-color', '#14403a'],
  landuse_park: ['fill-color', '#175a46'],
  waterway: ['line-color', '#494660'],
  highway_path: ['line-color', '#9185c0'],
  highway_minor: ['line-color', '#65579b'],
  highway_major_casing: ['line-color', '#fbbc05'],
  highway_major_inner: ['line-color', '#58546d'],
  highway_major_subtle: ['line-color', '#65579b'],
  highway_motorway_casing: ['line-color', '#fbbc05'],
  highway_motorway_subtle: ['line-color', '#65579b'],
  highway_name_other: ['text-color', '#cfc5eb'],
  highway_name_motorway: ['text-color', '#cfc5eb'],
};

let libPromise;
export function loadMapLibre() {
  libPromise ||= (async () => {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${MAPLIBRE}.css` }));
    return import(`${MAPLIBRE}.mjs`);
  })();
  return libPromise;
}

/** Dark OpenFreeMap style: night sky with a Google-blue horizon, fog, navy palette, extruded buildings. */
export async function buildStyle() {
  const style = await (await fetch(STYLE_URL)).json();
  style.sky = {
    'sky-color': '#13121a', 'horizon-color': '#4a4668', 'fog-color': '#38354b',
    'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0,
  };
  const index = style.layers.findIndex((layer) => layer.id === 'building');
  if (index >= 0) {
    style.layers.splice(index, 1, {
      id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      paint: {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#454259', 30, '#55526c', 90, '#6457a2'],
        'fill-extrusion-height': ['*', 0.7, ['coalesce', ['get', 'render_height'], 8]],
        'fill-extrusion-base': ['*', 0.7, ['coalesce', ['get', 'render_min_height'], 0]],
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

export function whenLoaded(map, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Map style took too long to load.')), timeoutMs);
    map.once('load', () => { clearTimeout(timer); resolve(); });
  });
}

export function circlePolygon(center, radiusM, steps = 48) {
  const coords = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (radiusM * Math.cos(a)) / 111320;
    const dLng = (radiusM * Math.sin(a)) / (111320 * Math.cos(center.lat * Math.PI / 180));
    coords.push([center.lng + dLng, center.lat + dLat]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] } };
}

/** One DOM element for a quest stop pin; state: locked | open | near | cleared. */
export function stopMarkerElement(stop) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'stop-marker locked';
  el.setAttribute('aria-label', stop.place);
  el.innerHTML = '<span class="stop-pulse"></span><span class="stop-orb"><span></span></span><span class="stop-pole"></span><span class="stop-label"></span>';
  el.querySelector('.stop-orb span').innerHTML = stopIcon(stop);
  el.querySelector('.stop-label').textContent = stop.place;
  return el;
}
