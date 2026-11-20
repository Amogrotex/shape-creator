// game.js — the 3D half of Spell Caster: crystal core, wisps closing in,
// lightning / fireball / shield effects and a tiny particle pool.
import * as THREE from 'three';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);

const CYAN = 0x24f0ff;
const MAGENTA = 0xff2fb3;
const GOLD = 0xffd23b;
const ORANGE = 0xff6b2f;

export function createGame(root, { onEvent = () => {} } = {}) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearAlpha(0);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 60);
  const CAM_Z = 6.6;
  camera.position.set(0, 0, CAM_Z);

  let width = 1, height = 1;
  let planeW = 10, planeH = 6;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let clock = 0;
  let shake = 0;

  // ── player core ────────────────────────────────────────────────
  // soft round sprite used for every point cloud (cheaper + prettier than squares)
  const dotTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g2 = c.getContext('2d');
    const grd = g2.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = grd;
    g2.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  const core = new THREE.Group();
  const coreShell = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.7, 0),
    new THREE.MeshBasicMaterial({ color: CYAN, wireframe: true, transparent: true, opacity: 0.95 })
  );
  const coreOuter = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.05, 0),
    new THREE.MeshBasicMaterial({ color: 0x7cf9ff, wireframe: true, transparent: true, opacity: 0.2, depthWrite: false })
  );
  const coreGlow = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.6, 1),
    new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  core.add(coreShell, coreOuter, coreGlow);

  // three flat orbit rings lying around the core
  const orbit = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const R = 1.62 + i * 0.38, seg = 72, arr = [];
    for (let s = 0; s <= seg; s++) {
      const a = (s / seg) * Math.PI * 2;
      arr.push(Math.cos(a) * R, Math.sin(a) * R * 0.34, -0.02 * i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    orbit.add(new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x3ce0ff, transparent: true, opacity: 0.34 - i * 0.14,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })));
  }
  core.add(orbit);
  scene.add(core);

  // low-poly shield bubble (an icosahedron reads as a bubble, not as spaghetti)
  const shieldMesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.32, 1),
    new THREE.MeshBasicMaterial({ color: 0x9dff3c, wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  const shieldFill = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.32, 1),
    new THREE.MeshBasicMaterial({ color: 0x9dff3c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  core.add(shieldMesh, shieldFill);

  // ── pools ──────────────────────────────────────────────────────
  const ENEMY_GEO = new THREE.IcosahedronGeometry(0.36, 0);
  const enemies = [];
  const bolts = [];
  const blasts = [];
  const fireballs = [];
  let shield = 0;          // seconds left
  let elapsed = 0;

  // particles (fixed pool, additive points)
  const P_MAX = 220;
  const pPos = new Float32Array(P_MAX * 3);
  const pCol = new Float32Array(P_MAX * 3);
  const pVel = new Float32Array(P_MAX * 3);
  const pLife = new Float32Array(P_MAX);
  let pCursor = 0;
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  for (let i = 0; i < P_MAX * 3; i += 3) pPos[i + 1] = 999; // park them off-screen
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.15, map: dotTex, vertexColors: true, transparent: true, opacity: 0.95,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  particles.frustumCulled = false;
  scene.add(particles);

  function burst(x, y, color, count = 14, power = 1.6) {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const idx = pCursor % P_MAX;
      pCursor++;
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.4, power);
      pPos[idx * 3] = x; pPos[idx * 3 + 1] = y; pPos[idx * 3 + 2] = 0.05;
      pVel[idx * 3] = Math.cos(a) * sp;
      pVel[idx * 3 + 1] = Math.sin(a) * sp;
      pVel[idx * 3 + 2] = rand(-0.4, 0.4);
      pCol[idx * 3] = c.r; pCol[idx * 3 + 1] = c.g; pCol[idx * 3 + 2] = c.b;
      pLife[idx] = rand(0.35, 0.8);
    }
  }

  // ── background stars ───────────────────────────────────────────
  {
    const N = 320, arr = new Float32Array(N * 3), col = new Float32Array(N * 3);
    const tint = new THREE.Color();
    for (let i = 0; i < N; i++) {
      arr[i * 3] = rand(-26, 26);
      arr[i * 3 + 1] = rand(-18, 18);
      arr[i * 3 + 2] = rand(-14, -1.5);
      tint.setHSL(rand(0.5, 0.72), 0.8, rand(0.55, 0.85));
      col[i * 3] = tint.r; col[i * 3 + 1] = tint.g; col[i * 3 + 2] = tint.b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.22, map: dotTex, vertexColors: true, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    stars.frustumCulled = false;
    scene.add(stars);
  }

  function resize() {
    width = root.clientWidth || window.innerWidth;
    height = root.clientHeight || window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const vFov = (camera.fov * Math.PI) / 180;
    planeH = 2 * Math.tan(vFov / 2) * CAM_Z;
    planeW = planeH * camera.aspect;
    core.position.set(0, -planeH * 0.11, 0);
  }

  function setQuality(mode) {
    renderer.setPixelRatio(mode === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
  }

  const screenToWorld = (px, py) => new THREE.Vector3(
    (px / width - 0.5) * planeW,
    (0.5 - py / height) * planeH,
    0
  );
  const worldToScreen = (v) => {
    const p = v.clone().project(camera);
    return { x: (p.x + 1) * 0.5 * width, y: (1 - p.y) * 0.5 * height };
  };

  // ── enemies ────────────────────────────────────────────────────
  function spawnEnemy({ hp = 2, speed = 0.42, scale = 1 } = {}) {
    const mat = new THREE.MeshBasicMaterial({ color: MAGENTA, wireframe: true, transparent: true, opacity: 0.95 });
    const fill = new THREE.MeshBasicMaterial({ color: MAGENTA, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(ENEMY_GEO, mat), new THREE.Mesh(ENEMY_GEO, fill));
    group.scale.setScalar(scale);

    const angle = Math.random() * Math.PI * 2;
    const rx = planeW * 0.46, ry = planeH * 0.4;
    group.position.set(core.position.x + Math.cos(angle) * rx, core.position.y + Math.sin(angle) * ry, 0);
    scene.add(group);

    const enemy = { group, mat, fill, hp, maxHp: hp, speed, wob: Math.random() * 6.28, scale };
    enemies.push(enemy);
    return enemy;
  }

  function spawnWave(n, difficulty = 1) {
    for (let i = 0; i < n; i++) {
      const tank = difficulty > 2 && i % 4 === 3;
      spawnEnemy({
        hp: tank ? 4 + Math.floor(difficulty) : 2 + Math.floor(difficulty / 3),
        speed: rand(0.3, 0.46) + difficulty * 0.03,
        scale: tank ? 1.5 : rand(0.85, 1.15),
      });
    }
  }

  function killEnemy(e, opts = {}) {
    const i = enemies.indexOf(e);
    if (i === -1) return;
    enemies.splice(i, 1);
    e.dead = true;
    burst(e.group.position.x, e.group.position.y, opts.color ?? MAGENTA, 16, 2.2);
    scene.remove(e.group);
    e.mat.dispose();
    e.fill.dispose();
    if (!opts.silent) onEvent('kill', { x: e.group.position.x, y: e.group.position.y });
  }

  // ── spells ─────────────────────────────────────────────────────
  // turns a polyline into a tapered triangle strip (a visible, glowing bolt)
  function ribbon(pts, w) {
    const n = pts.length;
    const pos = new Float32Array(n * 6);
    const idx = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const taper = Math.sin((i / (n - 1)) * Math.PI) * 0.65 + 0.35;
      const ox = -dy * w * taper, oy = dx * w * taper;
      pos[i * 6] = pts[i].x + ox; pos[i * 6 + 1] = pts[i].y + oy; pos[i * 6 + 2] = pts[i].z;
      pos[i * 6 + 3] = pts[i].x - ox; pos[i * 6 + 4] = pts[i].y - oy; pos[i * 6 + 5] = pts[i].z;
      if (i < n - 1) {
        const o = i * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  }

  function lightning(from, to, { damage = 3, chain = 1 } = {}) {
    const targets = enemies
      .map((e) => ({ e, d: e.group.position.distanceTo(to) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 1 + chain)
      .filter((t) => t.d < 2.2);

    let origin = from.clone();
    for (const t of targets) {
      // organic, fractal-ish wobble instead of a regular zig-zag
      const ax = origin.x, ay = origin.y;
      const bx = t.e.group.position.x, by = t.e.group.position.y;
      let nx = -(by - ay), ny = bx - ax;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      const len = Math.hypot(bx - ax, by - ay);
      const steps = 15;
      const amp = Math.min(0.75, len * 0.12);
      const pts = [];
      for (let s = 0; s <= steps; s++) {
        const k = s / steps;
        const env = Math.sin(Math.PI * k);          // pinned to both ends
        const jitter = (Math.random() * 2 - 1) * (s === 0 || s === steps ? 0 : 1);
        const off = jitter * amp * env;
        pts.push(new THREE.Vector3(ax + (bx - ax) * k + nx * off, ay + (by - ay) * k + ny * off, 0.1));
      }
      // ribbon meshes instead of lines: WebGL line width is capped at 1px on
      // almost every driver, ribbons give us a real, glowing bolt
      const group = new THREE.Group();
      const mats = [];
      for (const [w, op, col] of [[0.03, 0.34, 0x35e6ff], [0.009, 1, 0xf4ffff]]) {
        const geo = ribbon(pts, w);
        const mat = new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: op, side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending, depthWrite: false,
        });
        group.add(new THREE.Mesh(geo, mat));
        mats.push(mat);
      }
      scene.add(group);
      bolts.push({ group, mats, life: 0.42, max: 0.42 });
      burst(pts[steps].x, pts[steps].y, CYAN, 6, 0.8);
      origin = t.e.group.position.clone();
      hitEnemy(t.e, damage, { color: CYAN });
    }
    burst(from.x, from.y, CYAN, 10, 1.4);
  }

  function hitEnemy(e, damage, opts = {}) {
    e.hp -= damage;
    e.mat.color.setHex(0xffffff);
    setTimeout(() => { if (!e.dead) e.mat.color.setHex(MAGENTA); }, 90);
    if (e.hp <= 0) killEnemy(e, opts);
  }

  function fireball(from, targetPos, { damage = 6, radius = 1.5 } = {}) {
    const mesh = new THREE.Group();
    const coreMax = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.13, 1),
      new THREE.MeshBasicMaterial({ color: 0xfff6d0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    const halo = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.3, 1),
      new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    mesh.add(coreMax, halo);
    mesh.position.copy(from);
    scene.add(mesh);
    const dir = targetPos.clone().sub(from).normalize();
    fireballs.push({ mesh, vel: dir.multiplyScalar(6.5), life: 1.6, damage, radius });
  }

  function explode(pos, { damage = 6, radius = 1.5, color = GOLD } = {}) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.2, 26),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.position.copy(pos);
    ring.position.z = 0.05;
    scene.add(ring);
    blasts.push({ mesh: ring, life: 0.45, max: 0.45, radius });
    burst(pos.x, pos.y, color, 22, 3);
    for (const e of [...enemies]) {
      if (e.group.position.distanceTo(pos) <= radius) hitEnemy(e, damage, { color });
    }
  }

  function castShield(seconds = 4) {
    shield = Math.max(shield, seconds);
  }

  function damageCore() {
    if (shield > 0) {
      shield = Math.max(0, shield - 0.8);
      burst(core.position.x, core.position.y, 0x9dff3c, 18, 2.4);
      return false;
    }
    shake = 0.55;
    burst(core.position.x, core.position.y, 0xff4d4d, 24, 3);
    return true;
  }

  function clearEnemies() {
    for (const e of [...enemies]) {
      scene.remove(e.group);
      e.mat.dispose();
      e.fill.dispose();
    }
    enemies.length = 0;
  }

  // ── loop ───────────────────────────────────────────────────────
  function update(dt) {
    elapsed += dt;
    clock += dt;

    // core idle motion
    coreShell.rotation.y += dt * 0.9;
    coreShell.rotation.x += dt * 0.35;
    coreOuter.rotation.y -= dt * 0.35;
    coreOuter.rotation.z += dt * 0.18;
    coreGlow.scale.setScalar(1 + Math.sin(clock * 3) * 0.08);
    orbit.rotation.z += dt * 0.5;
    orbit.scale.setScalar(1 + Math.sin(clock * 1.6) * 0.03);
    // shield bubble
    const sh = shield > 0;
    shieldMesh.visible = sh;
    shieldFill.visible = sh;
    shieldMesh.material.opacity = sh ? 0.2 + Math.sin(clock * 9) * 0.07 : 0;
    shieldFill.material.opacity = sh ? 0.045 + Math.sin(clock * 9) * 0.02 : 0;
    shieldMesh.rotation.y += dt * (sh ? 0.8 : 0);
    shieldMesh.rotation.x += dt * (sh ? 0.3 : 0);
    shieldMesh.scale.setScalar(1 + Math.sin(clock * 5) * 0.02);
    if (shield > 0) shield = Math.max(0, shield - dt);

    // enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      const p = e.group.position;
      const dx = core.position.x - p.x;
      const dy = core.position.y - p.y;
      const d = Math.max(1e-4, Math.hypot(dx, dy));
      const wob = Math.sin(clock * 2 + e.wob) * 0.35;
      p.x += ((dx / d) * e.speed + (-dy / d) * wob * e.speed) * dt;
      p.y += ((dy / d) * e.speed + (dx / d) * wob * e.speed) * dt;
      e.group.rotation.x += dt * 1.4;
      e.group.rotation.y += dt * 1.1;
      const pulse = 1 + Math.sin(clock * 6 + e.wob) * 0.06;
      e.group.scale.setScalar(e.scale * pulse);

      if (d < 0.85) {
        const hurt = damageCore();
        killEnemy(e, { color: 0xff4d4d, silent: true });
        onEvent('coreHit', { hpLost: hurt ? 1 : 0 });
      }
    }

    // fireballs
    for (let i = fireballs.length - 1; i >= 0; i--) {
      const f = fireballs[i];
      f.mesh.position.addScaledVector(f.vel, dt);
      f.mesh.rotation.x += dt * 8;
      f.life -= dt;
      burst(f.mesh.position.x, f.mesh.position.y, ORANGE, 1, 0.4);
      const hitSomething = enemies.some((e) => e.group.position.distanceTo(f.mesh.position) < 0.42);
      if (hitSomething || f.life <= 0) {
        explode(f.mesh.position, { damage: f.damage, radius: f.radius });
        scene.remove(f.mesh);
        f.mesh.children.forEach((c) => { c.geometry.dispose(); c.material.dispose(); });
        fireballs.splice(i, 1);
      }
    }

    // bolts
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.life -= dt;
      const k = clamp(b.life / b.max, 0, 1);
      b.mats.forEach((m, j) => { m.opacity = Math.min(1, k * 1.6) * [0.34, 1][j]; });
      if (b.life <= 0) {
        scene.remove(b.group);
        b.group.children.forEach((m) => m.geometry.dispose());
        b.mats.forEach((m) => m.dispose());
        bolts.splice(i, 1);
      }
    }

    // blasts
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i];
      b.life -= dt;
      const k = 1 - b.life / b.max;
      b.mesh.scale.setScalar(0.6 + k * b.radius * 2.6);
      b.mesh.material.opacity = clamp(1 - k, 0, 1) * 0.95;
      if (b.life <= 0) {
        scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        blasts.splice(i, 1);
      }
    }

    // particles
    let dirty = false;
    for (let i = 0; i < P_MAX; i++) {
      if (pLife[i] <= 0) continue;
      pLife[i] -= dt;
      dirty = true;
      if (pLife[i] <= 0) { pPos[i * 3 + 1] = 999; continue; }
      pPos[i * 3] += pVel[i * 3] * dt;
      pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
      pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
      pVel[i * 3 + 1] -= dt * 1.6;
      const fade = clamp(pLife[i] * 1.6, 0, 1);
      pCol[i * 3] *= 0.985; pCol[i * 3 + 1] *= 0.985; pCol[i * 3 + 2] *= 0.985;
      if (fade < 0.2) pPos[i * 3 + 1] = 999;
    }
    if (dirty) {
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.color.needsUpdate = true;
    }

    // screen shake
    if (shake > 0) {
      shake = Math.max(0, shake - dt * 1.6);
      camera.position.x = rand(-1, 1) * shake * 0.12;
      camera.position.y = rand(-1, 1) * shake * 0.12;
    } else {
      camera.position.x *= 0.8;
      camera.position.y *= 0.8;
    }

    return enemies.length;
  }

  function render() { renderer.render(scene, camera); }

  function reset() {
    clearEnemies();
    fireballs.forEach((f) => scene.remove(f.mesh));
    fireballs.length = 0;
    bolts.forEach((b) => scene.remove(b.group));
    bolts.length = 0;
    blasts.forEach((b) => scene.remove(b.mesh));
    blasts.length = 0;
    for (let i = 0; i < P_MAX; i++) pLife[i] = 0;
    shield = 0;
    shake = 0;
  }

  resize();
  return {
    resize, setQuality, update, render, reset,
    spawnWave, clearEnemies, lightning, fireball, explode, castShield, damageCore,
    screenToWorld, worldToScreen,
    get enemies() { return enemies; },
    get enemyCount() { return enemies.length; },
    get shield() { return shield; },
    get corePosition() { return core.position; },
    /** where an aimed spell goes when there is nothing to hit */
    get defaultTarget() { return core.position.clone().setY(core.position.y + planeH * 0.42); },
    get plane() { return { w: planeW, h: planeH }; },
  };
}
