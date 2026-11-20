// main.js — wiring: camera → hand tracking → gestures → 3D scene.
//
// Smoothness stack:
//   1. One Euro filters on all 21 landmarks  (low latency when fast, calm when still)
//   2. velocity extrapolation between inferences → gestures run every render frame
//   3. time-based damping everywhere (frame-rate independent)
//   4. adaptive inference rate (60 / 30 / 22 fps depending on headroom)
import { createScene } from './scene.js';
import { createTracker, startCamera, preloadModel } from './tracker.js';

const $ = (sel) => document.querySelector(sel);

const video = $('#webcam');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const trashEl = $('#trash');
const statusChip = $('#status');
const veil = $('#veil');
const veilStatus = $('#veil-status');
const help = $('#help');
const toastEl = $('#toast');
const perfEl = $('#perf');
const buildHint = $('#buildhint');

const scene = createScene($('#three-root'));

// ── tunables ────────────────────────────────────────────────────
const INTERVAL = { fast: 1000 / 60, normal: 1000 / 30, slow: 1000 / 22 };
const PINCH_IN = 0.45;      // thumb↔index distance / palm size
const PINCH_OUT = 0.65;     // hysteresis
const OPEN_IN = 1.72;       // mean fingertip→wrist / palm size (full open hand)
const OPEN_OUT = 1.42;
const FIST = 1.18;          // below this the hand is closed → confirm build
const CREATE_GAP = 0.11;    // both pinch points this close (fraction of min viewport side)
const GRAB_RADIUS = 1.5;    // world units
const BUILD_DWELL = 110;    // ms an open palm must hold before build mode starts
const EXTRAPOLATE = 0.05;   // max seconds to look ahead

// ── One Euro filter (adaptive low-pass: fast when moving, smooth when still) ──
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
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alphaOf(cutoff, dt));
  }
}

// ── state ───────────────────────────────────────────────────────
const app = {
  mode: 'idle',           // idle | cam | pointer
  tracker: null,
  loading: false,
  hands: [],
  slots: new Map(),
  creation: null,
  build: null,
  armedCreate: true,
  armedBuild: true,
  armedGrab: true,
  shapeType: 'random',
  debug: false,
  trashRect: null,
  frameAvg: 16,
  lastDetect: 0,
  detectInterval: INTERVAL.normal,
  qualityAt: 0,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const smoothAngle = (prev, next, a) => {
  let d = next - prev;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return prev + a * d;
};

function setStatus(text, state = 'idle') {
  statusChip.textContent = text;
  statusChip.dataset.state = state;
}

let toastTimer = 0;
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// object-fit: cover + scaleX(-1) mapping, so a hand at the edge of the frame
// still lines up with the shape on very wide or very tall screens.
function videoToScreen(nx, ny, out) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const vw = video.videoWidth || 4;
  const vh = video.videoHeight || 3;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (W - dw) / 2;
  const oy = (H - dh) / 2;
  const x = ox + nx * dw;
  const y = oy + ny * dh;
  out.x = W - x;
  out.y = y;
  return out;
}
const tmpPoint = { x: 0, y: 0 };

function worldFromScreen(px, py) {
  return scene.screenToWorld(px / window.innerWidth, py / window.innerHeight);
}

function refreshTrashRect() {
  const r = trashEl.getBoundingClientRect();
  const pad = 18;
  app.trashRect = { x1: r.left - pad, y1: r.top - pad, x2: r.right + pad, y2: r.bottom + pad };
}

function overTrash(px, py) {
  const t = app.trashRect;
  if (!t) return false;
  return px >= t.x1 && px <= t.x2 && py >= t.y1 && py <= t.y2;
}

