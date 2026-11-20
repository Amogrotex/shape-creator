// main.js (Spell Caster) — camera → hand tracking → pinch-drawn glyphs → spells.
import { createGame } from './game.js';
import { createHandReader } from './hands.js';
import { Recognizer, TEMPLATES } from './recognizer.js';
import { createTracker, startCamera, preloadModel } from '../tracker.js';

const $ = (sel) => document.querySelector(sel);
const video = $('#webcam');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
const statusChip = $('#status');
const veil = $('#veil');
const veilStatus = $('#veil-status');
const over = $('#over');
const help = $('#help');
const toastEl = $('#toast');
const spellbook = $('#spellbook');
const heartsEl = $('#hearts');

const isMobile = (() => {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const ua = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const small = Math.min(window.screen?.width || 9999, window.screen?.height || 9999) < 820;
  return !!(coarse || ua || small);
})();

const game = createGame($('#three-root'), { onEvent: onGameEvent });
const reader = createHandReader(video);
const recognizer = new Recognizer(TEMPLATES, { minScore: 0.66 });

const SPELLS = {
  z: { label: 'Lightning', color: '36, 240, 255' },
  caret: { label: 'Fireball', color: '255, 210, 59' },
  circle: { label: 'Shield', color: '157, 255, 60' },
};

const G = {
  phase: 'idle',           // idle | countdown | playing | over
  mode: 'idle',            // idle | cam | pointer
  hp: 5, maxHp: 5,
  score: 0, wave: 0, combo: 1, comboTimer: 0, betweenWaves: 1.2,
  stroke: [], penDown: false, penSource: null,
  lastSpell: null, fizzleTimer: 0,
  tracker: null, hands: [], loading: false,
  perfMode: localStorage.getItem('sc-perf') === '1',
  detectInterval: isMobile ? 1000 / 30 : 1000 / 60,
  frameAvg: 16, lastDetect: 0, lastRender: 0, qualityAt: 0,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function setStatus(text, state = 'idle') { statusChip.textContent = text; statusChip.dataset.state = state; }

let toastTimer = 0;
function toast(msg, ms = 1600, cls = '') {
  toastEl.textContent = msg;
  toastEl.className = 'show ' + cls;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = cls; }, ms);
}

// ── spellbook glyphs (drawn from the same templates the recogniser uses) ──
document.querySelectorAll('canvas[data-glyph]').forEach((cv) => {
  const pts = TEMPLATES[cv.dataset.glyph];
  if (!pts) return;
  const ctx = cv.getContext('2d');
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 8;
  const w = cv.width - pad * 2, h = cv.height - pad * 2;
  ctx.strokeStyle = getComputedStyle(cv).color || '#9aa4bd';
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = pad + ((p.x - minX) / (maxX - minX || 1)) * w;
    const y = pad + ((p.y - minY) / (maxY - minY || 1)) * h;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
});

// ── HUD ─────────────────────────────────────────────────────────
const hearts = [];
for (let i = 0; i < G.maxHp; i++) {
  const d = document.createElement('div');
  d.className = 'heart';
  heartsEl.appendChild(d);
  hearts.push(d);
}

let hudCache = { score: -1, wave: -1, combo: -1, hp: -1 };
function updateHud() {
  if (hudCache.score !== G.score) { $('#score').textContent = G.score; hudCache.score = G.score; }
  if (hudCache.wave !== G.wave) { $('#wave').textContent = G.wave; hudCache.wave = G.wave; }
  const combo = Math.max(1, Math.floor(G.combo));
  if (hudCache.combo !== combo) {
    const el = $('#combo');
    el.textContent = `×${combo}`;
    el.classList.toggle('hot', combo > 1);
    hudCache.combo = combo;
  }
  if (hudCache.hp !== G.hp) {
    hearts.forEach((h, i) => h.classList.toggle('lost', i >= G.hp));
    hudCache.hp = G.hp;
  }
}

function flashSpell(name, ok = true) {
  spellbook.querySelectorAll('.spell').forEach((el) => {
    el.classList.remove('active', 'fizzle');
    if (name && el.dataset.spell === name) el.classList.add(ok ? 'active' : 'fizzle');
  });
  clearTimeout(G.fizzleTimer);
  G.fizzleTimer = setTimeout(() => {
    spellbook.querySelectorAll('.spell').forEach((el) => el.classList.remove('active', 'fizzle'));
  }, ok ? 420 : 320);
}

