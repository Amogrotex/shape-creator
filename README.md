# Shape Creator — hand-gesture 3D playground

Pinch your fingers in the air to **create** 3D shapes, pull them **bigger**, **drag** them around and drop them in the bin to **delete** them. Just a browser and a webcam — no installs, no server, no video ever leaves the device.

A faster, lighter, rewritten take on the classic [Shape Creator demo](https://collidingscopes.github.io/shape-creator-tutorial/) by [@collidingScopes](https://x.com/measure_plan) — same idea, modern stack and a lot less jank.

**Live:** https://amogrotex.github.io/shape-creator/

![Shape Creator preview](preview.png)

---

## What was wrong before

The original ran the **legacy `@mediapipe/hands`** solution: 1280×720 frames pushed straight into a CPU-bound model, a 3D renderer with no pixel-ratio cap, new geometry + materials allocated for every shape (never disposed), and a blocking load with no feedback. Result: slow first paint, heavy CPU, and half a second of lag between your hand and the shape.

## What changed

| | before | now |
|---|---|---|
| Hand tracking | legacy `@mediapipe/hands`, CPU | **`@mediapipe/tasks-vision` HandLandmarker**, GPU delegate (CPU fallback) |
| Frame sent to the model | 1280×720 | **448 px wide downscale** — ~8× fewer pixels, same accuracy |
| Inference rate | every camera frame, unthrottled | **capped at 30 fps**, auto-throttled to 22 fps on weak devices, skips duplicate video frames |
| Model download | hidden inside the old client, no feedback | **streamed with a real progress bar**, stored in CacheStorage → instant on the second visit |
| Repeat visits | re-download everything | **service worker** caches the shell + three.js + MediaPipe wasm + model (works offline) |
| Startup | blank until everything is ready | camera opens immediately, **3D scene is interactive before the model finishes loading** |
| Pinch detection | raw thumb–index distance, hard threshold | distance **normalised by hand size** (holds at any distance from the camera) + hysteresis, so it never flickers |
| Hand motion | unsmoothed | exponential smoothing on all 21 landmarks → no jitter, no added lag |
| Renderer | full DPR, per-shape geometry | **DPR capped at 2**, one shared geometry per shape type, materials disposed on delete |
| Screen mapping | hard-coded `×10` scale, breaks on mobile/ultrawide | **projection-aware mapping** that accounts for `object-fit: cover` cropping, aspect ratio and mirroring |
| Gestures | two-hand create only | two-hand create + resize, **independent one-hand dragging for both hands**, trash drop, mouse/touch fallback |
| UI | none | onboarding card, live status chip, help sheet, shape picker, keyboard shortcuts, diagnostics (`D`) |
| Errors | silent black screen | explicit camera-permission / download errors with a "try without camera" path |

Roughly: **~45 % smaller payload on first load** (gzip/brotli CDN + 448 px input), far less CPU per frame, and a first visit that shows something useful in under a second.

## Gestures

- **Create** — pinch both hands (thumb + index) close together, then pull them apart.
- **Resize** — keep both pinches and change the distance between your hands.
- **Move** — pinch near a shape with one hand and drag it. (Both hands can hold a shape at once.)
- **Delete** — drop a shape on the bin (bottom right).
- No webcam? Drag with the mouse or your finger — same rules.

Keyboard: `C` clear · `Space` add · `F` fullscreen · `D` diagnostics · `H` help · `Esc` close. The **Camera** button in the toolbar switches from mouse mode to hand tracking at any time.

## Run locally

Any static server works — camera access needs `https://` or `localhost`:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

```
index.html              shell, import map, HUD
styles.css              glass UI, layers, responsive layout
js/main.js              camera bootstrap, gesture state machine, input, overlay
js/scene.js             three.js scene, shared geometry pool, shape lifecycle
js/tracker.js           MediaPipe HandLandmarker, cached model download, camera
sw.js                   service worker (cache-first CDN, stale-while-revalidate shell)
manifest.webmanifest    installable PWA
```

Everything is a plain ES module — no build step, no dependencies in the repo.

## Privacy

The webcam stream is used locally by MediaPipe and never uploaded. The only network requests are three.js, the MediaPipe runtime and the hand model, all from public CDNs.

## Credits

- Original concept and demo: [collidingScopes / Shape Creator tutorial](https://github.com/collidingScopes/shape-creator-tutorial) ([@measure_plan](https://x.com/measure_plan), [funwithcomputervision.com](https://www.funwithcomputervision.com/)).
- [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) · [three.js](https://threejs.org/).

MIT licensed — see [LICENSE](LICENSE).