// ── overlay (hand skeleton) ─────────────────────────────────────
const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function sizeOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.25);
  overlay.width = Math.round(window.innerWidth * dpr);
  overlay.height = Math.round(window.innerHeight * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawOverlay() {
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (app.mode !== 'cam' || !app.hands.length) return;

  for (const hand of app.hands) {
    const p = hand.pts;
    octx.lineWidth = 2.4;
    octx.lineCap = 'round';
    octx.strokeStyle = hand.grabbing
      ? 'rgba(255,120,190,.9)'
      : hand.open ? 'rgba(150,255,180,.65)' : 'rgba(36,240,255,.55)';
    octx.beginPath();
    for (let e = 0; e < HAND_EDGES.length; e++) {
      const [a, b] = HAND_EDGES[e];
      octx.moveTo(p[a * 2], p[a * 2 + 1]);
      octx.lineTo(p[b * 2], p[b * 2 + 1]);
    }
    octx.stroke();

    // fingertips
    octx.fillStyle = 'rgba(255,255,255,.85)';
    for (let t = 0; t < 5; t++) {
      const i = [4, 8, 12, 16, 20][t];
      octx.beginPath();
      octx.arc(p[i * 2], p[i * 2 + 1], 2.6, 0, Math.PI * 2);
      octx.fill();
    }

    // pinch indicator
    const mx = (p[8] + p[16]) / 2;
    const my = (p[9] + p[17]) / 2;
    const close = clamp(1 - (hand.ratio - 0.15) / 0.7, 0, 1);
    octx.beginPath();
    octx.arc(mx, my, 8 + (1 - close) * 15, 0, Math.PI * 2);
    octx.strokeStyle = hand.pinch ? 'rgba(255,47,179,.95)' : 'rgba(36,240,255,.4)';
    octx.lineWidth = hand.pinch ? 3.4 : 2;
    octx.stroke();
    if (hand.pinch) {
      octx.beginPath();
      octx.arc(mx, my, 4.5, 0, Math.PI * 2);
      octx.fillStyle = 'rgba(255,47,179,.95)';
      octx.fill();
    }
  }

  // link the two pinching hands while creating
  if (app.creation && app.hands.length >= 2) {
    octx.beginPath();
    octx.setLineDash([6, 8]);
    octx.moveTo(app.hands[0].pinchPt.x, app.hands[0].pinchPt.y);
    octx.lineTo(app.hands[1].pinchPt.x, app.hands[1].pinchPt.y);
    octx.strokeStyle = 'rgba(255,255,255,.4)';
    octx.lineWidth = 2;
    octx.stroke();
    octx.setLineDash([]);
  }
}

// ── slots & filtering ───────────────────────────────────────────
function getSlot(slot) {
  let st = app.slots.get(slot);
  if (!st) {
    st = {
      fx: Array.from({ length: 21 }, () => new OneEuro()),
      fy: Array.from({ length: 21 }, () => new OneEuro()),
      pts: new Float32Array(42),
      out: new Float32Array(42),
      prev: new Float32Array(42),
      tPrev: 0, tCur: 0, tLast: -1e9,
      fresh: true,
      pinch: false, open: false, openness: 1, ratio: 1,
      openSince: 0,
      roll: 0, yaw: 0,
      grab: null, baseZ: 0, baseY: 0, grabRoll: 0, grabYaw: 0,
      rotRate: 0, lastRotZ: 0,
    };
    app.slots.set(slot, st);
  }
  return st;
}

/** Feed a MediaPipe result into the per-hand filters. */
function readHands(result, now) {
  const lms = result.landmarks || [];
  const handed = result.handednesses || result.handedness || [];
  const seen = new Set();

  lms.forEach((lm, i) => {
    const label = handed[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
    const slot = label === 'Left' ? 'L' : 'R';
    const st = getSlot(slot);
    const first = st.fresh;
    seen.add(slot);

    const dt = clamp((now - (st.tLast < 0 ? now - 16 : st.tLast)) / 1000, 0.004, 0.08);
    st.tLast = now;

    // rolling history for velocity extrapolation
    st.prev.set(st.pts);
    st.tPrev = st.tCur;
    st.tCur = now;

    for (let k = 0; k < 21; k++) {
      const p = videoToScreen(lm[k].x, lm[k].y, tmpPoint);
      st.pts[k * 2] = st.fx[k].filter(p.x, dt);
      st.pts[k * 2 + 1] = st.fy[k].filter(p.y, dt);
    }
    if (st.fresh) { st.prev.set(st.pts); st.tPrev = now - 16; st.fresh = false; }

    // scale-free metrics (normalised landmark space)
    const palm = Math.max(1e-4, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y, (lm[0].z || 0) - (lm[9].z || 0)));
    const gap = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y, (lm[4].z || 0) - (lm[8].z || 0));
    const ratio = gap / palm;

    const ext = (
      Math.hypot(lm[8].x - lm[0].x, lm[8].y - lm[0].y) +
      Math.hypot(lm[12].x - lm[0].x, lm[12].y - lm[0].y) +
      Math.hypot(lm[16].x - lm[0].x, lm[16].y - lm[0].y) +
      Math.hypot(lm[20].x - lm[0].x, lm[20].y - lm[0].y)
    ) / (4 * palm);
    st.openness = ext;

    st.ratio = ratio;
    st.pinch = st.pinch ? ratio < PINCH_OUT : ratio < PINCH_IN;
    const wasOpen = st.open;
    st.open = st.open ? ext > OPEN_OUT : ext > OPEN_IN;
    if (st.pinch) st.open = false;
    if (st.open && !wasOpen) st.openSince = now;

    // hand orientation in screen space (roll) and around the vertical axis (yaw)
    const rollRaw = Math.atan2(st.pts[19] - st.pts[1], st.pts[18] - st.pts[0]);
    st.roll = first ? rollRaw : smoothAngle(st.roll, rollRaw, 0.3);

    // true 3D twist: how far the palm is turned away from the camera
    const span = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y);
    if (span > 0.03) {
      const yawRaw = clamp(Math.atan2((lm[5].z || 0) - (lm[17].z || 0), span), -1.25, 1.25);
      st.yaw = first ? yawRaw : smoothAngle(st.yaw, yawRaw, 0.16);
    }
  });

  app.slots.forEach((st, slot) => {
    if (!seen.has(slot)) {
      st.pinch = false;
      st.open = false;
      if (now - st.tLast > 220) {
        st.fx.forEach((f) => f.reset());
        st.fy.forEach((f) => f.reset());
      }
    }
  });
}