// ── game events ─────────────────────────────────────────────────
function onGameEvent(type, data = {}) {
  if (type === 'kill') {
    G.combo = Math.min(6, G.combo + 1);
    G.comboTimer = 3.2;
    G.score += 10 * Math.floor(G.combo);
    updateHud();
  } else if (type === 'coreHit') {
    if (data.hpLost) {
      G.hp = Math.max(0, G.hp - data.hpLost);
      document.body.classList.add('hurt');
      setTimeout(() => document.body.classList.remove('hurt'), 180);
      updateHud();
      if (G.hp <= 0) endGame();
    }
  }
}

// ── spells ──────────────────────────────────────────────────────
function nearestEnemyWorld() {
  let best = null, bestD = Infinity;
  const core = game.corePosition;
  for (const e of game.enemies) {
    const d = e.group.position.distanceTo(core);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best ? best.group.position.clone() : null;
}

function cast(name, origin) {
  if (G.phase !== 'playing') return;
  const from = game.screenToWorld(origin.x, origin.y);
  const target = nearestEnemyWorld();

  if (name === 'z') {
    if (!target) return fizzle('No target');
    game.lightning(from, target, { damage: 3, chain: 1 });
  } else if (name === 'caret') {
    game.fireball(from, target || game.defaultTarget);
  } else if (name === 'circle') {
    game.castShield(4);
  }
  G.lastSpell = name;
  flashSpell(name, true);
}

function fizzle(reason = 'Fizzled') {
  flashSpell(G.lastSpell, false);
  toast(reason, 900);
}

// ── stroke capture ──────────────────────────────────────────────
function penDownAt(pt) {
  G.penDown = true;
  G.stroke = [{ x: pt.x, y: pt.y }];
}

function penMoveTo(pt) {
  if (!G.penDown) return;
  const last = G.stroke[G.stroke.length - 1];
  if (!last || dist(last, pt) > 3) G.stroke.push({ x: pt.x, y: pt.y });
}

function penUp() {
  if (!G.penDown) return;
  G.penDown = false;
  const pts = G.stroke;
  G.stroke = [];
  G.lastStroke = pts;               // handy for debugging / the test suite
  if (pts.length < 5) return;

  // reject tiny scribbles: they would only annoy the recogniser
  let len = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) len += dist(pts[i - 1], pts[i]);
    minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
    minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
  }
  const glyphSize = Math.max(maxX - minX, maxY - minY);
  if (len < 60 || glyphSize < Math.min(window.innerWidth, window.innerHeight) * 0.14) {
    fizzle('Draw it bigger');
    return;
  }

  const res = recognizer.recognize(pts.map((p) => ({ x: p.x / window.innerWidth, y: p.y / window.innerHeight })));
  const end = pts[pts.length - 1];
  if (res.name) {
    toast(`${SPELLS[res.name].label} · ${Math.round(res.score * 100)}%`, 950);
    cast(res.name, end);
  } else {
    fizzle(`Fizzled · ${Math.round(res.score * 100)}%`);
  }
}

function handleHandDrawing(hands) {
  const pinching = hands.find((h) => h.pinch);
  if (pinching) {
    if (!G.penDown) penDownAt(pinching.pinchPt);
    else penMoveTo(pinching.pinchPt);
  } else if (G.penDown) {
    penUp();
  }
}

// ── overlay (skeleton + glyph trail) ────────────────────────────
const HAND_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

function sizeOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, isMobile || G.perfMode ? 1 : 1.25);
  overlay.width = Math.round(window.innerWidth * dpr);
  overlay.height = Math.round(window.innerHeight * dpr);
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawOverlay() {
  const W = window.innerWidth, H = window.innerHeight;
  octx.clearRect(0, 0, W, H);

  if (G.mode === 'cam') {
    for (const hand of G.hands) {
      const p = hand.pts;
      octx.lineCap = 'round';
      octx.lineWidth = 2.2;
      octx.strokeStyle = hand.pinch ? 'rgba(255,47,179,.85)' : 'rgba(36,240,255,.4)';
      octx.beginPath();
      for (const [a, b] of HAND_EDGES) {
        octx.moveTo(p[a * 2], p[a * 2 + 1]);
        octx.lineTo(p[b * 2], p[b * 2 + 1]);
      }
      octx.stroke();

      // the "wand" tip
      octx.beginPath();
      octx.arc(hand.pinchPt.x, hand.pinchPt.y, hand.pinch ? 7 : 4, 0, Math.PI * 2);
      octx.fillStyle = hand.pinch ? 'rgba(255,47,179,.95)' : 'rgba(36,240,255,.5)';
      octx.fill();
    }
  }

  // live glyph
  if (G.stroke.length > 2) {
    const color = G.lastSpell ? SPELLS[G.lastSpell].color : '255, 255, 255';
    octx.lineJoin = 'round';
    octx.lineCap = 'round';
    octx.beginPath();
    G.stroke.forEach((pt, i) => (i ? octx.lineTo(pt.x, pt.y) : octx.moveTo(pt.x, pt.y)));
    octx.strokeStyle = `rgba(${G.mode === 'cam' && G.hands.some((h) => h.pinch) ? color : '255,255,255'}, .22)`;
    octx.lineWidth = 16;
    octx.stroke();
    octx.strokeStyle = 'rgba(255,255,255,.92)';
    octx.lineWidth = 3.4;
    octx.stroke();
  }
}

