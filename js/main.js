// main.js — wiring: camera → hand tracking → gestures → 3D scene.
import { createScene } from './scene.js';
import { createTracker, startCamera } from './tracker.js';

const $ = (sel) => document.querySelector(sel);

const video = $('#webcam');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const trashEl = $('#trash');
const statusChip = $('#status');
const veil = $('#veil');
const veilStatus = $('#veil-status');
const veilBarWrap = $('#veil-bar-wrap');
const veilBar = $('#veil-bar');
const help = $('#help');
const toastEl = $('#toast');
const perfEl = $('#perf');

const scene = createScene($('#three-root'));

// ── tunables ────────────────────────────────────────────────────
const DETECT_MS = 1000 / 30;      // target inference rate (fps)
const DETECT_MS_SLOW = 1000 / 22; // throttle on weak devices
const PINCH_IN = 0.45;            // thumb-index distance / hand size
const PINCH_OUT = 0.65;           // hysteresis so the pinch never flickers
const CREATE_GAP = 0.11;          // both pinch points must be this close (0-1 screen)
const GRAB_RADIUS = 1.5;          // world units
const PINCH_ARM_MS = 180;

// ── state ───────────────────────────────────────────────────────
const app = {
  mode: 'idle',           // idle | cam | pointer
  tracker: null,
  loading: false,
  hands: [],
  slots: new Map(),       // slot → { pinch, grab, smooth[] }
  creation: null,
  armed: true,
  armedAt: 0,
  shapeType: 'random',
  debug: false,
  trashRect: null,
  frameAvg: 16,
  lastDetect: 0,
};

// ── helpers ─────────────────────────────────────────────────────
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const distance2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
// lines up with the shape even on very wide or very tall screens.
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
  const x = ox + nx * dw;
  const y = oy + ny * dh;
  return { x: W - x, y }; // mirror
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
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  overlay.width = Math.round(window.innerWidth * dpr);
  overlay.height = Math.round(window.innerHeight * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawOverlay() {
  octx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (app.mode !== 'cam' || !app.hands.length) return;

  for (const hand of app.hands) {
    const pts = hand.smooth;
    octx.lineWidth = 2.4;
    octx.lineCap = 'round';
    octx.strokeStyle = hand.grab ? 'rgba(255,120,190,.9)' : 'rgba(36,240,255,.55)';
    octx.beginPath();
    for (const [a, b] of HAND_EDGES) {
      octx.moveTo(pts[a].x, pts[a].y);
      octx.lineTo(pts[b].x, pts[b].y);
    }
    octx.stroke();

    // fingertips
    octx.fillStyle = 'rgba(255,255,255,.85)';
    for (const i of [4, 8, 12, 16, 20]) {
      octx.beginPath();
      octx.arc(pts[i].x, pts[i].y, 2.6, 0, Math.PI * 2);
      octx.fill();
    }

    // pinch indicator
    const mid = { x: (pts[4].x + pts[8].x) / 2, y: (pts[4].y + pts[8].y) / 2 };
    const close = clamp(1 - (hand.ratio - 0.15) / 0.7, 0, 1);
    octx.beginPath();
    octx.arc(mid.x, mid.y, 8 + (1 - close) * 16, 0, Math.PI * 2);
    octx.strokeStyle = hand.pinch ? 'rgba(255,47,179,.95)' : 'rgba(36,240,255,.45)';
    octx.lineWidth = hand.pinch ? 3.4 : 2;
    octx.stroke();
    if (hand.pinch) {
      octx.beginPath();
      octx.arc(mid.x, mid.y, 4.5, 0, Math.PI * 2);
      octx.fillStyle = 'rgba(255,47,179,.95)';
      octx.fill();
    }
  }

  // link the two pinching hands while creating
  if (app.creation && app.hands.length >= 2) {
    const [a, b] = app.hands;
    octx.beginPath();
    octx.setLineDash([6, 8]);
    octx.moveTo(a.smooth[8].x, a.smooth[8].y);
    octx.lineTo(b.smooth[8].x, b.smooth[8].y);
    octx.strokeStyle = 'rgba(255,255,255,.4)';
    octx.lineWidth = 2;
    octx.stroke();
    octx.setLineDash([]);
  }
}

// ── hands → gesture state ───────────────────────────────────────
function readHands(result) {
  const lms = result.landmarks || [];
  const handed = result.handednesses || result.handedness || [];
  const out = [];

  lms.forEach((lm, i) => {
    const label = handed[i]?.[0]?.categoryName || (i === 0 ? 'Right' : 'Left');
    const slot = label === 'Left' ? 'L' : 'R';
    let state = app.slots.get(slot);
    if (!state) {
      state = { pinch: false, grab: null, smooth: null };
      app.slots.set(slot, state);
    }

    // raw pixel positions (mirrored)
    const px = lm.map((p) => videoToScreen(p.x, p.y));
    if (!state.smooth) state.smooth = px.map((p) => ({ ...p }));
    else for (let k = 0; k < 21; k++) {
      state.smooth[k].x += (px[k].x - state.smooth[k].x) * 0.55;
      state.smooth[k].y += (px[k].y - state.smooth[k].y) * 0.55;
    }

    const handSize = Math.max(1e-4, Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y, (lm[0].z || 0) - (lm[9].z || 0)));
    const gap = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y, (lm[4].z || 0) - (lm[8].z || 0));
    const ratio = gap / handSize;

    // hysteresis
    state.pinch = state.pinch ? ratio < PINCH_OUT : ratio < PINCH_IN;

    const mid = { x: (state.smooth[4].x + state.smooth[8].x) / 2, y: (state.smooth[4].y + state.smooth[8].y) / 2 };
    const world = scene.screenToWorld(mid.x / window.innerWidth, mid.y / window.innerHeight);

    out.push({
      slot, ratio, pinch: state.pinch, smooth: state.smooth, px: mid.x, py: mid.y, world,
      tip: { x: state.smooth[8].x, y: state.smooth[8].y },
    });
  });

  return out;
}

