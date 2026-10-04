// Step detector from the phone's accelerometer. It reacts within a step or two, which GPS cannot:
// "started walking", "stopped", and walking cadence (steps per second) to estimate speed.
const STEP_THRESHOLD = 1.0;     // m/s² above the slow-moving gravity baseline
const MIN_STEP_GAP_MS = 280;
const WINDOW_MS = 2500;

export function createMotion() {
  const needsPermission = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
  let listening = false; let granted = !needsPermission;
  let baseline = 9.81; let smooth = 0; let previous = 0; let lastStep = 0; let lastSample = 0;
  let steps = [];

  /** One accelerometer magnitude sample (m/s², gravity included) at time tMs. Exposed for tests. */
  function ingest(magnitude, tMs) {
    baseline += (magnitude - baseline) * 0.02;
    smooth += (magnitude - baseline - smooth) * 0.35;
    if (smooth > STEP_THRESHOLD && previous <= STEP_THRESHOLD && tMs - lastStep > MIN_STEP_GAP_MS) { lastStep = tMs; steps.push(tMs); }
    previous = smooth; lastSample = tMs;
    steps = steps.filter((s) => tMs - s < WINDOW_MS);
  }

  function onMotion(event) {
    const a = event.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    ingest(Math.hypot(a.x, a.y, a.z), performance.now());
  }

  function listen() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('devicemotion', onMotion, true);
  }

  return {
    ingest,
    needsGesture: () => needsPermission && !granted,
    autoStart() { if (!needsPermission) listen(); },
    /** Call inside a tap on iOS. */
    async request() {
      if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
      if (needsPermission && !granted) {
        try { granted = (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch { granted = false; }
        if (!granted) return 'denied';
      }
      listen();
      return 'granted';
    },
    /** { available, walking, still, cadence } at time nowMs (performance.now() clock). */
    state(nowMs = performance.now()) {
      const available = nowMs - lastSample < 1500;
      const recent = steps.filter((s) => nowMs - s < 1500);
      const cadence = steps.filter((s) => nowMs - s < 2000).length / 2;
      return {
        available,
        walking: available && recent.length >= 2,
        still: available && nowMs - (steps.at(-1) ?? 0) > 1800,
        cadence,
      };
    },
  };
}
