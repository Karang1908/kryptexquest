// One drawn icon set (24 grid, round 1.75 stroke) for the whole product: no emoji, no unicode stand-ins.
const P = {
  pin: '<path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.3" r="3.2"/>',
  out: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  flag: '<path d="M6 21V4M6 5h11l-2 4 2 4H6"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  door: '<path d="M6 21V4h12v17M4 21h16M14.5 12.5h.01"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  lab: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M8 15h8"/>',
  tree: '<path d="M12 21v-6M12 3.5a4.5 4.5 0 0 0-3.6 7.2A3.8 3.8 0 0 0 9 18h6a3.8 3.8 0 0 0 .6-7.3A4.5 4.5 0 0 0 12 3.5z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  base: '<path d="M4 11l8-7 8 7M6 10v10h12V10M10 20v-5h4v5"/>',
  arrow: '<path d="M12 3l6.5 17L12 16.3 5.5 20z"/>',
  wifioff: '<path d="M3 3l18 18M2.5 9a15 15 0 0 1 4-2.4M21.5 9A15 15 0 0 0 13 5.1M5.5 12.8a10 10 0 0 1 3-1.9M18.5 12.8a10 10 0 0 0-2.4-1.7M9 16.5a5 5 0 0 1 6 0M12 20h.01"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.7a3.5 3.5 0 0 1 0 6.6M18.5 14.2A6 6 0 0 1 21.5 20"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v1a4 4 0 0 0 4 4M16 6h4v1a4 4 0 0 1-4 4M12 13v4M8 21h8M10 17h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
  bell: '<path d="M6 17h12l-1.5-2V10a4.5 4.5 0 0 0-9 0v5zM10 20h4"/>',
  map: '<path d="M9 4l6 2 5-2v14l-5 2-6-2-5 2V6zM9 4v14M15 6v14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12L19 7"/>',
  qr: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h3v3h-3zM19 14v6M14 20h3"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-4 3 2.5 3-3L20 16"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  send: '<path d="M21 3L10 14M21 3l-6.5 18-3.5-7-7-3.5z"/>',
  note: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7"/>',
};
const FILL = new Set(['star']);

/** The icon as an inline SVG string. Size comes from CSS (.i { width: 1.25em }). */
export function icon(name, cls = '') {
  const body = P[name] || P.pin;
  return `<svg class="i ${cls}" viewBox="0 0 24 24" fill="${FILL.has(name) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Game icons (game-icons.net, CC BY 3.0; see assets/CREDITS.md) drawn through a CSS mask, so they take any colour. */
export const GAME_ICONS = ['vending-machine', 'doorway', 'bookshelf', 'erlenmeyer', 'oak', 'open-treasure-chest', 'position-marker', 'castle', 'portal', 'crystal-ball', 'torch', 'radar-sweep', 'camping-tent', 'rune-stone', 'ghost', 'lantern'];
const LEGACY = { base: 'vending-machine', door: 'doorway', book: 'bookshelf', lab: 'erlenmeyer', tree: 'oak', star: 'open-treasure-chest', pin: 'position-marker' };
const BY_TYPE = { lobby: 'doorway', library: 'bookshelf', lab: 'erlenmeyer', courtyard: 'oak' };
export const gi = (name, cls = '') => `<i class="gi gi-${name} ${cls}" aria-hidden="true"></i>`;

/** Which game icon a location uses. Organisers pick a name; older data (drawn-icon names, glyphs) maps over. */
export const LOCATION_ICONS = GAME_ICONS;
export const stopIconName = (stop) => {
  if (GAME_ICONS.includes(stop?.icon)) return stop.icon;
  if (LEGACY[stop?.icon]) return LEGACY[stop.icon];
  if (stop?.role === 'hub') return 'vending-machine';
  if (stop?.role === 'bonus') return 'open-treasure-chest';
  return BY_TYPE[stop?.type] || 'position-marker';
};
export const stopIcon = (stop, cls = '') => gi(stopIconName(stop), cls);

/** Fill any <i data-icon="name"> placeholder in static HTML. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    const t = document.createElement('template');
    t.innerHTML = icon(el.dataset.icon, el.className);
    const svg = t.content.firstElementChild;
    if (el.id) svg.id = el.id;
    el.replaceWith(svg);
  });
}
