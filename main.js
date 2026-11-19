import { EarthRaytracer } from './renderer.js';

const PRESETS = {
  'europe-day': {
    camYaw: 0.28,
    camPitch: 0.44,
    camDist: 3.45,
    camTargetOffset: [0, 0, 0],
    fovDeg: 38,
    sunAzDeg: -58,
    sunElDeg: 14,
    atmoDensity: 1.00,
    atmoHeight: 1.05,
    cloudCover: 0.90,
    exposure: 1.05,
  },
  'iss-orbit': {
    camYaw: 0.22,
    camPitch: 0.62,
    camDist: 1.24,
    camTargetOffset: [0.32, 0.24, -0.15],
    fovDeg: 52,
    sunAzDeg: 98,
    sunElDeg: 14,
    atmoDensity: 1.15,
    atmoHeight: 1.15,
    cloudCover: 0.95,
    exposure: 1.10,
  },
  'twilight': {
    camYaw: 0.16,
    camPitch: 0.36,
    camDist: 3.10,
    camTargetOffset: [0, 0, 0],
    fovDeg: 36,
    sunAzDeg: -92,
    sunElDeg: 8,
    atmoDensity: 1.15,
    atmoHeight: 1.10,
    cloudCover: 0.90,
    exposure: 1.15,
  },
  'americas': {
    camYaw: -1.48,
    camPitch: 0.32,
    camDist: 3.45,
    camTargetOffset: [0, 0, 0],
    fovDeg: 38,
    sunAzDeg: -65,
    sunElDeg: 16,
    atmoDensity: 1.00,
    atmoHeight: 1.05,
    cloudCover: 0.90,
    exposure: 1.05,
  },
  'himalaya': {
    camYaw: 1.44,
    camPitch: 0.48,
    camDist: 2.15,
    camTargetOffset: [0, 0, 0],
    fovDeg: 34,
    sunAzDeg: 32,
    sunElDeg: 14,
    atmoDensity: 0.95,
    atmoHeight: 1.00,
    cloudCover: 0.65,
    exposure: 1.05,
  },
  'night-europe': {
    camYaw: 0.20,
    camPitch: 0.66,
    camDist: 2.45,
    camTargetOffset: [0, 0, 0],
    fovDeg: 38,
    sunAzDeg: -145,
    sunElDeg: -12,
    atmoDensity: 1.15,
    atmoHeight: 1.10,
    cloudCover: 0.55,
    exposure: 1.25,
  },
};

const canvas = document.getElementById('viewport');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const statMode = document.getElementById('stat-mode');
const statRes = document.getElementById('stat-res');
const statAlt = document.getElementById('stat-alt');

const renderBanner = document.getElementById('render-banner');
const renderStatusText = document.getElementById('render-status-text');
const renderSppText = document.getElementById('render-spp-text');
const renderTimeText = document.getElementById('render-time-text');
const renderProgressBar = document.getElementById('render-progress-bar');
const pulseDot = renderBanner.querySelector('.pulse-dot');

const btnRender = document.getElementById('btn-render');
const btnDownload = document.getElementById('btn-download');
const btnBackLive = document.getElementById('btn-back-live');
const btnCancelRender = document.getElementById('btn-cancel-render');

const panel = document.getElementById('panel');
const btnTogglePanel = document.getElementById('btn-toggle-panel');
const btnOpenPanel = document.getElementById('btn-open-panel');

let renderer;
try {
  renderer = new EarthRaytracer(canvas);
} catch (err) {
  loadingTitle.textContent = err.message;
  throw err;
}