function handleGestures(now) {
  const hands = app.hands;
  const pinching = hands.filter((h) => h.pinch);

  // ── two-handed creation / scaling ─────────────────────────────
  if (app.creation) {
    const bySlot = new Map(hands.map((h) => [h.slot, h]));
    const a = bySlot.get(app.creation.slots[0]);
    const b = bySlot.get(app.creation.slots[1]);
    if (!a || !b || !a.pinch || !b.pinch) {
      finishCreation();
    } else {
      const d = Math.hypot(a.tip.x - b.tip.x, a.tip.y - b.tip.y) / Math.min(window.innerWidth, window.innerHeight);
      const shape = app.creation.shape;
      shape.scale = clamp((d / app.creation.baseGap) * app.creation.baseScale, 0.3, 3.4);
      shape.target.set((a.world.x + b.world.x) / 2, (a.world.y + b.world.y) / 2, 0);
    }
    releaseStaleHands(hands);
    return;
  }

  if (pinching.length >= 2 && app.armed && now > app.armedAt) {
    const [a, b] = pinching;
    const gap = Math.hypot(a.tip.x - b.tip.x, a.tip.y - b.tip.y) / Math.min(window.innerWidth, window.innerHeight);
    if (gap < CREATE_GAP) {
      startCreation(a, b, gap, now);
      releaseStaleHands(hands);
      return;
    }
  }

  // ── one-handed grab & drop (works per hand) ──────────────────
  for (const hand of hands) {
    const state = app.slots.get(hand.slot);

    if (hand.pinch) {
      if (!state.grab) {
        const near = scene.nearest(hand.world, GRAB_RADIUS);
        if (near && !near.held) {
          near.held = true;
          state.grab = near;
          scene.setHighlight(near, 2);
        }
      }
      if (state.grab) {
        state.grab.target.copy(hand.world);
        const isOverBin = overTrash(hand.px, hand.py);
        scene.setHighlight(state.grab, isOverBin ? 3 : 2);
        trashEl.classList.toggle('active', isOverBin);
      }
    } else if (state.grab) {
      const shape = state.grab;
      state.grab = null;
      shape.held = false;
      if (overTrash(hand.px, hand.py)) {
        scene.remove(shape);
        toast('Deleted');
      } else {
        scene.setHighlight(shape, 0);
      }
      trashEl.classList.remove('active');
    }
  }

  // hands that left the frame must let go of what they held
  releaseStaleHands(hands);
}

