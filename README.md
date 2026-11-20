# Shape Creator — hand-gesture 3D playground

Open your hand to **build** a shape in mid-air, twist your palm to **rotate** it, pinch to place it, then drag shapes around with a pinch and drop them in the bin to delete. Just a browser and a webcam — no installs, no server, no video ever leaves the device.

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
| Hand motion | unsmoothed | **One Euro filter** on all 21 landmarks (low latency when fast, calm when still) + **velocity extrapolation** between inferences |
| Gesture rate | tied to the inference rate | gestures run **every render frame** on extrapolated hands, so motion is 60/120 fps smooth even when tracking runs at 30 |
| Rotation | none | **wrist roll** rotates a grabbed shape, **palm twist** rotates the build preview, two hands steer like a wheel; releasing flings a spin |
| Creating shapes | two-hand pinch only | **build mode**: open your palm → live ghost preview, twist to rotate, second open hand to resize, pinch to place |
| Renderer | full DPR, per-shape geometry | **DPR capped at 2 and auto-tuned from frame time**, one shared geometry per shape type, materials disposed on delete, quaternion targets (no euler pop) |
| GPU upload | video → canvas → model | GPU delegate reads the **video element directly** (no per-frame canvas copy); the CPU path still downscales |
| Model prefetch | only after pressing Start | warmed in the background on load (skipped on save-data / 2G), so Start is instant |
| Screen mapping | hard-coded `×10` scale, breaks on mobile/ultrawide | **projection-aware mapping** that accounts for `object-fit: cover` cropping, aspect ratio and mirroring |
| Gestures | two-hand create only | two-hand create + resize, **independent one-hand dragging for both hands**, trash drop, mouse/touch fallback |
| UI | none | onboarding card, live status chip, help sheet, shape picker, keyboard shortcuts, diagnostics (`D`) |
| Errors | silent black screen | explicit camera-permission / download errors with a "try without camera" path |

| Phone profile | same settings as desktop | **auto-detected**: DPR 1.5, no CSS filter on the video, no `backdrop-filter` blur, 60 fps render cap, lighter inference rate and a 320 px CPU input |
| Manual override | — | **⚡ Performance mode** in the top bar (or `P`): DPR 1, smaller model input, 24 fps inference |
| Render loop | one rAF callback = one render | **capped at 60 fps**, so 120 Hz phones do half the work instead of doubling the heat |

Roughly: **~45 % smaller payload on first load** (gzip/brotli CDN + 448 px input), far less CPU per frame, and a first visit that shows something useful in under a second.

## Gestures

- **Build mode** — open your whole hand: a ghost shape appears where your palm is.
  - twist your palm → **rotate** the shape in 3D
  - open your other hand and pull it away → **resize** (the shape sits between the two palms)
  - **pinch** (or close your hand) → **place** it
- **Quick create** — pinch both hands close together then pull them apart; the distance also sets the size, and turning your hands steers the rotation.
- **Move & rotate** — pinch near a shape with one hand, drag it and twist your wrist. Let go to fling a spin. Both hands can hold different shapes at once.
- **Delete** — drop a shape on the bin (bottom right) and let go.
- No webcam? Drag with the mouse or your finger — same rules.

Keyboard: `C` clear · `Space` add · `F` fullscreen · `D` diagnostics · `H` help · `Esc` close. The **Camera** button in the toolbar switches from mouse mode to hand tracking at any time.

## Smoothness & performance notes

- **One Euro filter** per landmark per axis (42 filters/hand). The cutoff adapts to speed: near-zero lag on fast movement, heavy smoothing when the hand is still — the classic answer to "jittery but laggy".
- **Velocity extrapolation**: the last two inferences give a velocity, and the hand position is projected up to 50 ms ahead (damped to 55 %), so shapes follow at the display refresh rate instead of stepping at 30 fps.
- **Adaptive inference**: 60 → 30 → 22 fps, chosen from a rolling frame-time average; `requestVideoFrameCallback`-style duplicate-frame skipping means the model never runs twice on the same camera frame.
- **Adaptive resolution**: pixel ratio drifts between 1 and device DPR based on measured frame time, so slow GPUs keep their frame rate.
- **No per-frame allocations** in the hot path: flat `Float32Array` landmarks, reused buffers, shared geometries, quaternion slerp instead of euler lerp.
- **Momented rotation**: releasing a twisted shape keeps the angular velocity (decays exponentially) — it feels physical for free.

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

## On a phone

Phones were the hardest case, and most of the lag was **not** the hand tracking at all — it was the browser compositing the page:

- a CSS `filter` on the full-screen `<video>` forces a per-frame GPU pass, and
- `backdrop-filter: blur()` on every HUD panel re-blurs a region that changes every frame.

Both are switched off on coarse-pointer / narrow screens, which alone is often a double-digit fps gain. On top of that the mobile profile lowers the pixel ratio to 1.5, caps rendering at 60 fps (ProMotion screens were rendering at 120), runs inference at 30/24/18 fps depending on headroom, and keeps the CPU fallback input at 320 px.

If your device still struggles, tap **⚡** (or press `P`): pixel ratio 1, 256 px input, 24 fps inference. The choice is remembered.

## Privacy

The webcam stream is used locally by MediaPipe and never uploaded. The only network requests are three.js, the MediaPipe runtime and the hand model, all from public CDNs.

## Credits

- Original concept and demo: [collidingScopes / Shape Creator tutorial](https://github.com/collidingScopes/shape-creator-tutorial) ([@measure_plan](https://x.com/measure_plan), [funwithcomputervision.com](https://www.funwithcomputervision.com/)).
- [MediaPipe Hand Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) · [three.js](https://threejs.org/).

MIT licensed — see [LICENSE](LICENSE).
