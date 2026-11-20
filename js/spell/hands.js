// hands.js — compact hand reader for the spell game: One Euro filtering,
// hysteresis pinch detection and velocity extrapolation (same ideas as the
// Shape Creator app, trimmed to what a casting game needs).

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const alphaOf = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
class LowPass {
  constructor() { this.y = null; }
  filter(x, a) { this.y = this.y === null ? x : this.y + a * (x - this.y); return this.y; }
}
class OneEuro {
  constructor(minCutoff = 2.4, beta = 0.03, dCutoff = 1.2) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = new LowPass(); this.dx = new LowPass(); this.prev = null;
  }
  reset() { this.x.y = null; this.dx.y = null; this.prev = null; }
  filter(value, dt) {
    if (!(dt > 0)) dt = 1 / 60;
    const dx = this.prev === null ? 0 : (value - this.prev) / dt;
    this.prev = value;
    const edx = this.dx.filter(dx, alphaOf(this.dCutoff, dt));
    return this.x.filter(value, alphaOf(this.minCutoff + this.beta * Math.abs(edx), dt));
  }
}

export const PINCH_IN = 0.45;
export const PINCH_OUT = 0.65;

export function createHandReader(video, { extrapolate = 0.06 } = {}) {
  const slots = new Map();
  const tmp = { x: 0, y: 0 };

  function videoToScreen(nx, ny) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const vw = video.videoWidth || 4;
    const vh = video.videoHeight || 3;
    const scale = Math.max(W / vw, H / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (W - dw) / 2;
    const oy = (H - dh) / 2;
    tmp.x = W - (ox + nx * dw);
    tmp.y = oy + ny * dh;
    return tmp;
  }

  function slot(name) {
    let st = slots.get(name);
    if (!st) {
      st = {
        fx: Array.from({ length: 21 }, () => new OneEuro()),
        fy: Array.from({ length: 21 }, () => new OneEuro()),
        pts: new Float32Array(42),
        out: new Float32Array(42),
        prev: new Float32Array(42),
        fresh: true,
        tPrev: 0, tCur: 0, tLast: -1e9,
        pinch: false, ratio: 1, openness: 1,
        roll: 0,
      };
      slots.set(name, st);
    }
    return st;
  }

  /** Feed a MediaPipe result; returns the slot names seen this frame. */
  function ingest(result, now) {
    const lms = result.landmarks || [];
    const handed = result.handednesses || result.handedness || [];
    const seen = new Set();

    lms.forEach((lm, i) => {
      const label = handed[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
      const name = label === 'Left' ? 'L' : 'R';
      const st = slot(name);
      seen.add(name);

      const dt = clamp((now - (st.tLast < 0 ? now - 16 : st.tLast)) / 1000, 0.004, 0.08);
      st.tLast = now;
      st.prev.set(st.pts);
      st.tPrev = st.tCur;
      st.tCur = now;

      for (let k = 0; k < 21; k++) {
        const p = videoToScreen(lm[k].x, lm[k].y);
        st.pts[k * 2] = st.fx[k].filter(p.x, dt);
        st.pts[k * 2 + 1] = st.fy[k].filter(p.y, dt);
      }
      if (st.fresh) { st.prev.set(st.pts); st.tPrev = now - 16; st.fresh = false; }

      const palm = Math.max(1e-4, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y, (lm[0].z || 0) - (lm[9].z || 0)));
      const ratio = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y, (lm[4].z || 0) - (lm[8].z || 0)) / palm;
      st.ratio = ratio;
      st.pinch = st.pinch ? ratio < PINCH_OUT : ratio < PINCH_IN;
      st.openness = (
        Math.hypot(lm[8].x - lm[0].x, lm[8].y - lm[0].y) +
        Math.hypot(lm[12].x - lm[0].x, lm[12].y - lm[0].y) +
        Math.hypot(lm[16].x - lm[0].x, lm[16].y - lm[0].y) +
        Math.hypot(lm[20].x - lm[0].x, lm[20].y - lm[0].y)
      ) / (4 * palm);
      st.roll = Math.atan2(st.pts[19] - st.pts[1], st.pts[18] - st.pts[0]);
    });

    for (const [name, st] of slots) {
      if (!seen.has(name)) {
        st.pinch = false;
        if (now - st.tLast > 220) { st.fx.forEach((f) => f.reset()); st.fy.forEach((f) => f.reset()); }
      }
    }
    return seen;
  }

  /** Extrapolated, ready-to-use hands for this render frame. */
  function hands(now, intervalMs = 33) {
    const list = [];
    const maxAhead = Math.min(extrapolate, (intervalMs / 1000) * 1.2);

    for (const [name, st] of slots) {
      if (now - st.tLast > 220) continue;
      const span = Math.max(0.004, (st.tCur - st.tPrev) / 1000);
      const ahead = (Math.min(Math.max(now - st.tCur, 0) / 1000, maxAhead) * 0.6) / span;
      const out = st.out;
      for (let k = 0; k < 42; k++) out[k] = st.pts[k] + (st.pts[k] - st.prev[k]) * ahead;

      const tipX = out[16];
      const tipY = out[17];
      list.push({
        slot: name,
        pts: out,
        pinch: st.pinch,
        ratio: st.ratio,
        openness: st.openness,
        roll: st.roll,
        tip: { x: tipX, y: tipY },                                  // index fingertip
        pinchPt: { x: (out[8] + out[16]) / 2, y: (out[9] + out[17]) / 2 },
        palm: {
          x: (out[0] + out[10] + out[18] + out[26] + out[34]) / 5,
          y: (out[1] + out[11] + out[19] + out[27] + out[35]) / 5,
        },
      });
    }
    return list;
  }

  return { ingest, hands };
}