// ---------------------------------------------------------------------------
// Sliders & Controls Binding
// ---------------------------------------------------------------------------
const sliderBindings = [
  { id: 'sun-az', valId: 'val-sun-az', key: 'sunAzDeg', fmt: (v) => `${Math.round(v)}°` },
  { id: 'sun-el', valId: 'val-sun-el', key: 'sunElDeg', fmt: (v) => `${Math.round(v)}°` },
  { id: 'exposure', valId: 'val-exposure', key: 'exposure', fmt: (v) => v.toFixed(2) },
  { id: 'atmo-density', valId: 'val-atmo-density', key: 'atmoDensity', fmt: (v) => v.toFixed(2) },
  { id: 'atmo-height', valId: 'val-atmo-height', key: 'atmoHeight', fmt: (v) => v.toFixed(2) },
  { id: 'cloud-cover', valId: 'val-cloud-cover', key: 'cloudCover', fmt: (v) => v.toFixed(2) },
  { id: 'cloud-shadow', valId: 'val-cloud-shadow', key: 'cloudShadow', fmt: (v) => v.toFixed(2) },
  { id: 'cloud-offset', valId: 'val-cloud-offset', key: 'cloudOffsetDeg', fmt: (v) => `${Math.round(v)}°` },
  { id: 'bump-strength', valId: 'val-bump', key: 'bumpStrength', fmt: (v) => v.toFixed(2) },
  { id: 'ocean-spec', valId: 'val-ocean', key: 'oceanSpec', fmt: (v) => v.toFixed(2) },
  { id: 'night-lights', valId: 'val-lights', key: 'nightLights', fmt: (v) => v.toFixed(2) },
  { id: 'stars-intensity', valId: 'val-stars', key: 'starsIntensity', fmt: (v) => v.toFixed(2) },
  { id: 'cam-fov', valId: 'val-fov', key: 'fovDeg', fmt: (v) => `${Math.round(v)}°` },
];

function syncSlidersFromState() {
  for (const b of sliderBindings) {
    const el = document.getElementById(b.id);
    const valEl = document.getElementById(b.valId);
    el.value = renderer.state[b.key];
    valEl.textContent = b.fmt(Number(el.value));
  }
}

for (const b of sliderBindings) {
  const el = document.getElementById(b.id);
  const valEl = document.getElementById(b.valId);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    renderer.state[b.key] = v;
    valEl.textContent = b.fmt(v);
    // Exposure works live even on finished HDR render; other params return to live preview
    if (b.key !== 'exposure' && renderer.mode !== 'live') {
      exitRenderView();
    }
  });
}

document.getElementById('auto-rotate').addEventListener('change', (e) => {
  renderer.state.autoRotate = e.target.checked;
});

// Presets
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    if (renderer.mode !== 'live') exitRenderView();
    Object.assign(renderer.state, {
      ...p,
      camTargetOffset: [...p.camTargetOffset],
    });
    syncSlidersFromState();
    updateTelemetry();
  });
});

// Custom Texture Uploads
function bindFileInput(id, slot) {
  const input = document.getElementById(id);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    await renderer.loadCustomTexture(slot, file);
    if (renderer.mode !== 'live') exitRenderView();
  });
}
bindFileInput('file-day', 'day');
bindFileInput('file-night', 'night');
bindFileInput('file-clouds', 'clouds');

// Panel collapse
btnTogglePanel.addEventListener('click', () => {
  panel.classList.add('collapsed');
  btnOpenPanel.classList.remove('hidden');
});
btnOpenPanel.addEventListener('click', () => {
  panel.classList.remove('collapsed');
  btnOpenPanel.classList.add('hidden');
});

// ---------------------------------------------------------------------------
// Offline Raytrace Render Flow
// ---------------------------------------------------------------------------
function startRaytraceRender() {
  const resVal = document.getElementById('render-res').value;
  const [w, h] = resVal.split('x').map(Number);
  const spp = parseInt(document.getElementById('render-spp').value, 10);

  renderBanner.classList.remove('hidden');
  pulseDot.classList.remove('done');
  renderStatusText.textContent = `Raytracing (${w}×${h})…`;
  renderSppText.textContent = `0 / ${spp} SPP`;
  renderTimeText.textContent = '0.0s';
  renderProgressBar.style.width = '0%';

  btnDownload.classList.add('hidden');
  btnBackLive.classList.add('hidden');
  btnCancelRender.classList.remove('hidden');

  statMode.textContent = 'RAYTRACING';
  statMode.className = 'badge badge-render';
  statRes.textContent = `${w}×${h}`;

  renderer.startOfflineRender(w, h, spp);
}