/** Build the per-frame hand list, extrapolating between inferences. */
function updateHands(now) {
  const hands = [];

  app.slots.forEach((st, slot) => {
    if (now - st.tLast > 220) return;

    const span = Math.max(0.004, (st.tCur - st.tPrev) / 1000);
    const ahead = Math.min(Math.max(now - st.tCur, 0) / 1000, EXTRAPOLATE) * 0.55;
    const f = ahead / span;
    const out = st.out;
    for (let k = 0; k < 42; k++) {
      out[k] = st.pts[k] + (st.pts[k] - st.prev[k]) * f;
    }

    const palmX = (out[0] + out[10] + out[18] + out[26] + out[34]) / 5;   // joints 0,5,9,13,17
    const palmY = (out[1] + out[11] + out[19] + out[27] + out[35]) / 5;
    const pinchX = (out[8] + out[16]) / 2;                                 // thumb tip + index tip
    const pinchY = (out[9] + out[17]) / 2;

    hands.push({
      slot, st,
      pts: out,
      pinch: st.pinch,
      open: st.open,
      openness: st.openness,
      ratio: st.ratio ?? 1,
      roll: st.roll,
      yaw: st.yaw,
      palm: { x: palmX, y: palmY },
      pinchPt: { x: pinchX, y: pinchY },
      grabbing: !!st.grab,
    });
  });

  app.hands = hands;
  return hands;
}

// ── gestures ────────────────────────────────────────────────────
function handleGestures(now) {
  const hands = app.hands;

  if (app.creation) { stepCreation(hands, now); return; }
  if (app.build) { stepBuild(hands, now); return; }

  // ── two pinching hands close together → new shape ────────────
  const pinching = hands.filter((h) => h.pinch);
  if (pinching.length >= 2 && app.armedCreate) {
    const [a, b] = pinching;
    const gap = dist(a.pinchPt.x, a.pinchPt.y, b.pinchPt.x, b.pinchPt.y) / Math.min(window.innerWidth, window.innerHeight);
    if (gap < CREATE_GAP) { startCreation(a, b, gap); return; }
  }

  // ── fully open palm → build mode ─────────────────────────────
  if (app.armedBuild) {
    const opener = hands.find((h) => h.open && !h.st.grab && now - h.st.openSince > BUILD_DWELL);
    if (opener) { startBuild(opener); return; }
  }

  stepGrabs(hands, now);
}