// ── main loop ───────────────────────────────────────────────────
let lastFrame = performance.now();

function loop(now) {
  requestAnimationFrame(loop);
  if (now - G.lastRender < 15) return;
  G.lastRender = now;

  const dtRaw = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = clamp(dtRaw || 0.016, 0.001, 0.05);
  G.frameAvg = G.frameAvg * 0.92 + dtRaw * 1000 * 0.08;

  if (G.mode === 'cam' && G.tracker) {
    if (now - G.lastDetect >= G.detectInterval) {
      G.lastDetect = now;
      const result = G.tracker.detect(video, now);
      if (result) reader.ingest(result, now);
    }
    G.hands = reader.hands(now, G.detectInterval);
    if (G.phase === 'playing') handleHandDrawing(G.hands);
    else if (G.penDown) { G.penDown = false; G.stroke = []; }

    if (now - G.qualityAt > 900) {
      G.qualityAt = now;
      const base = isMobile ? 1000 / 30 : 1000 / 60;
      G.detectInterval = G.perfMode ? 1000 / 22 : G.frameAvg > 28 ? base * 1.5 : base;
    }
  }

  if (G.phase === 'waiting' && G.hands.length && G.mode === 'cam') startGame();

  if (G.phase === 'playing') {
    if (game.enemyCount === 0) {
      G.betweenWaves -= dt;
      if (G.betweenWaves <= 0) startWave();
    } else {
      G.betweenWaves = 2.2;
    }
    if (G.comboTimer > 0) {
      G.comboTimer -= dt;
      if (G.comboTimer <= 0) { G.combo = 1; updateHud(); }
    }
  }

  game.update(dt);
  game.render();
  drawOverlay();
}

// ── flow ────────────────────────────────────────────────────────
function startWave() {
  G.wave += 1;
  game.spawnWave(Math.min(9, 2 + G.wave), G.wave);
  G.betweenWaves = 2.2;
  toast(`Wave ${G.wave}`, 1100);
  updateHud();
}

function startGame() {
  game.reset();
  G.phase = 'playing';
  G.hp = G.maxHp;
  G.score = 0;
  G.wave = 0;
  G.combo = 1;
  G.comboTimer = 0;
  G.betweenWaves = 1.0;
  G.stroke = [];
  G.penDown = false;
  over.hidden = true;
  updateHud();
  setStatus('live', 'live');
  startWave();
}

function endGame() {
  G.phase = 'over';
  G.penDown = false;
  G.stroke = [];
  game.clearEnemies();
  $('#over-title').textContent = 'The crystal shattered';
  $('#over-lede').textContent = `Score ${G.score} · reached wave ${G.wave}`;
  over.hidden = false;
  setStatus('game over', 'warn');
}

function hideVeil() { veil.hidden = true; }

let pillTimer = 0;
function showLoadPill(text) {
  const pill = $('#loadpill');
  pill.hidden = false;
  $('#loadtext').textContent = text;
  $('#loadbar').style.width = text.includes('%') ? text.split('— ')[1] : '100%';
  clearTimeout(pillTimer);
  if (text.includes('ready')) pillTimer = setTimeout(() => { pill.hidden = true; }, 1400);
}
function hideLoadPill() { clearTimeout(pillTimer); $('#loadpill').hidden = true; }