function exitRenderView() {
  renderer.returnToLive();
  renderBanner.classList.add('hidden');
  statMode.textContent = 'LIVE VORSCHAU';
  statMode.className = 'badge badge-live';
  updateTelemetry();
}

renderer.onRenderProgress = (cur, total, elapsed) => {
  const pct = Math.min(100, (cur / total) * 100);
  renderProgressBar.style.width = `${pct.toFixed(1)}%`;
  renderSppText.textContent = `${cur} / ${total} SPP`;
  renderTimeText.textContent = `${elapsed.toFixed(1)}s`;
};

renderer.onRenderComplete = (w, h, spp, elapsed) => {
  pulseDot.classList.add('done');
  renderStatusText.textContent = `Render fertig (${w}×${h})`;
  renderSppText.textContent = `${spp} SPP`;
  renderTimeText.textContent = `${elapsed.toFixed(1)}s`;
  renderProgressBar.style.width = '100%';

  btnCancelRender.classList.add('hidden');
  btnDownload.classList.remove('hidden');
  btnBackLive.classList.remove('hidden');

  statMode.textContent = 'RENDER FERTIG';
};

btnRender.addEventListener('click', startRaytraceRender);
btnCancelRender.addEventListener('click', exitRenderView);
btnBackLive.addEventListener('click', exitRenderView);
btnDownload.addEventListener('click', () => renderer.exportPng());

// ---------------------------------------------------------------------------
// Interactive Orbit Camera & Sun Drag
// ---------------------------------------------------------------------------
let isDragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (renderer.mode !== 'live') return;
  isDragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!isDragging || renderer.mode !== 'live') return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;

  if (e.shiftKey) {
    // Rotate Sun
    renderer.state.sunAzDeg = ((renderer.state.sunAzDeg + dx * 0.35 + 540) % 360) - 180;
    renderer.state.sunElDeg = Math.max(-45, Math.min(45, renderer.state.sunElDeg - dy * 0.25));
    syncSlidersFromState();
  } else {
    // Orbit Camera (slower when close to surface for precision)
    const speed = 0.0045 * Math.min(1.0, (renderer.state.camDist - 1.0) * 0.8 + 0.18);
    renderer.state.camYaw -= dx * speed;
    renderer.state.camPitch = Math.max(
      -Math.PI * 0.48,
      Math.min(Math.PI * 0.48, renderer.state.camPitch + dy * speed)
    );
    // Gently return offset toward center when orbiting manually
    renderer.state.camTargetOffset = [0, 0, 0];
  }
});

canvas.addEventListener('pointerup', (e) => {
  isDragging = false;
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
});

canvas.addEventListener('wheel', (e) => {
  if (renderer.mode !== 'live') return;
  e.preventDefault();
  const zoomFactor = Math.exp(e.deltaY * 0.0011);
  const alt = renderer.state.camDist - 1.0;
  const newAlt = Math.max(0.10, Math.min(5.5, alt * zoomFactor));
  renderer.state.camDist = 1.0 + newAlt;
  updateTelemetry();
}, { passive: false });

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'r' || e.key === 'R') {
    startRaytraceRender();
  } else if (e.key === 'Escape' && renderer.mode !== 'live') {
    exitRenderView();
  }
});

// ---------------------------------------------------------------------------
// Telemetry & Main Loop
// ---------------------------------------------------------------------------
function updateTelemetry() {
  const altKm = Math.round((renderer.state.camDist - 1.0) * 6371);
  statAlt.textContent = `ALT ${altKm.toLocaleString('de-DE')} km`;
  if (renderer.mode === 'live') {
    statRes.textContent = `${canvas.width}×${canvas.height}`;
  }
}

window.addEventListener('resize', () => {
  renderer.resize();
  updateTelemetry();
});

// Start loading 4K NASA textures and launch loop
syncSlidersFromState();
updateTelemetry();

renderer.loadDefaultTextures((msg) => {
  loadingTitle.textContent = msg;
}).then(() => {
  loadingOverlay.classList.add('hidden');
  let lastTime = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    renderer.tick(dt);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
