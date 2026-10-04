// Position filter: a Kalman filter (position + velocity per axis, in metres east/north of the first fix).
// Why: raw browser GPS jumps around by the reported accuracy, arrives about once a second, and lags a few seconds
// behind real movement. The filter (1) weights every fix by its reported accuracy, (2) throws out wild fixes,
// (3) keeps predicting between fixes so movement is continuous, and (4) can be steered by step detection
// (walking/standing still) to react instantly instead of waiting for GPS to notice.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 111320;
const MAX_ACCURACY = 150;       // ignore fixes worse than this (cell-tower guesses)

class Axis {
  constructor(p, variance) { this.p = p; this.v = 0; this.P = [[variance, 0], [0, 25]]; }

  predict(dt, qa) {
    const P = this.P; const q = qa * qa;
    this.p += this.v * dt;
    const p00 = P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1] + (q * dt ** 4) / 4;
    const p01 = P[0][1] + dt * P[1][1] + (q * dt ** 3) / 2;
    const p10 = P[1][0] + dt * P[1][1] + (q * dt ** 3) / 2;
    const p11 = P[1][1] + q * dt * dt;
    this.P = [[p00, p01], [p10, p11]];
  }

  /** Position measurement z with variance r. */
  updatePosition(z, r) {
    const P = this.P; const s = P[0][0] + r;
    const k0 = P[0][0] / s; const k1 = P[1][0] / s; const y = z - this.p;
    this.p += k0 * y; this.v += k1 * y;
    this.P = [[(1 - k0) * P[0][0], (1 - k0) * P[0][1]], [P[1][0] - k1 * P[0][0], P[1][1] - k1 * P[0][1]]];
  }

  /** Velocity measurement z with variance r (from step detection). */
  updateVelocity(z, r) {
    const P = this.P; const s = P[1][1] + r;
    const k0 = P[0][1] / s; const k1 = P[1][1] / s; const y = z - this.v;
    this.p += k0 * y; this.v += k1 * y;
    this.P = [[P[0][0] - k0 * P[1][0], P[0][1] - k0 * P[1][1]], [(1 - k1) * P[1][0], (1 - k1) * P[1][1]]];
  }
}

export function createPositionFilter() {
  let origin = null; let east = null; let north = null; let t = 0; let qa = 1.2; let farFixes = 0;

  const toXY = (lat, lng) => ({ e: (lng - origin.lng) * M_PER_DEG_LNG * Math.cos((origin.lat * Math.PI) / 180), n: (lat - origin.lat) * M_PER_DEG_LAT });

  function advance(now) {
    const dt = Math.min(10, Math.max(0, (now - t) / 1000));
    if (dt > 0) { east.predict(dt, qa); north.predict(dt, qa); }
    t = now;
  }

  return {
    ready: () => origin !== null,

    /** A GPS fix. Returns false when it was ignored. */
    update({ lat, lng, accuracy }, now = Date.now()) {
      if (!(accuracy <= MAX_ACCURACY)) return false;
      const r = Math.max(accuracy, 3) ** 2;
      if (!origin) {
        origin = { lat, lng };
        east = new Axis(0, r); north = new Axis(0, r); t = now;
        return true;
      }
      advance(now);
      const z = toXY(lat, lng);
      const d = Math.hypot(z.e - east.p, z.n - north.p);
      const sigma = Math.sqrt(Math.max(east.P[0][0], north.P[0][0]) + r);
      // A fix far outside what the filter expects is probably a bad fix: ignore it, once.
      const far = d > 4 * sigma && d > 25;
      farFixes = far ? farFixes + 1 : 0;
      // ...but if the new position keeps disagreeing (two fixes running), or is hundreds of metres away with a good
      // accuracy, we really did go there (GPS recovery, a lift, a lost signal): start over from it.
      if (far && (farFixes >= 2 || (d > 250 && accuracy <= 50))) {
        origin = { lat, lng }; east = new Axis(0, r); north = new Axis(0, r); t = now; farFixes = 0;
        return true;
      }
      if (far) return true;                  // hold: one wild fix must not drag the estimate or its velocity
      east.updatePosition(z.e, r); north.updatePosition(z.n, r);
      return true;
    },

    /** Move the estimate forward to `now` (dead reckoning on the current velocity). */
    predict(now = Date.now()) { if (origin) advance(now); },

    /** Process noise: how much the walker may change velocity. Lower while standing, higher while walking. */
    setMotionNoise(value) { qa = value; },

    /** Step detection says we walk at `speed` m/s toward `headingDeg` (clockwise from north). */
    velocityHint(speed, headingDeg, sigma = 1.2) {
      if (!origin) return;
      const h = (headingDeg * Math.PI) / 180;
      east.updateVelocity(speed * Math.sin(h), sigma * sigma);
      north.updateVelocity(speed * Math.cos(h), sigma * sigma);
    },

    /** Step detection says we are standing still: zero-velocity update. */
    stillHint(sigma = 0.35) {
      if (!origin) return;
      east.updateVelocity(0, sigma * sigma); north.updateVelocity(0, sigma * sigma);
    },

    state() {
      if (!origin) return null;
      const speed = Math.hypot(east.v, north.v);
      return {
        lat: origin.lat + north.p / M_PER_DEG_LAT,
        lng: origin.lng + east.p / (M_PER_DEG_LNG * Math.cos((origin.lat * Math.PI) / 180)),
        accuracy: Math.sqrt(Math.max(east.P[0][0], north.P[0][0])),
        speed,
        heading: speed > 0.6 ? ((Math.atan2(east.v, north.v) * 180) / Math.PI + 360) % 360 : null,
      };
    },

    reset() { origin = null; east = null; north = null; farFixes = 0; },
  };
}
