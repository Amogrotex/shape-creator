// scene.js — the 3D half of Shape Creator.
// Cheap by design: shared geometries, quaternion targets (no euler wrap),
// no per-frame allocations, no post-processing, adaptive resolution.

import * as THREE from 'three';

const PALETTE = [0xff2fb3, 0x24f0ff, 0xff5a3c, 0x9dff3c, 0xa06bff, 0xffd23b, 0x2effc8, 0x5b8bff];
export const SHAPE_TYPES = ['box', 'sphere', 'cone', 'torus', 'octa'];

const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
const easeInCubic = (t) => t * t * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createScene(root) {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: window.devicePixelRatio < 2,
    powerPreference: 'high-performance',
  });
  renderer.setClearAlpha(0);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
  root.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 60);
  const CAM_Z = 6.6;
  camera.position.set(0, 0, CAM_Z);

  // Shared geometry — created once, never per shape.
  const GEO = {
    box: new THREE.BoxGeometry(0.95, 0.95, 0.95),
    sphere: new THREE.SphereGeometry(0.58, 18, 12),
    cone: new THREE.ConeGeometry(0.52, 1.05, 22),
    torus: new THREE.TorusGeometry(0.46, 0.17, 12, 26),
    octa: new THREE.OctahedronGeometry(0.62, 0),
  };

  const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  /** @type {Array<any>} */
  let shapes = [];
  let colorIndex = 0;
  let planeW = 10, planeH = 6;
  let width = 1, height = 1;
  let clock = 0;

  const maxDPR = Math.min(window.devicePixelRatio || 1, 2);
  let dpr = maxDPR;

  function nextColor() {
    const c = PALETTE[colorIndex % PALETTE.length];
    colorIndex++;
    return c;
  }

  function resize() {
    width = root.clientWidth || window.innerWidth;
    height = root.clientHeight || window.innerHeight;
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const vFov = (camera.fov * Math.PI) / 180;
    planeH = 2 * Math.tan(vFov / 2) * CAM_Z;
    planeW = planeH * camera.aspect;
  }

  /** Drop render resolution when the GPU can't keep up; restore it when it can. */
  function autoQuality(frameMs) {
    let next = dpr;
    if (frameMs > 30) next = Math.max(1, dpr - 0.25);
    else if (frameMs < 13) next = Math.min(maxDPR, dpr + 0.25);
    if (Math.abs(next - dpr) > 0.01) {
      dpr = next;
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
    }
    return dpr;
  }

  /** Normalised screen (0..1) → world on the z=0 plane. */
  function screenToWorld(nx, ny) {
    return new THREE.Vector3((nx - 0.5) * planeW, (0.5 - ny) * planeH, 0);
  }

  /** World → pixel coordinates in the viewport. */
  function worldToScreen(vec) {
    const v = vec.clone().project(camera);
    return { x: (v.x + 1) * 0.5 * width, y: (1 - v.y) * 0.5 * height };
  }

  function spawn({ type = 'random', nx = 0.5, ny = 0.5, scale = 1, ghost = false } = {}) {
    const kind = type === 'random' ? SHAPE_TYPES[(Math.random() * SHAPE_TYPES.length) | 0] : type;
    const geo = GEO[kind] || GEO.box;
    const color = nextColor();

    const fillMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: ghost ? 0.07 : 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const wireMat = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: ghost ? 0.34 : 0.95,
    });

    const group = new THREE.Group();
    group.add(new THREE.Mesh(geo, fillMat));
    group.add(new THREE.Mesh(geo, wireMat));

    const world = screenToWorld(nx, ny);
    group.position.copy(world);
    group.scale.setScalar(0.001);

    const shape = {
      group, fillMat, wireMat, kind, color, ghost,
      grow: 0,
      scale: clamp(scale, 0.3, 3.4),
      dying: 0,
      held: false,
      removing: false,
      target: world.clone(),
      qTarget: new THREE.Quaternion(),
      spinVel: 0,
      seed: Math.random() * Math.PI * 2,
      spin: ghost ? 0 : 0.25 + Math.random() * 0.35,
    };

    scene.add(group);
    shapes.push(shape);
    return shape;
  }

  function remove(shape, animated = true) {
    if (!shape || shape.removing) return;
    shape.removing = true;
    shape.held = false;
    shape.ghost = false;
    if (!animated) finalize(shape);
  }

  function finalize(shape) {
    scene.remove(shape.group);
    shape.fillMat.dispose();
    shape.wireMat.dispose();
    shapes = shapes.filter((s) => s !== shape);
  }

  function clear() {
    shapes.forEach((s) => {
      if (s.ghost) return;
      s.dying = 0.9;
      s.removing = true;
    });
  }

  function setHighlight(shape, level) {
    if (shape.ghost) return;
    const alpha = level === 3 ? 0.34 : level === 2 ? 0.42 : level === 1 ? 0.3 : 0.24;
    shape.fillMat.opacity = alpha;
    const hex = level === 3 ? 0xff6b6b : shape.color;
    shape.wireMat.color.setHex(hex);
    shape.fillMat.color.setHex(hex);
  }

  /** Ghost → solid shape (used when the build gesture is confirmed). */
  function commitGhost(shape, spin = 0) {
    if (!shape) return;
    shape.ghost = false;
    shape.grow = 0.45;
    shape.spin = 0.25 + Math.random() * 0.35;
    shape.spinVel = clamp(spin, -2.6, 2.6);
    shape.fillMat.opacity = 0.24;
    shape.wireMat.opacity = 0.95;
  }

  function getRotation(shape) {
    tmpEuler.setFromQuaternion(shape.group.quaternion, 'YXZ');
    return { z: tmpEuler.z, y: tmpEuler.y };
  }

  function setRotation(shape, rotZ, rotY) {
    tmpEuler.set(0, rotY || 0, rotZ || 0, 'YXZ');
    shape.qTarget.setFromEuler(tmpEuler);
  }

  function nearest(worldPos, maxDist = 1.5) {
    let best = null, bestD = maxDist;
    for (const s of shapes) {
      if (s.removing || s.ghost) continue;
      const d = Math.hypot(s.group.position.x - worldPos.x, s.group.position.y - worldPos.y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  function update(dt) {
    clock += dt;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];

      if (s.removing) {
        s.dying = Math.min(1, s.dying + dt * 5);
        const k = 1 - easeInCubic(s.dying);
        s.group.scale.setScalar(Math.max(0.001, s.scale * s.grow * k));
        if (s.dying >= 1 || k < 0.02) finalize(s);
        continue;
      }

      // spawn pop
      if (s.grow < 1) {
        s.grow = Math.min(1, s.grow + dt * 4.2);
        s.group.scale.setScalar(Math.max(0.001, s.scale * easeOutBack(s.grow)));
      } else {
        const breathe = s.ghost || s.held ? 1 : 1 + Math.sin(clock * 1.6 + s.seed) * 0.012;
        const cur = s.group.scale.x;
        const want = s.scale * breathe;
        s.group.scale.setScalar(cur + (want - cur) * (1 - Math.pow(0.0005, dt)));
      }

      if (s.held || s.ghost) {
        // keep it on screen, then follow smoothly (kills jitter, no lag)
        const limX = planeW * 0.5 - 0.35;
        const limY = planeH * 0.5 - 0.35;
        s.target.x = clamp(s.target.x, -limX, limX);
        s.target.y = clamp(s.target.y, -limY, limY);
        const k = 1 - Math.pow(s.ghost ? 0.00005 : 0.0016, dt);
        s.group.position.lerp(s.target, k);
        s.group.quaternion.slerp(s.qTarget, 1 - Math.pow(0.0004, dt));
      } else {
        const spin = s.spin + s.spinVel;
        s.group.rotateY(spin * dt);
        s.group.rotateX(dt * s.spin * 0.18);
        s.spinVel *= Math.pow(0.16, dt); // momentum decays
      }
    }
    return shapes.length;
  }

  function render() { renderer.render(scene, camera); }

  resize();
  return {
    renderer, scene, camera,
    shapes: () => shapes,
    resize, autoQuality, screenToWorld, worldToScreen,
    spawn, remove, clear, commitGhost,
    setHighlight, setRotation, getRotation, nearest, update, render, CAM_Z,
    get dpr() { return dpr; },
    get plane() { return { w: planeW, h: planeH }; },
  };
}
