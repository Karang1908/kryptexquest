import { CONFIG } from './config.js';

const R = 6371000;
const rad = Math.PI / 180;

export function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b in degrees, 0 = north, clockwise. */
export function bearingDeg(a, b) {
  const dLng = (b.lng - a.lng) * rad;
  const y = Math.sin(dLng) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos(dLng);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

export function offsetLatLng(p, eastM, northM) {
  return { lat: p.lat + northM / R / rad, lng: p.lng + eastM / (R * Math.cos(p.lat * rad)) / rad };
}

/**
 * Real GPS (watchPosition) or a keyboard / pad driven simulator, behind one interface.
 * handlers: onFix(fix), onStatus(status, detail). status: 'searching' | 'ok' | 'denied' | 'unavailable'
 * fix: { lat, lng, accuracy, heading|null, source: 'gps'|'sim', t }
 */
export function createLocation({ onFix, onStatus }) {
  let watchId = null;
  let last = null;
  let simTimer = null;
  let simDir = { x: 0, y: 0 };
  let simFast = false;
  let simLast = 0;

  function emit(fix) { last = fix; onFix(fix); }

  function acceptGps(pos) {
    const c = pos.coords;
    const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, heading: Number.isFinite(c.heading) ? c.heading : null, source: 'gps', t: pos.timestamp };
    if (last && last.source === 'gps') {
      const moved = distanceM(last, fix);
      // A poor fix that drifts less than its own error radius is noise, not walking.
      if (fix.accuracy > 80 && moved < fix.accuracy) return;
      // Standing still: keep the avatar planted, only refresh the accuracy ring.
      if (moved < Math.max(2, fix.accuracy * 0.25)) { emit({ ...last, accuracy: fix.accuracy, t: fix.t }); onStatus('ok'); return; }
    }
    emit(fix);
    onStatus('ok');
  }

  function startGps() {
    stopSim();
    if (!window.isSecureContext) { onStatus('insecure'); return; }   // browsers refuse location (silently, no prompt) on plain http
    if (!navigator.geolocation) { onStatus('unavailable', 'This browser has no location support.'); return; }
    if (watchId !== null) return;
    onStatus('searching');
    watchId = navigator.geolocation.watchPosition(acceptGps, (error) => {
      if (error.code === error.PERMISSION_DENIED) onStatus('denied', error.message);
      else if (error.code === error.POSITION_UNAVAILABLE) onStatus('unavailable', error.message);
      else onStatus('searching', 'Still looking for a GPS signal…');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function simTick(now) {
    const dt = Math.min(0.25, (now - simLast) / 1000);
    simLast = now;
    if (!last || (!simDir.x && !simDir.y)) return;
    const len = Math.hypot(simDir.x, simDir.y);
    const speed = simFast ? 4 : 1.6; // m/s: a jog or a stroll
    const p = offsetLatLng(last, (simDir.x / len) * speed * dt, (simDir.y / len) * speed * dt);
    emit({ ...last, ...p, accuracy: 5, source: 'sim', t: Date.now(), heading: (Math.atan2(simDir.x, simDir.y) / rad + 360) % 360 });
  }

  function startSim(from) {
    stopGps();
    last = { ...(from || last || CONFIG.campus), accuracy: 5, heading: null, source: 'sim', t: Date.now() };
    emit(last);
    onStatus('ok');
    simLast = performance.now();
    clearInterval(simTimer);
    simTimer = setInterval(() => simTick(performance.now()), 50);
  }

  function stopSim() { clearInterval(simTimer); simTimer = null; simDir = { x: 0, y: 0 }; }

  return {
    startGps,
    stopGps,
    startSim,
    stopSim,
    isSim: () => simTimer !== null,
    setSimDirection(x, y, fast = false) { simDir = { x, y }; simFast = fast; },
    teleport(p) { if (simTimer !== null) emit({ ...last, lat: p.lat, lng: p.lng, source: 'sim', t: Date.now() }); },
    last: () => last,
  };
}