function startCreation(a, b, gap, now) {
  const midX = ((a.world.x + b.world.x) / 2);
  const midY = ((a.world.y + b.world.y) / 2);
  const nx = 0.5 + midX / scene.plane.w;
  const ny = 0.5 - midY / scene.plane.h;

  const shape = scene.spawn({ type: app.shapeType, nx, ny, scale: 1 });
  app.creation = { shape, slots: [a.slot, b.slot], baseGap: Math.max(gap, 0.02), baseScale: 1, startedAt: now };
  app.armed = false;
  trashEl.classList.remove('active');
}

function finishCreation() {
  const shape = app.creation?.shape;
  app.creation = null;
  app.armed = false;
  if (shape) {
    shape.scale = clamp(shape.scale, 0.35, 3.4);
    scene.setHighlight(shape, 0);
  }
}

function releaseStaleHands(present) {
  const live = new Set(present.map((h) => h.slot));
  for (const [slot, state] of app.slots) {
    if (!live.has(slot) && state.grab) {
      state.grab.held = false;
      scene.setHighlight(state.grab, 0);
      state.grab = null;
    }
    if (!live.has(slot)) state.pinch = false;
  }
  // re-arm creation only after every pinch has been released
  if (!present.some((h) => h.pinch) && !app.creation) {
    if (!app.armed) app.armedAt = performance.now() + PINCH_ARM_MS;
    app.armed = true;
  }
  if (![...app.slots.values()].some((s) => s.grab)) trashEl.classList.remove('active');
}

// ── main loop ───────────────────────────────────────────────────
let lastFrame = performance.now();
let perfAt = 0;

function loop(now) {
  requestAnimationFrame(loop);
  const dtRaw = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = clamp(dtRaw || 0.016, 0.001, 0.05);
  app.frameAvg = app.frameAvg * 0.9 + dtRaw * 1000 * 0.1;

  if (app.mode === 'cam' && app.tracker) {
    const interval = app.frameAvg > 30 ? DETECT_MS_SLOW : DETECT_MS;
    if (now - app.lastDetect >= interval) {
      app.lastDetect = now;
      const result = app.tracker.detect(video, now);
      if (result) {
        app.hands = readHands(result);
        handleGestures(now);
      }
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
    $('#perf-shapes').textContent = scene.shapes().length;
  }

}

// ── boot / camera ───────────────────────────────────────────────
function showVeil(text = 'Camera is off') {
  veil.hidden = false;
  veilStatus.textContent = text;
  veilStatus.classList.remove('error');
  veilBarWrap.hidden = true;
}

function hideVeil() { veil.hidden = true; }

async function startWithCamera() {
  if (app.loading) return;
  app.loading = true;
  $('#btn-start').disabled = true;
  veilStatus.textContent = 'Waiting for camera permission…';
  veilStatus.classList.remove('error');

  let tracker = null;
  try {
    // 1. Camera first — it is instant, so the user sees something immediately.
    await startCamera(video);
    app.mode = 'cam';
    document.body.classList.remove('no-camera');
    hideVeil();
    setStatus('loading model', 'loading');

    // 2. Then the hand model, with real progress in a small pill.
    showLoadPill('Downloading hand model — 0%');
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
    toast('Pinch both hands together, then pull apart', 3600);

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
      // camera is fine, only tracking failed — keep the app usable by pointer
      setStatus('no tracking', 'warn');
      toast('Hand tracking could not start — you can still drag with the mouse', 4200);
    }
  } finally {
    app.loading = false;
    $('#btn-start').disabled = false;
  }
}

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

function startWithoutCamera() {
  app.mode = 'pointer';
  document.body.classList.add('no-camera');
  hideVeil();
  setStatus('mouse mode', 'warn');
  toast('Drag to add, drop on the bin to delete', 3000);
}

// ── pointer fallback (touch / mouse / no webcam) ────────────────
let pointerGrab = null;

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
  $('#stage').setPointerCapture?.(ev.pointerId);
});

$('#stage').addEventListener('pointermove', (ev) => {
  if (!pointerGrab) return;
  const p = stagePoint(ev);
  pointerGrab.target.copy(p.world);
  const bin = overTrash(p.px, p.py);
  scene.setHighlight(pointerGrab, bin ? 3 : 2);
  trashEl.classList.toggle('active', bin);
});

function dropPointer(ev) {
  if (!pointerGrab) return;
  const p = stagePoint(ev);
  pointerGrab.held = false;
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
  if (!scene.shapes().length) return;
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

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