function stepCreation(hands, now) {
  const c = app.creation;
  const bySlot = new Map(hands.map((h) => [h.slot, h]));
  const a = bySlot.get(c.slots[0]);
  const b = bySlot.get(c.slots[1]);

  if (!a || !b || !a.pinch || !b.pinch) { finishCreation(); return; }

  const gap = dist(a.pinchPt.x, a.pinchPt.y, b.pinchPt.x, b.pinchPt.y) / Math.min(window.innerWidth, window.innerHeight);
  const shape = c.shape;
  shape.scale = c.baseScale * clamp(gap / c.baseGap, 0.28, 3.4);

  const mx = (a.pinchPt.x + b.pinchPt.x) / 2;
  const my = (a.pinchPt.y + b.pinchPt.y) / 2;
  shape.target.copy(worldFromScreen(mx, my));

  // steering-wheel rotation between the two hands
  let ang = Math.atan2(b.pinchPt.y - a.pinchPt.y, b.pinchPt.x - a.pinchPt.x);
  let d = ang - c.lastAngle;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  c.lastAngle += d * 0.35;
  scene.setRotation(shape, c.lastAngle - c.baseAngle, 0);
}

function startCreation(a, b, gap) {
  app.armedGrab = false;
  const mx = (a.pinchPt.x + b.pinchPt.x) / 2;
  const my = (a.pinchPt.y + b.pinchPt.y) / 2;
  const shape = scene.spawn({
    type: app.shapeType,
    nx: mx / window.innerWidth,
    ny: my / window.innerHeight,
  });
  shape.scale = 0.6;
  const ang = Math.atan2(b.pinchPt.y - a.pinchPt.y, b.pinchPt.x - a.pinchPt.x);
  app.creation = {
    shape, slots: [a.slot, b.slot],
    baseGap: Math.max(gap, 0.02), baseScale: 0.6,
    baseAngle: ang, lastAngle: ang,
  };
  app.armedCreate = false;
  trashEl.classList.remove('active');
}

function finishCreation() {
  const shape = app.creation?.shape;
  app.creation = null;
  app.armedCreate = false;
  app.armedGrab = false;
  if (shape) shape.scale = clamp(shape.scale, 0.35, 3.4);
}

function startBuild(hand) {
  const ghost = scene.spawn({
    type: app.shapeType,
    nx: hand.palm.x / window.innerWidth,
    ny: hand.palm.y / window.innerHeight,
    ghost: true,
  });
  app.build = {
    ghost, slot: hand.slot,
    roll0: hand.roll, yaw0: hand.yaw,
    baseSep: 0, baseScale: 1, missing: 0,
  };
  app.armedBuild = false;
  buildHint.hidden = false;
  setStatus('build', 'build');
}

function stepBuild(hands, now) {
  const b = app.build;
  const builder = hands.find((h) => h.slot === b.slot);

  if (!builder) {
    b.missing += 1;
    if (b.missing > 15) cancelBuild();
    return;
  }
  b.missing = 0;

  // close the hand (pinch or fist) → place the shape
  if (builder.pinch || builder.openness < FIST) { commitBuild(); return; }

  let cx = builder.palm.x;
  let cy = builder.palm.y;
  let scale = b.baseScale;

  const second = hands.find((h) => h.slot !== b.slot && h.open);
  if (second) {
    const d = dist(builder.palm.x, builder.palm.y, second.palm.x, second.palm.y);
    if (!b.baseSep) { b.baseSep = Math.max(d, 60); b.baseScale = 1; }
    scale = clamp(d / b.baseSep, 0.45, 3.2);
    cx = (builder.palm.x + second.palm.x) / 2;
    cy = (builder.palm.y + second.palm.y) / 2;
  } else if (b.baseSep) {
    b.baseSep = 0;
    b.baseScale = b.ghost.scale;
  }

  const rotZ = builder.roll - b.roll0;
  const rotY = builder.yaw - b.yaw0;
  b.ghost.scale = scale;
  b.ghost.target.copy(worldFromScreen(cx, cy));
  scene.setRotation(b.ghost, rotZ, rotY);
  b.lastRotZ = rotZ;
}