async function startWithCamera() {
  if (G.loading) return;
  G.loading = true;
  $('#btn-start').disabled = true;
  veilStatus.textContent = 'Waiting for camera permission…';
  veilStatus.classList.remove('error');

  try {
    await startCamera(video, isMobile ? { width: 480, height: 360, fps: 30 } : { width: 640, height: 480, fps: 60 });
    G.mode = 'cam';
    document.body.classList.remove('no-camera');
    hideVeil();
    setStatus('loading model', 'loading');
    showLoadPill('Preparing hand model — 0%');

    G.tracker = await createTracker({
      inputWidth: isMobile ? 320 : 448,
      onProgress: (p, meta) => {
        if (p >= 1) { showLoadPill(meta?.cached ? 'Hand model ready (cached)' : 'Hand model ready'); return; }
        showLoadPill(`Downloading hand model — ${Math.round(p * 100)}%`);
      },
      onStage: (stage) => {
        if (stage === 'wasm') showLoadPill('Starting the vision engine…');
        if (stage === 'warmup') showLoadPill('Warming up hand tracking…');
      },
    });

    hideLoadPill();
    G.phase = 'waiting';
    setStatus('show your hand', 'loading');
    toast('Hold your hand up to begin', 3000);
  } catch (err) {
    console.error(err);
    G.mode = 'idle';
    veil.hidden = false;
    $('#btn-start').disabled = false;
    veilStatus.classList.add('error');
    veilStatus.textContent = err?.name === 'NotAllowedError'
      ? 'Camera permission was blocked. Allow it, or try with the mouse.'
      : err?.message || 'Could not start the camera.';
    setStatus('camera blocked', 'warn');
  } finally {
    G.loading = false;
    $('#btn-start').disabled = false;
  }
}

function startWithMouse() {
  G.mode = 'pointer';
  document.body.classList.add('no-camera');
  hideVeil();
  startGame();
  toast('Drag to draw a glyph', 2400);
}

// ── mouse / touch drawing ───────────────────────────────────────
const stage = $('#stage');
stage.addEventListener('pointerdown', (ev) => {
  if (G.mode === 'cam' && G.tracker) return;
  if (G.mode === 'idle') startWithMouse();
  penDownAt({ x: ev.clientX, y: ev.clientY });
  stage.setPointerCapture?.(ev.pointerId);
});
stage.addEventListener('pointermove', (ev) => {
  if (G.mode === 'cam' && G.tracker) return;
  penMoveTo({ x: ev.clientX, y: ev.clientY });
});
stage.addEventListener('pointerup', () => { if (!(G.mode === 'cam' && G.tracker)) penUp(); });
stage.addEventListener('pointercancel', () => { if (!(G.mode === 'cam' && G.tracker)) penUp(); });

// ── UI ──────────────────────────────────────────────────────────
$('#btn-start').addEventListener('click', startWithCamera);
$('#btn-mouse').addEventListener('click', startWithMouse);
$('#btn-again').addEventListener('click', () => startGame());

function openHelp() { help.hidden = false; }
function closeHelp() { help.hidden = true; }
$('#btn-help').addEventListener('click', openHelp);
$('#btn-help-close').addEventListener('click', closeHelp);
help.addEventListener('click', (e) => { if (e.target === help) closeHelp(); });

$('#btn-full').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

$('#btn-perf').addEventListener('click', () => {
  G.perfMode = !G.perfMode;
  game.setQuality(G.perfMode ? 'low' : 'auto');
  sizeOverlay();
  $('#btn-perf').classList.toggle('on', G.perfMode);
  $('#btn-perf').title = G.perfMode ? 'Performance mode: on' : 'Performance mode: off';
  localStorage.setItem('sc-perf', G.perfMode ? '1' : '0');
  toast(G.perfMode ? 'Performance mode on' : 'Quality mode on', 1200);
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  const k = e.key.toLowerCase();
  if (k === 'h') (help.hidden ? openHelp() : closeHelp());
  else if (k === 'r') startGame();
  else if (k === 'f') $('#btn-full').click();
  else if (k === 'p') $('#btn-perf').click();
  else if (k === 'escape') closeHelp();
});

window.addEventListener('resize', () => {
  game.resize();
  sizeOverlay();
});

// ── boot ────────────────────────────────────────────────────────
sizeOverlay();
updateHud();
if (G.perfMode) { $('#btn-perf').classList.add('on'); game.setQuality('low'); }
requestAnimationFrame(loop);
window.__spell = { game, G, reader, recognizer, cast, startGame, endGame };

setTimeout(() => { preloadModel(); }, 2500);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
