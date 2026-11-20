// recognizer.js — $1 Unistroke Recognizer (Wobbrock et al.), no training data, no model.
// Rotation invariance is disabled on purpose: on a mirrored screen "V" and "^"
// should stay different spells.

const NUM_POINTS = 64;
const SQUARE = 250;
const ORIGIN = { x: 0, y: 0 };

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const pathLength = (pts) => {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
};

function resample(points, n = NUM_POINTS) {
  const total = pathLength(points);
  if (total < 1e-6) return new Array(n).fill({ ...points[0] });
  const interval = total / (n - 1);
  const out = [{ ...points[0] }];
  let acc = 0;
  let prev = points[0];
  for (let i = 1; i < points.length; i++) {
    let cur = points[i];
    let d = dist(prev, cur);
    while (acc + d >= interval) {
      const t = (interval - acc) / d;
      const nx = prev.x + t * (cur.x - prev.x);
      const ny = prev.y + t * (cur.y - prev.y);
      out.push({ x: nx, y: ny });
      prev = { x: nx, y: ny };
      acc = 0;
      d = dist(prev, cur);
    }
    acc += d;
    prev = cur;
  }
  while (out.length < n) out.push({ ...points[points.length - 1] });
  return out.slice(0, n);
}

function scaleToSquare(points, size = SQUARE) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const w = Math.max(1e-6, maxX - minX);
  const h = Math.max(1e-6, maxY - minY);
  return points.map((p) => ({ x: (p.x - minX) * (size / w), y: (p.y - minY) * (size / h) }));
}

function translateTo(points, pt = ORIGIN) {
  const cx = points[0].x, cy = points[0].y;
  return points.map((p) => ({ x: p.x - cx + pt.x, y: p.y - cy + pt.y }));
}

// half the diagonal of the normalized square — the worst possible average distance
const HALF_DIAGONAL = 0.5 * Math.SQRT2 * SQUARE;

const pathDistance = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += dist(a[i], b[i]);
  return d / a.length;
};

/** Preprocess: resample → scale (uniform-ish) → translate to origin. */
function normalize(points) {
  return translateTo(scaleToSquare(resample(points)), ORIGIN);
}

/** Polyline → dense point list, in screen coordinates (y down). */
export function polyline(...pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const steps = 14;
    for (let s = 0; s < steps; s++) {
      out.push({ x: ax + ((bx - ax) * s) / steps, y: ay + ((by - ay) * s) / steps });
    }
  }
  out.push({ x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] });
  return out;
}

export function ellipse(cx = 0.5, cy = 0.5, rx = 0.42, ry = 0.32, startAngle = -Math.PI / 2) {
  const out = [];
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const a = startAngle + (i / steps) * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

export const TEMPLATES = {
  // Z — lightning
  z: polyline([0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]),
  // ^ — fireball
  caret: polyline([0.12, 0.8], [0.5, 0.15], [0.88, 0.8]),
  // O — shield
  circle: ellipse(0.5, 0.5, 0.38, 0.38),
};

export class Recognizer {
  constructor(templates = TEMPLATES, { minScore = 0.66 } = {}) {
    this.minScore = minScore;
    this.templates = Object.entries(templates).map(([name, pts]) => ({ name, points: normalize(pts) }));
  }

  /** @returns {{name: string|null, score: number, scores: Record<string, number>}} */
  recognize(rawPoints) {
    const scores = {};
    if (!rawPoints || rawPoints.length < 4) return { name: null, score: 0, scores };

    // Two cheap tolerances so real hands don't fizzle on a correct glyph:
    //  · direction — a Z or a circle traced backwards is still the same spell
    //  · start point — a closed loop can begin anywhere, so the stroke is
    //    re-normalised from a few different starting indices and the best
    //    alignment wins (translation is relative to the first point, hence the
    //    re-normalise instead of shifting the normalised array).
    // Rotation / flip invariance stays OFF: V must never read as ^, and a
    // mirrored Z must not read as Z.
    const variants = [rawPoints, [...rawPoints].reverse()];
    const step = 2;                        // 64 resampled points → ~11° slices
    const candidates = [];
    for (const v of variants) {
      for (let k = 0; k < v.length; k += step) {
        candidates.push(normalize(k === 0 ? v : v.slice(k).concat(v.slice(0, k))));
      }
    }

    let best = { name: null, score: 0 };
    for (const t of this.templates) {
      let score = -1;
      for (const cand of candidates) {
        const s = 1 - pathDistance(cand, t.points) / HALF_DIAGONAL;
        if (s > score) score = s;
      }
      scores[t.name] = score;
      if (score > best.score) best = { name: t.name, score };
    }
    return {
      name: best.score >= this.minScore ? best.name : null,
      score: best.score,
      scores,
    };
  }
}