function commitBuild() {
  const b = app.build;
  if (!b) return;
  scene.commitGhost(b.ghost, 0);
  app.build = null;
  app.armedBuild = false;
  buildHint.hidden = true;
  setStatus('live', 'live');
  toast('Shape placed — open your palm for the next one');
}

function cancelBuild() {
  const b = app.build;
  if (!b) return;
  scene.remove(b.ghost, false);
  app.build = null;
  buildHint.hidden = true;
  setStatus('live', 'live');
}

function stepGrabs(hands, now) {
  for (const hand of hands) {
    const st = hand.st;

    if (hand.pinch) {
      if (!st.grab && app.armedGrab) {
        const near = scene.nearest(worldFromScreen(hand.pinchPt.x, hand.pinchPt.y), GRAB_RADIUS);
        if (near && !near.held) {
          near.held = true;
          const rot = scene.getRotation(near);
          st.grab = near;
          st.baseZ = rot.z;
          st.baseY = rot.y;
          st.grabRoll = hand.roll;
          st.grabYaw = hand.yaw;
          st.lastRotZ = rot.z;
          st.rotRate = 0;
          scene.setHighlight(near, 2);
        }
      }
      if (st.grab) {
        st.grab.target.copy(worldFromScreen(hand.pinchPt.x, hand.pinchPt.y));
        const rotZ = st.baseZ + (hand.roll - st.grabRoll);
        const rotY = st.baseY + (hand.yaw - st.grabYaw);
        scene.setRotation(st.grab, rotZ, rotY);
        st.rotRate = st.rotRate * 0.85 + ((rotZ - st.lastRotZ) / Math.max(0.008, 1 / 60)) * 0.15;
        st.lastRotZ = rotZ;

        const isOverBin = overTrash(hand.pinchPt.x, hand.pinchPt.y);
        scene.setHighlight(st.grab, isOverBin ? 3 : 2);
        trashEl.classList.toggle('active', isOverBin);
      }
    } else if (st.grab) {
      const shape = st.grab;
      st.grab = null;
      shape.held = false;
      shape.spinVel = clamp(st.rotRate * 0.25, -2.4, 2.4);
      if (overTrash(hand.pinchPt.x, hand.pinchPt.y)) {
        scene.remove(shape);
        toast('Deleted');
      } else {
        scene.setHighlight(shape, 0);
      }
      trashEl.classList.remove('active');
    }
  }

  // hands that left the frame let go
  const live = new Set(hands.map((h) => h.slot));
  for (const [slot, st] of app.slots) {
    if (!live.has(slot) && st.grab) {
      st.grab.held = false;
      scene.setHighlight(st.grab, 0);
      st.grab = null;
    }
  }

  // re-arm the gestures once every hand is out of build/open/pinch pose
  if (!hands.some((h) => h.open || h.pinch)) {
    app.armedCreate = true;
    app.armedBuild = true;
    app.armedGrab = true;
  }
  if (![...app.slots.values()].some((s) => s.grab)) trashEl.classList.remove('active');
}

// ── pointer fallback (touch / mouse / no webcam) ────────────────
let pointerGrab = null;
let pointerSpin = 0;

function stagePoint(ev) {
  const nx = ev.clientX / window.innerWidth;
  const ny = ev.clientY / window.innerHeight;
  return { nx, ny, world: scene.screenToWorld(nx, ny), px: ev.clientX, py: ev.clientY };
}

$('#stage').addEventListener('pointerdown', (ev) => {
  if (app.mode === 'cam' && app.tracker) return; // gestures take over
  if (app.mode === 'idle') startWithoutCamera();
  const p = stagePoint(ev);
  const near = scene.nearest(p.world, 1.1);
  if (near) {
    near.held = true;
    scene.setHighlight(near, 2);
    pointerGrab = near;
  } else {
    const shape = scene.spawn({ type: app.shapeType, nx: p.nx, ny: p.ny });
    shape.grow = 0.35;
    shape.held = true;
    pointerGrab = shape;
  }
  pointerSpin = 0;
  $('#stage').setPointerCapture?.(ev.pointerId);
});

