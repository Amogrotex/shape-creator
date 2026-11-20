// tracker.js — camera + MediaPipe HandLandmarker (tasks-vision, GPU delegate).
// Loaded lazily, cached in the Cache API, and fed downscaled frames so inference stays cheap.

export const VISION_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const WASM_PATH = `${VISION_BASE}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MODEL_BYTES_HINT = 7819105;
const CACHE_NAME = 'shape-creator-assets-v2';

/** Download the model with real progress, then keep it in CacheStorage for instant reloads. */
async function fetchModel(url, onProgress) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      onProgress(1, { cached: true });
      return new Uint8Array(await hit.arrayBuffer());
    }
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || MODEL_BYTES_HINT;
    const reader = res.body && res.body.getReader();

    if (!reader) {
      const buf = new Uint8Array(await res.arrayBuffer());
      onProgress(1, {});
      return buf;
    }

    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(Math.min(0.999, received / total), { received, total });
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }

    cache.put(url, new Response(bytes.slice().buffer, {
      headers: { 'content-type': 'application/octet-stream' },
    })).catch(() => {});
    onProgress(1, { cached: false });
    return bytes;
  } catch (err) {
    // Offline-ish fallback: plain fetch (browser HTTP cache still helps).
    const res = await fetch(url);
    if (!res.ok) throw err;
    const bytes = new Uint8Array(await res.arrayBuffer());
    onProgress(1, {});
    return bytes;
  }
}

export async function startCamera(video, { width = 640, height = 480 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser has no camera API (needs https or localhost).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: 'user',
      width: { ideal: width },
      height: { ideal: height },
      frameRate: { ideal: 30, max: 30 },
    },
  });
  video.srcObject = stream;
  await video.play().catch(() => {});
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      const done = () => { video.removeEventListener('loadeddata', done); resolve(); };
      video.addEventListener('loadeddata', done, { once: true });
    });
  }
  return stream;
}

export async function createTracker({ onProgress = () => {}, onStage = () => {}, inputWidth = 448 } = {}) {
  onStage('engine');
  const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');

  let modelAssetBuffer;
  try {
    modelAssetBuffer = await fetchModel(MODEL_URL, (p, meta) => onProgress(p, meta));
  } catch (err) {
    throw new Error('Could not download the hand model. Check your connection and reload.');
  }

  onStage('wasm');
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

  const options = (delegate) => ({
    baseOptions: { modelAssetBuffer, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.55,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.55,
  });

  onStage('warmup');
  let landmarker;
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
  }

  // Downscale scratch canvas: the model needs ~256-512px, not 720p.
  const work = document.createElement('canvas');
  const wctx = work.getContext('2d', { alpha: false, willReadFrequently: false });
  let lastVideoTime = -1;
  let detections = 0, detectCount = 0, detectWindow = 0;

  function setInputWidth(px) { inputWidth = px; }

  /** Draw the current video frame into the small canvas and run inference on it. */
  function detect(video, timestamp) {
    if (!video.videoWidth || video.readyState < 2) return null;
    if (video.currentTime === lastVideoTime) return null; // same frame → no need to re-run
    lastVideoTime = video.currentTime;

    const w = inputWidth;
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    if (work.width !== w || work.height !== h) { work.width = w; work.height = h; }
    wctx.drawImage(video, 0, 0, w, h);

    const result = landmarker.detectForVideo(work, timestamp);
    detectCount++;
    return result;
  }

  function stats(dt) {
    detectWindow += dt;
    if (detectWindow >= 1) {
      detections = detectCount / detectWindow;
      detectCount = 0;
      detectWindow = 0;
    }
    return detections;
  }

  function dispose() {
    try { landmarker.close(); } catch { /* noop */ }
  }

  return { detect, stats, setInputWidth, dispose, modelAssetBuffer };
}
