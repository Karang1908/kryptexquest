// Phone compass + gyro: which way the player is facing, in degrees clockwise from true north.
// The player holds the phone upright in front of them, so we want the direction the back of the phone points.
const rad = Math.PI / 180;
const STALE_MS = 2500;
const shortest = (from, to) => ((to - from + 540) % 360) - 180;

/** Heading of the back of the device from W3C DeviceOrientation angles (alpha must be relative to north). */
function headingFromEuler(alpha, beta, gamma) {
  const x = beta * rad; const y = gamma * rad; const z = alpha * rad;
  const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
  const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
  let heading = Math.atan(vx / vy);
  if (vy < 0) heading += Math.PI; else if (vx < 0) heading += 2 * Math.PI;
  return (heading / rad + 360) % 360;
}

export function createCompass() {
  // iOS 13+ only delivers orientation events after requestPermission(), which must run inside a tap.
  const needsPermission = typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
  let listening = false;
  let granted = !needsPermission;
  let smooth = null;
  let lastAt = 0;
  let sticky = false;       // injected headings (simulator) never go stale

  function accept(heading) {
    smooth = smooth === null ? heading : (smooth + shortest(smooth, heading) * 0.3 + 360) % 360;
    lastAt = performance.now();
  }

  function onOrientation(event) {
    let heading = null;
    if (typeof event.webkitCompassHeading === 'number') heading = event.webkitCompassHeading;       // iOS: tilt-compensated, true north
    else if (event.absolute && event.alpha != null && event.beta != null) heading = headingFromEuler(event.alpha, event.beta, event.gamma);
    if (heading === null || Number.isNaN(heading)) return;   // relative-alpha events are not a compass
    accept(heading);
  }

  function listen() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('deviceorientationabsolute', onOrientation, true); // Android Chrome
    window.addEventListener('deviceorientation', onOrientation, true);         // iOS Safari
  }

  return {
    /** True when the browser will not give us a compass until the player taps something. */
    needsGesture: () => needsPermission && !granted,
    supported: () => typeof DeviceOrientationEvent !== 'undefined',
    /** Call from a click handler. Resolves 'granted' | 'denied' | 'unsupported'. */
    async request() {
      if (typeof DeviceOrientationEvent === 'undefined') return 'unsupported';
      if (needsPermission && !granted) {
        try { granted = (await DeviceOrientationEvent.requestPermission()) === 'granted'; } catch { granted = false; }
        if (!granted) return 'denied';
      }
      listen();
      return 'granted';
    },
    /** Start without a tap where the platform allows it (Android, desktop). */
    autoStart() { if (!needsPermission) listen(); },
    /** Simulator / tests. */
    inject(heading) { sticky = true; accept(heading); },
    clearInjected() { sticky = false; smooth = null; },
    /** Current heading, or null when no recent sensor reading. */
    heading() { return smooth !== null && (sticky || performance.now() - lastAt < STALE_MS) ? smooth : null; },
  };
}