$('#stage').addEventListener('pointermove', (ev) => {
  if (!pointerGrab) return;
  const p = stagePoint(ev);
  const dx = p.world.x - pointerGrab.target.x;
  pointerGrab.target.copy(p.world);
  // horizontal motion adds a little spin, so shapes stay lively
  pointerSpin = pointerSpin * 0.9 + dx * 0.6;
  const bin = overTrash(p.px, p.py);
  scene.setHighlight(pointerGrab, bin ? 3 : 2);
  trashEl.classList.toggle('active', bin);
});

function dropPointer(ev) {
  if (!pointerGrab) return;
  const p = stagePoint(ev);
  pointerGrab.held = false;
  pointerGrab.spinVel = clamp(pointerSpin * 3, -3, 3);
  if (overTrash(p.px, p.py)) {
    scene.remove(pointerGrab);
    toast('Deleted');
  } else {
    scene.setHighlight(pointerGrab, 0);
  }
  pointerGrab = null;
  trashEl.classList.remove('active');
}
$('#stage').addEventListener('pointerup', dropPointer);
$('#stage').addEventListener('pointercancel', dropPointer);
$('#stage').addEventListener('pointerleave', dropPointer);

// ── main loop ───────────────────────────────────────────────────
let lastFrame = performance.now();
let perfAt = 0;
let qualityAt = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dtRaw = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = clamp(dtRaw || 0.016, 0.001, 0.05);
  app.frameAvg = app.frameAvg * 0.92 + dtRaw * 1000 * 0.08;

  if (app.mode === 'cam' && app.tracker) {
    if (now - app.lastDetect >= app.detectInterval) {
      app.lastDetect = now;
      const result = app.tracker.detect(video, now);
      if (result) readHands(result, now);
    }
    updateHands(now);
    handleGestures(now);

    if (now - qualityAt > 1200) {
      qualityAt = now;
      scene.autoQuality(app.frameAvg);
      app.detectInterval = app.frameAvg > 26 ? INTERVAL.slow
        : app.frameAvg > 17 ? INTERVAL.normal
          : INTERVAL.fast;
    }
  }

  scene.update(dt);
  scene.render();
  drawOverlay();

  const infRate = app.tracker ? app.tracker.stats(dt) : 0;

  if (app.debug && now - perfAt > 250) {
    perfAt = now;
    $('#perf-fps').textContent = Math.round(1000 / Math.max(app.frameAvg, 1));
    $('#perf-inf').textContent = Math.round(infRate);
    $('#perf-shapes').textContent = scene.shapes().filter((s) => !s.ghost).length;
    $('#perf-dpr').textContent = scene.dpr.toFixed(2);
  }
}

// ── boot / camera ───────────────────────────────────────────────
function hideVeil() { veil.hidden = true; }

let pillTimer = 0;
function showLoadPill(text) {
  const pill = $('#loadpill');
  pill.hidden = false;
  $('#loadtext').textContent = text;
  $('#loadbar').style.width = text.includes('%') ? text.split('— ')[1] : '100%';
  clearTimeout(pillTimer);
  if (text.includes('ready')) pillTimer = setTimeout(hideLoadPill, 1400);
}
function hideLoadPill() {
  clearTimeout(pillTimer);
  $('#loadpill').hidden = true;
}

