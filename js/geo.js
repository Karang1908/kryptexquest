import { CONFIG } from './config.js';
import { createPositionFilter } from './filter.js';

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
 * Real GPS (watchPosition, fused and filtered) or a keyboard / pad driven simulator, behind one interface.
 * handlers: onFix(fix), onStatus(status, detail), getHeading() -> compass degrees|null, getMotion() -> step-detector state.
 * status: 'searching' | 'ok' | 'denied' | 'unavailable' | 'insecure'
 * fix: { lat, lng, accuracy, heading|null, speed, moving, source: 'gps'|'sim', filtered, t }
 *
 * Real-time pipeline: raw GPS fixes (about 1 Hz, noisy, lagging) -> Kalman filter -> predicted forward at 10 Hz
 * between fixes, steered by the step detector so starting and stopping register within a step or two.
 */
const PREDICT_MS = 100;
const STALE_GPS_MS = 12000;

export function createLocation({ onFix, onStatus, getHeading, getMotion }) {
  let watchId = null;
  let last = null;
  let simTimer = null;
  let simDir = { x: 0, y: 0 };
  let simFast = false;
  let simLast = 0;
  const filter = createPositionFilter();
  let predictTimer = null;
  let lastGpsAt = 0;
  let rawAccuracy = 50;

  function emit(fix) { last = fix; onFix(fix); }

  /** Let the accelerometer steer the filter: walking pushes velocity toward the cadence speed, standing still zeroes it. */
  function applyMotion() {
    const m = getMotion?.();
    if (!m?.available) { filter.setMotionNoise(1.0); return false; }
    if (m.still) { filter.setMotionNoise(0.15); filter.stillHint(); return false; }
    if (m.walking) {
      filter.setMotionNoise(1.5);
      const s = filter.state();
      // Trust GPS's own direction of travel once it has one; the phone's compass may be pointing the wrong way in a pocket.
      const direction = s?.heading ?? getHeading?.() ?? null;
      if (direction != null) filter.velocityHint(Math.min(4.5, Math.max(0.8, m.cadence * 0.72)), direction, 1.2);
      return true;
    }
    filter.setMotionNoise(1.0);
    return false;
  }

  function emitFiltered() {
    const s = filter.state();
    if (!s) return;
    const stepping = applyMotion();
    const m = getMotion?.();
    const moving = m?.available ? stepping : s.speed > 0.8;
    emit({
      lat: s.lat, lng: s.lng,
      // The filter gets over-confident because GPS errors are correlated; never claim better than ~70% of what the chip said.
      accuracy: Math.max(s.accuracy, rawAccuracy * 0.7),
      heading: s.heading, speed: s.speed, moving, source: 'gps', filtered: true, t: Date.now(),
    });
  }

  function acceptGps(pos) {
    const c = pos.coords;
    if (!filter.update({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy })) return;   // far too inaccurate to use
    lastGpsAt = Date.now();
    rawAccuracy = c.accuracy;
    emitFiltered();
    onStatus('ok');
  }

  function beginWatch() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(acceptGps, (error) => {
      if (error.code === error.PERMISSION_DENIED) onStatus('denied', error.message);
      else if (error.code === error.POSITION_UNAVAILABLE) onStatus('unavailable', error.message);
      else onStatus('searching', 'Still looking for a GPS signal…');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  function startGps() {
    stopSim();
    if (!window.isSecureContext) { onStatus('insecure'); return; }   // browsers refuse location (silently, no prompt) on plain http
    if (!navigator.geolocation) { onStatus('unavailable', 'This browser has no location support.'); return; }
    if (watchId !== null) return;
    onStatus('searching');
    lastGpsAt = Date.now();
    beginWatch();
    // A quick coarse fix (cached or network based) puts the explorer on the map seconds before the first real GPS fix.
    navigator.geolocation.getCurrentPosition((pos) => { if (!filter.ready()) acceptGps(pos); }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 });
    // Between fixes: keep predicting so the explorer moves continuously, and revive a watch that silently stalled.
    predictTimer = setInterval(() => {
      if (!filter.ready()) return;
      filter.predict(Date.now());
      emitFiltered();
      if (Date.now() - lastGpsAt > STALE_GPS_MS) { lastGpsAt = Date.now(); beginWatch(); }
    }, PREDICT_MS);
  }

  function stopGps() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    clearInterval(predictTimer); predictTimer = null;
    filter.reset();
  }

  function simTick(now) {
    const dt = Math.min(0.25, (now - simLast) / 1000);
    simLast = now;
    if (!last) return;
    if (!simDir.x && !simDir.y) { if (last.moving) emit({ ...last, moving: false }); return; }
    const len = Math.hypot(simDir.x, simDir.y);
    const speed = simFast ? 4 : 1.6; // m/s: a jog or a stroll
    const p = offsetLatLng(last, (simDir.x / len) * speed * dt, (simDir.y / len) * speed * dt);
    emit({ ...last, ...p, accuracy: 5, source: 'sim', moving: true, t: Date.now(), heading: (Math.atan2(simDir.x, simDir.y) / rad + 360) % 360 });
  }

  function startSim(from) {
    stopGps();
    last = { ...(from || last || CONFIG.campus), accuracy: 5, heading: null, moving: false, source: 'sim', t: Date.now() };
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
