// Map plumbing shared by the player world and the admin console, so both show the same map.
const MAPLIBRE = 'https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl';
const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

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

let libPromise;
export function loadMapLibre() {
  libPromise ||= (async () => {
    document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${MAPLIBRE}.css` }));
    return import(`${MAPLIBRE}.mjs`);
  })();
  return libPromise;
}

/** Dark OpenFreeMap style with extruded Google-blue buildings and the navy palette above. */
export async function buildStyle() {
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
  el.querySelector('.stop-orb span').textContent = stop.icon;
  el.querySelector('.stop-label').textContent = stop.place;
  return el;
}