async function startWithCamera() {
  if (app.loading) return;
  app.loading = true;
  $('#btn-start').disabled = true;
  veilStatus.textContent = 'Waiting for camera permission…';
  veilStatus.classList.remove('error');

  let tracker = null;
  try {
    // 1. Camera first — instant feedback.
    await startCamera(video);
    app.mode = 'cam';
    document.body.classList.remove('no-camera');
    hideVeil();
    setStatus('loading model', 'loading');

    // 2. Then the hand model, with real progress.
    showLoadPill('Preparing hand model — 0%');
    tracker = await createTracker({
      onProgress: (p, meta) => {
        if (p >= 1) {
          showLoadPill(meta?.cached ? 'Hand model ready (cached)' : 'Hand model ready');
          return;
        }
        showLoadPill(`Downloading hand model — ${Math.round(p * 100)}%`);
      },
      onStage: (stage) => {
        if (stage === 'wasm') showLoadPill('Starting the vision engine…');
        if (stage === 'warmup') showLoadPill('Warming up hand tracking…');
      },
    });

    app.tracker = tracker;
    hideLoadPill();
    setStatus('live', 'live');
    toast('Open your palm to build · pinch & twist to move', 4000);

    if (!localStorage.getItem('sc-seen')) {
      localStorage.setItem('sc-seen', '1');
      setTimeout(openHelp, 900);
    }
  } catch (err) {
    console.error(err);
    if (tracker) tracker.dispose();
    const cameraFailed = !video.srcObject || app.mode !== 'cam';
    app.mode = cameraFailed ? 'idle' : 'pointer';
    hideLoadPill();
    if (cameraFailed) {
      veil.hidden = false;
      veilStatus.classList.add('error');
      veilStatus.textContent = err?.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Allow it in your browser, or try without camera.'
        : err?.message || 'Something went wrong starting the camera.';
      setStatus('camera blocked', 'warn');
    } else {
      setStatus('no tracking', 'warn');
      toast('Hand tracking could not start — drag with the mouse instead', 4200);
    }
  } finally {
    app.loading = false;
    $('#btn-start').disabled = false;
  }
}

function startWithoutCamera() {
  app.mode = 'pointer';
  document.body.classList.add('no-camera');
  hideVeil();
  setStatus('mouse mode', 'warn');
  toast('Drag with the mouse — drop on the bin to delete', 3000);
}

// ── UI ──────────────────────────────────────────────────────────
$('#btn-start').addEventListener('click', startWithCamera);
$('#btn-mouse').addEventListener('click', startWithoutCamera);

function openHelp() { help.hidden = false; }
function closeHelp() { help.hidden = true; }
$('#btn-help').addEventListener('click', openHelp);
$('#btn-help-close').addEventListener('click', closeHelp);
help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });

$('#btn-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

$('#btn-clear').addEventListener('click', () => {
  if (!scene.shapes().some((s) => !s.ghost)) return;
  scene.clear();
  toast('Cleared');
});

$('#btn-cam').addEventListener('click', () => {
  if (app.tracker) { toast('Camera is already on'); return; }
  if (app.loading) { toast('Still starting…'); return; }
  startWithCamera();
});

$('#btn-add').addEventListener('click', () => {
  const s = scene.spawn({ type: app.shapeType, nx: 0.5, ny: 0.5 });
  s.grow = 0.3;
});

$('#shape-picker').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-type]');
  if (!btn) return;
  for (const b of $('#shape-picker').children) b.classList.toggle('on', b === btn);
  app.shapeType = btn.dataset.type;
  // live-update the ghost if we are already building
  if (app.build) {
    const ghost = app.build.ghost;
    scene.remove(ghost, false);
    app.build.ghost = scene.spawn({
      type: app.shapeType,
      nx: ghost.group.position.x / scene.plane.w + 0.5,
      ny: 0.5 - ghost.group.position.y / scene.plane.h,
      ghost: true,
    });
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'c') $('#btn-clear').click();
  else if (k === ' ') { e.preventDefault(); $('#btn-add').click(); }
  else if (k === 'f') $('#btn-full').click();
  else if (k === 'h') (help.hidden ? openHelp() : closeHelp());
  else if (k === 'd') { app.debug = !app.debug; perfEl.hidden = !app.debug; }
  else if (k === 'escape') closeHelp();
});

window.addEventListener('resize', () => {
  scene.resize();
  sizeOverlay();
  refreshTrashRect();
});

// ── go ──────────────────────────────────────────────────────────
sizeOverlay();
refreshTrashRect();
setTimeout(refreshTrashRect, 400);
requestAnimationFrame(loop);

// small debug hook (handy in the console, harmless in production)
window.__shapeCreator = { scene, app, video };

// Warm the model cache while the user is still reading, so "Start" feels instant.
setTimeout(() => { preloadModel(); }, 2500);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
