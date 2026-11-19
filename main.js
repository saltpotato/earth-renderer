import { EarthRaytracer } from './renderer.js';
import { AIRCRAFT_PROFILES, SCENIC_ROUTES } from './flightAutopilot.js';

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
    auroraIntensity: 0.90,
    moonEnabled: true,
    moonAngleDeg: -124,
    moonDist: 6.2,
    exposure: 1.05,
  },
  'earth-moon': {
    camYaw: 0.24,
    camPitch: 0.14,
    camDist: 3.95,
    camTargetOffset: [-0.22, 0.08, 0],
    fovDeg: 42,
    sunAzDeg: -68,
    sunElDeg: 10,
    atmoDensity: 1.05,
    atmoHeight: 1.05,
    cloudCover: 0.88,
    auroraIntensity: 0.85,
    moonEnabled: true,
    moonAngleDeg: -128,
    moonDist: 5.2,
    exposure: 1.08,
  },
  'aurora-pole': {
    camYaw: -0.18,
    camPitch: 1.08,
    camDist: 2.35,
    camTargetOffset: [0, 0.12, 0],
    fovDeg: 40,
    sunAzDeg: 155,
    sunElDeg: -16,
    atmoDensity: 1.15,
    atmoHeight: 1.10,
    cloudCover: 0.55,
    auroraIntensity: 1.85,
    moonEnabled: true,
    moonAngleDeg: -135,
    moonDist: 6.8,
    exposure: 1.25,
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
    auroraIntensity: 1.10,
    moonEnabled: true,
    moonAngleDeg: -124,
    moonDist: 6.2,
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
    auroraIntensity: 1.15,
    moonEnabled: true,
    moonAngleDeg: -124,
    moonDist: 6.2,
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
    auroraIntensity: 0.90,
    moonEnabled: true,
    moonAngleDeg: 52,
    moonDist: 6.2,
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
    auroraIntensity: 0.70,
    moonEnabled: true,
    moonAngleDeg: -95,
    moonDist: 6.2,
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
    auroraIntensity: 1.50,
    moonEnabled: true,
    moonAngleDeg: -124,
    moonDist: 6.2,
    exposure: 1.25,
  },
};

const DEEP_ZOOM_TARGETS = {
  alps:   { name: 'Matterhorn',   lat: 45.9763, lon: 7.6586,    altKm: 13, tiltDeg: 64, headingDeg: 22 },
  berlin: { name: 'Berlin',       lat: 52.5200, lon: 13.4050,   altKm: 6,  tiltDeg: 36, headingDeg: 0 },
  canyon: { name: 'Grand Canyon', lat: 36.1069, lon: -112.1129, altKm: 16, tiltDeg: 62, headingDeg: 315 },
  nyc:    { name: 'New York',     lat: 40.7580, lon: -73.9855,  altKm: 7,  tiltDeg: 40, headingDeg: 25 },
  fuji:   { name: 'Mt. Fuji',     lat: 35.3606, lon: 138.7274,  altKm: 18, tiltDeg: 62, headingDeg: 325 },
  venice: { name: 'Venedig',      lat: 45.4408, lon: 12.3155,   altKm: 5,  tiltDeg: 35, headingDeg: 15 },
};

const canvas = document.getElementById('viewport');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingTitle = document.getElementById('loading-title');
const statMode = document.getElementById('stat-mode');
const statTex = document.getElementById('stat-tex');
const statTile = document.getElementById('stat-tile');
const statFps = document.getElementById('stat-fps');
const statRes = document.getElementById('stat-res');
const statAlt = document.getElementById('stat-alt');

const renderBanner = document.getElementById('render-banner');
const renderStatusText = document.getElementById('render-status-text');
const renderSppText = document.getElementById('render-spp-text');
const renderTimeText = document.getElementById('render-time-text');
const renderProgressBar = document.getElementById('render-progress-bar');
const pulseDot = renderBanner.querySelector('.pulse-dot');

const btnRender = document.getElementById('btn-render');
const btnRenderVideo = document.getElementById('btn-render-video');
const btnDownload = document.getElementById('btn-download');
const btnDownloadVideo = document.getElementById('btn-download-video');
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
  { id: 'cam-tilt', valId: 'val-tilt', key: 'camTiltDeg', fmt: (v) => `${Math.round(v)}°` },
  { id: 'cam-heading', valId: 'val-heading', key: 'camHeadingDeg', fmt: (v) => `${Math.round(v)}°` },
  { id: 'terrain-exag', valId: 'val-terrain-exag', key: 'terrainExag', fmt: (v) => `${v.toFixed(1)}×` },
  { id: 'moon-angle', valId: 'val-moon-angle', key: 'moonAngleDeg', fmt: (v) => `${Math.round(v)}°` },
  { id: 'moon-dist', valId: 'val-moon-dist', key: 'moonDist', fmt: (v) => `${v.toFixed(1)} R⊕` },
  { id: 'aurora-intensity', valId: 'val-aurora', key: 'auroraIntensity', fmt: (v) => v.toFixed(2) },
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

const moonEnabledEl = document.getElementById('moon-enabled');

function syncSlidersFromState() {
  for (const b of sliderBindings) {
    const el = document.getElementById(b.id);
    const valEl = document.getElementById(b.valId);
    el.value = renderer.state[b.key];
    valEl.textContent = b.fmt(Number(el.value));
  }
  moonEnabledEl.checked = renderer.state.moonEnabled;
}

for (const b of sliderBindings) {
  const el = document.getElementById(b.id);
  const valEl = document.getElementById(b.valId);
  el.addEventListener('input', () => {
    const v = parseFloat(el.value);
    renderer.state[b.key] = v;
    valEl.textContent = b.fmt(v);
    if (b.key !== 'exposure' && renderer.mode !== 'live') {
      exitRenderView();
    }
  });
}

moonEnabledEl.addEventListener('change', (e) => {
  renderer.state.moonEnabled = e.target.checked;
  if (renderer.mode !== 'live') exitRenderView();
});

document.getElementById('auto-rotate').addEventListener('change', (e) => {
  renderer.state.autoRotate = e.target.checked;
});

document.getElementById('tile-stream-enabled').addEventListener('change', (e) => {
  renderer.tileStreamer.enabled = e.target.checked;
  updateTelemetry();
});

// ---------------------------------------------------------------------------
// City-to-City Autopilot Flight Simulator
// ---------------------------------------------------------------------------
const apAircraftEl = document.getElementById('ap-aircraft');
const apRoutePresetEl = document.getElementById('ap-route-preset');
const apRecentGroupEl = document.getElementById('ap-recent-group');
const apFromEl = document.getElementById('ap-from');
const apToEl = document.getElementById('ap-to');
const apStatusEl = document.getElementById('ap-status');
const btnStartAutopilot = document.getElementById('btn-start-autopilot');

const RECENT_ROUTES_KEY = 'terra_recent_routes_v1';
const MAX_RECENT_ROUTES = 5;

function loadRecentRoutes() {
  try {
    const raw = localStorage.getItem(RECENT_ROUTES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let recentRoutes = loadRecentRoutes();

function saveRecentRoute(from, to) {
  const id = `recent:${from.name.toLowerCase()}->${to.name.toLowerCase()}`;
  const entry = {
    id,
    label: `${from.name} → ${to.name}`,
    from: { name: from.name, lat: from.lat, lon: from.lon },
    to: { name: to.name, lat: to.lat, lon: to.lon },
  };
  recentRoutes = [entry, ...recentRoutes.filter((r) => r.id !== id)].slice(0, MAX_RECENT_ROUTES);
  try {
    localStorage.setItem(RECENT_ROUTES_KEY, JSON.stringify(recentRoutes));
  } catch {
    // ignore storage quota errors
  }
  renderRecentRoutesDropdown(id);
}

function renderRecentRoutesDropdown(selectId = null) {
  apRecentGroupEl.innerHTML = '';
  if (recentRoutes.length === 0) {
    apRecentGroupEl.hidden = true;
    return;
  }
  apRecentGroupEl.hidden = false;
  for (const r of recentRoutes) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.label;
    apRecentGroupEl.appendChild(opt);
  }
  if (selectId) {
    apRoutePresetEl.value = selectId;
  }
}

renderRecentRoutesDropdown();

const apHud = document.getElementById('autopilot-hud');
const apHudAircraft = document.getElementById('ap-hud-aircraft');
const apHudRoute = document.getElementById('ap-hud-route');
const apHudTelemetry = document.getElementById('ap-hud-telemetry');
const apLabelFrom = document.getElementById('ap-label-from');
const apLabelTo = document.getElementById('ap-label-to');
const apProgressEl = document.getElementById('ap-progress');
const apTimescaleEl = document.getElementById('ap-timescale');
const btnApPause = document.getElementById('btn-ap-pause');
const btnApStop = document.getElementById('btn-ap-stop');

async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const results = await resp.json();
  if (!results || results.length === 0) throw new Error(`„${query}“ nicht gefunden`);
  const hit = results[0];
  return {
    name: hit.display_name.split(',')[0].trim(),
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    hit,
  };
}

function getRouteByKey(key) {
  if (SCENIC_ROUTES[key]) return SCENIC_ROUTES[key];
  return recentRoutes.find((r) => r.id === key) || null;
}

apRoutePresetEl.addEventListener('change', () => {
  const r = getRouteByKey(apRoutePresetEl.value);
  if (r) {
    apFromEl.value = r.from.name;
    apToEl.value = r.to.name;
  }
});

apFromEl.addEventListener('input', () => { apRoutePresetEl.value = 'custom'; });
apToEl.addEventListener('input', () => { apRoutePresetEl.value = 'custom'; });

apAircraftEl.addEventListener('change', () => {
  if (renderer.autopilot.active) {
    renderer.autopilot.setAircraft(apAircraftEl.value);
    updateAutopilotHud();
  }
});

function updateAutopilotHud() {
  const ap = renderer.autopilot;
  if (!ap.active) {
    apHud.classList.add('hidden');
    return;
  }
  apHud.classList.remove('hidden');
  const profile = AIRCRAFT_PROFILES[ap.aircraftId];
  apHudAircraft.textContent = profile.shortLabel;
  apHudRoute.textContent = `${ap.from.name} → ${ap.to.name}`;
  apLabelFrom.textContent = ap.from.name;
  apLabelTo.textContent = ap.to.name;

  const altStr = ap.altKm >= 1
    ? `${ap.altKm.toFixed(1).replace('.', ',')} km`
    : `${Math.round(ap.altKm * 1000)} m`;
  const remKm = Math.round(ap.getRemainingKm());
  apHudTelemetry.textContent = `ALT ${altStr} · ${ap.speedKmh} km/h · HDG ${String(Math.round(ap.headingDeg)).padStart(3, '0')}° · ${remKm} km`;
  apProgressEl.value = (ap.progress * 100).toFixed(1);
  btnApPause.textContent = ap.paused ? 'Weiter' : 'Pause';
  updateTelemetry();
}

renderer.onAutopilotUpdate = updateAutopilotHud;

btnStartAutopilot.addEventListener('click', async () => {
  const aircraftId = apAircraftEl.value;
  const presetKey = apRoutePresetEl.value;
  const fromText = apFromEl.value.trim();
  const toText = apToEl.value.trim();

  if (renderer.mode !== 'live') exitRenderView();
  apStatusEl.classList.add('hidden');

  let fromObj, toObj;
  const knownRoute = getRouteByKey(presetKey);
  if (knownRoute && knownRoute.from.name === fromText && knownRoute.to.name === toText) {
    fromObj = knownRoute.from;
    toObj = knownRoute.to;
    if (presetKey.startsWith('recent:')) {
      saveRecentRoute(fromObj, toObj); // bump to top of LRU
    }
  } else {
    if (!fromText || !toText) {
      apStatusEl.textContent = 'Bitte Start- und Zielstadt eingeben.';
      apStatusEl.classList.remove('hidden');
      return;
    }
    apStatusEl.textContent = `Berechne Route ${fromText} → ${toText}…`;
    apStatusEl.classList.remove('hidden');
    try {
      [fromObj, toObj] = await Promise.all([geocodePlace(fromText), geocodePlace(toText)]);
      apStatusEl.classList.add('hidden');
      saveRecentRoute(fromObj, toObj);
    } catch (err) {
      apStatusEl.textContent = `Route fehlgeschlagen: ${err.message}`;
      return;
    }
  }

  const ts = parseFloat(apTimescaleEl.value) || null;
  renderer.startAutopilotFlight(fromObj, toObj, aircraftId, ts);
  document.getElementById('tile-stream-enabled').checked = true;
  syncSlidersFromState();
  updateAutopilotHud();
});

btnApPause.addEventListener('click', () => {
  renderer.autopilot.paused = !renderer.autopilot.paused;
  updateAutopilotHud();
});

btnApStop.addEventListener('click', () => {
  renderer.stopAutopilotFlight();
  syncSlidersFromState();
  updateTelemetry();
});

apTimescaleEl.addEventListener('change', () => {
  renderer.autopilot.timeScale = parseFloat(apTimescaleEl.value) || 10;
});

apProgressEl.addEventListener('input', () => {
  renderer.autopilot.setProgress(parseFloat(apProgressEl.value) / 100);
  updateAutopilotHud();
});

document.querySelectorAll('.ap-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    const v = pill.dataset.view;
    if (v === 'front') renderer.autopilot.setLookView(0, -12);
    else if (v === 'left') renderer.autopilot.setLookView(-75, -14);
    else if (v === 'right') renderer.autopilot.setLookView(75, -14);
    else if (v === 'down') renderer.autopilot.setLookView(0, -48);
  });
});

// Nominatim Place / Address Geocoding Search
const searchForm = document.getElementById('place-search-form');
const searchInput = document.getElementById('place-search');
const searchStatus = document.getElementById('search-status');

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;

  searchStatus.textContent = `Suche „${q}“…`;
  searchStatus.classList.remove('hidden');

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const results = await resp.json();
    if (!results || results.length === 0) {
      searchStatus.textContent = `Kein Ort für „${q}“ gefunden.`;
      return;
    }

    const hit = results[0];
    const lat = parseFloat(hit.lat);
    const lon = parseFloat(hit.lon);
    // Estimate smart landing altitude from bounding box size
    let altKm = 6;
    if (Array.isArray(hit.boundingbox) && hit.boundingbox.length === 4) {
      const dLatKm = Math.abs(parseFloat(hit.boundingbox[1]) - parseFloat(hit.boundingbox[0])) * 111;
      const dLonKm = Math.abs(parseFloat(hit.boundingbox[3]) - parseFloat(hit.boundingbox[2])) * 111 * Math.cos((lat * Math.PI) / 180);
      const spanKm = Math.max(dLatKm, dLonKm);
      altKm = Math.max(1.2, Math.min(32, spanKm * 1.35));
    }

    const shortName = hit.display_name.split(',').slice(0, 2).join(',');
    searchStatus.textContent = `Flug nach ${shortName} (${lat.toFixed(2)}°, ${lon.toFixed(2)}°)`;

    if (renderer.mode !== 'live') exitRenderView();
    if (renderer.autopilot.active) renderer.stopAutopilotFlight();
    renderer.tileStreamer.enabled = true;
    document.getElementById('tile-stream-enabled').checked = true;
    const isPeak = /peak|mountain|volcano|glacier|canyon|alps/i.test(`${hit.type} ${hit.class} ${hit.display_name}`);
    renderer.flyToLocation(lat, lon, altKm, 3.6, true, isPeak ? 60 : 38, 0);
  } catch (err) {
    searchStatus.textContent = `Suche fehlgeschlagen (${err.message}).`;
  }
});

// Deep-Zoom Live Tile Destinations
document.querySelectorAll('.zoom-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = DEEP_ZOOM_TARGETS[btn.dataset.zoom];
    if (!t) return;
    if (renderer.mode !== 'live') exitRenderView();
    if (renderer.autopilot.active) renderer.stopAutopilotFlight();
    renderer.tileStreamer.enabled = true;
    document.getElementById('tile-stream-enabled').checked = true;
    renderer.flyToLocation(t.lat, t.lon, t.altKm, 3.6, true, t.tiltDeg ?? 0, t.headingDeg ?? 0);
  });
});

// Presets
document.querySelectorAll('.preset-btn[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    if (renderer.mode !== 'live') exitRenderView();
    if (renderer.autopilot.active) renderer.stopAutopilotFlight();
    renderer.cancelFlight();
    Object.assign(renderer.state, {
      ...p,
      camTiltDeg: 0,
      camHeadingDeg: 0,
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
    const info = await renderer.loadCustomTexture(slot, file);
    if (info && info.width >= 7000) {
      statTex.textContent = '8K CUSTOM';
      statTex.className = 'badge badge-tex-8k';
    }
    if (renderer.mode !== 'live') exitRenderView();
  });
}
bindFileInput('file-day', 'day');
bindFileInput('file-night', 'night');
bindFileInput('file-clouds', 'clouds');
bindFileInput('file-moon', 'moon');

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
// Offline Still Raytrace Render Flow
// ---------------------------------------------------------------------------
function startRaytraceRender() {
  if (renderer.mode === 'video') renderer.returnToLive();

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
  btnDownloadVideo.classList.add('hidden');
  btnBackLive.classList.add('hidden');
  btnCancelRender.classList.remove('hidden');

  statMode.textContent = 'RAYTRACING';
  statMode.className = 'badge badge-render';
  statRes.textContent = `${w}×${h}`;

  renderer.startOfflineRender(w, h, spp);
}

// ---------------------------------------------------------------------------
// Animated 4K Video Sequence Render Flow
// ---------------------------------------------------------------------------
function startVideoSequenceRender() {
  if (renderer.mode !== 'live') renderer.returnToLive();

  const [w, h] = document.getElementById('video-res').value.split('x').map(Number);
  const [durSec, fps] = document.getElementById('video-dur').value.split('x').map(Number);
  const sppPerFrame = parseInt(document.getElementById('video-spp').value, 10);
  const animType = document.getElementById('video-anim').value;
  const totalFrames = Math.round(durSec * fps);

  renderBanner.classList.remove('hidden');
  pulseDot.classList.remove('done');
  renderStatusText.textContent = `Video-Sequenz (${w}×${h})…`;
  renderSppText.textContent = `Frame 0 / ${totalFrames}`;
  renderTimeText.textContent = '0.0s';
  renderProgressBar.style.width = '0%';

  btnDownload.classList.add('hidden');
  btnDownloadVideo.classList.add('hidden');
  btnBackLive.classList.add('hidden');
  btnCancelRender.classList.remove('hidden');

  statMode.textContent = 'VIDEO RENDER';
  statMode.className = 'badge badge-render';
  statRes.textContent = `${w}×${h}`;

  try {
    renderer.startVideoRender({
      width: w,
      height: h,
      fps,
      durationSec: durSec,
      sppPerFrame,
      animType,
    });
  } catch (err) {
    renderStatusText.textContent = err.message;
  }
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

renderer.onVideoProgress = (curFrame, totalFrames, elapsed) => {
  const pct = Math.min(100, (curFrame / totalFrames) * 100);
  const eta = curFrame > 0 ? (elapsed / curFrame) * (totalFrames - curFrame) : 0;
  renderProgressBar.style.width = `${pct.toFixed(1)}%`;
  renderSppText.textContent = `Frame ${curFrame} / ${totalFrames}`;
  renderTimeText.textContent = `ETA ${eta.toFixed(0)}s`;
};

renderer.onVideoComplete = ({ width, height, totalFrames, elapsed, ext }) => {
  pulseDot.classList.add('done');
  renderStatusText.textContent = `Video fertig (${width}×${height} .${ext})`;
  renderSppText.textContent = `${totalFrames} Frames`;
  renderTimeText.textContent = `${elapsed.toFixed(1)}s`;
  renderProgressBar.style.width = '100%';

  btnCancelRender.classList.add('hidden');
  btnDownloadVideo.classList.remove('hidden');
  btnBackLive.classList.remove('hidden');

  statMode.textContent = 'VIDEO FERTIG';
};

btnRender.addEventListener('click', startRaytraceRender);
btnRenderVideo.addEventListener('click', startVideoSequenceRender);
btnCancelRender.addEventListener('click', exitRenderView);
btnBackLive.addEventListener('click', exitRenderView);
btnDownload.addEventListener('click', () => renderer.exportPng());
btnDownloadVideo.addEventListener('click', () => renderer.downloadLastVideo());

// ---------------------------------------------------------------------------
// Interactive Orbit Camera & Sun Drag
// ---------------------------------------------------------------------------
let isDragging = false;
let dragMode = 'pan'; // 'pan' | 'tilt' | 'sun'
let lastX = 0;
let lastY = 0;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (renderer.mode !== 'live') return;
  renderer.cancelFlight();
  isDragging = true;
  if (e.shiftKey) {
    dragMode = 'sun';
  } else if (e.button === 2 || e.altKey) {
    dragMode = 'tilt';
  } else {
    dragMode = 'pan';
  }
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

  if (dragMode === 'sun' || e.shiftKey) {
    renderer.state.sunAzDeg = ((renderer.state.sunAzDeg + dx * 0.35 + 540) % 360) - 180;
    renderer.state.sunElDeg = Math.max(-45, Math.min(45, renderer.state.sunElDeg - dy * 0.25));
    syncSlidersFromState();
  } else if (renderer.autopilot.active) {
    // Free 360° passenger / cockpit look-around while Autopilot flies!
    renderer.autopilot.lookYawDeg = ((renderer.autopilot.lookYawDeg - dx * 0.28 + 540) % 360) - 180;
    renderer.autopilot.lookPitchDeg = Math.max(-80, Math.min(68, renderer.autopilot.lookPitchDeg + dy * 0.22));
  } else if (dragMode === 'tilt' || e.altKey) {
    // Google-Earth-style 3D Tilt & Compass Heading rotation
    renderer.state.camHeadingDeg = (renderer.state.camHeadingDeg + dx * 0.35 + 360) % 360;
    renderer.state.camTiltDeg = Math.max(0, Math.min(76, renderer.state.camTiltDeg - dy * 0.25));
    syncSlidersFromState();
  } else {
    // Heading-aligned panning scaled smoothly with altitude down to 180 m
    const alt = Math.max(0.000028, renderer.state.camDist - 1.0);
    const speed = 0.0042 * Math.min(1.0, alt * 0.85);
    const cosLat = Math.max(0.18, Math.cos(renderer.state.camPitch));
    const head = (renderer.state.camHeadingDeg * Math.PI) / 180;
    const ch = Math.cos(head);
    const sh = Math.sin(head);
    // Rotate screen drag (dx, dy) into local (East, North)
    const dEast = -dx * ch + dy * sh;
    const dNorth = dx * sh + dy * ch;
    renderer.state.camYaw += (dEast * speed) / cosLat;
    renderer.state.camPitch = Math.max(
      -Math.PI * 0.48,
      Math.min(Math.PI * 0.48, renderer.state.camPitch + dNorth * speed)
    );
    renderer.state.camTargetOffset = [0, 0, 0];
    updateTelemetry();
  }
});

canvas.addEventListener('pointerup', (e) => {
  isDragging = false;
  if (canvas.hasPointerCapture(e.pointerId)) {
    canvas.releasePointerCapture(e.pointerId);
  }
});

function applyZoomScale(factor) {
  if (renderer.autopilot.active) {
    // Binocular / camera lens FOV zoom while looking out the plane window
    renderer.state.fovDeg = Math.max(18, Math.min(75, renderer.state.fovDeg * factor));
    syncSlidersFromState();
    return;
  }
  const alt = renderer.state.camDist - 1.0;
  // Allow zooming from 35,000 km all the way down to 180 m altitude (Z19)
  const newAlt = Math.max(0.000028, Math.min(5.5, alt * factor));
  renderer.state.camDist = 1.0 + newAlt;
  updateTelemetry();
}

canvas.addEventListener('wheel', (e) => {
  if (renderer.mode !== 'live') return;
  e.preventDefault();
  renderer.cancelFlight();

  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 16; // line mode -> px

  // macOS trackpad pinch-to-zoom sends wheel events with ctrlKey=true and tiny deltaY (±1..3)
  const sensitivity = e.ctrlKey ? 0.014 : 0.0022;
  const clamped = Math.max(-250, Math.min(250, dy));
  applyZoomScale(Math.exp(clamped * sensitivity));
}, { passive: false });

// Native Safari macOS trackpad pinch gestures
let gestureStartAlt = null;
canvas.addEventListener('gesturestart', (e) => {
  e.preventDefault();
  if (renderer.mode !== 'live') return;
  renderer.cancelFlight();
  gestureStartAlt = renderer.state.camDist - 1.0;
}, { passive: false });

canvas.addEventListener('gesturechange', (e) => {
  e.preventDefault();
  if (renderer.mode !== 'live' || gestureStartAlt === null) return;
  const scale = Math.max(0.1, e.scale || 1);
  const newAlt = Math.max(0.000028, Math.min(5.5, gestureStartAlt / Math.pow(scale, 2.2)));
  renderer.state.camDist = 1.0 + newAlt;
  updateTelemetry();
}, { passive: false });

canvas.addEventListener('gestureend', (e) => {
  e.preventDefault();
  gestureStartAlt = null;
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'r' || e.key === 'R') {
    startRaytraceRender();
  } else if (e.key === 'Escape' && renderer.mode !== 'live') {
    exitRenderView();
  } else if ((e.key === '+' || e.key === '=') && renderer.mode === 'live') {
    renderer.cancelFlight();
    applyZoomScale(0.72);
  } else if (e.key === '-' && renderer.mode === 'live') {
    renderer.cancelFlight();
    applyZoomScale(1.38);
  }
});

// ---------------------------------------------------------------------------
// Local Zero-Install Satellite Texture Enhancement & Persistent Cache
// ---------------------------------------------------------------------------
const aiStyleEl = document.getElementById('ai-style');
const aiAutoEnrichEl = document.getElementById('ai-auto-enrich');
const btnAiEnrich = document.getElementById('btn-ai-enrich');
const btnAiToggle = document.getElementById('btn-ai-toggle');
const aiCacheInfoEl = document.getElementById('ai-cache-info');
const btnAiClearCache = document.getElementById('btn-ai-clear-cache');
const aiStatusEl = document.getElementById('ai-status');

aiStyleEl.value = renderer.aiEnricher.styleId;
aiAutoEnrichEl.checked = renderer.aiEnricher.autoEnrich;

renderer.aiEnricher.onCacheStatsChange = ({ count, disk }) => {
  const mode = disk ? 'Disk + IDB' : 'Browser-IDB';
  aiCacheInfoEl.textContent = `Cache: ${count} Patches (${mode})`;
};
renderer.aiEnricher.initPersistentCache();

btnAiClearCache.addEventListener('click', () => {
  renderer.aiEnricher.clearAllCache();
});

aiStyleEl.addEventListener('change', () => {
  renderer.aiEnricher.styleId = aiStyleEl.value;
  if (renderer.tileStreamer.hasValidPatch && renderer.aiEnricher.autoEnrich) {
    renderer.enrichCurrentTiles().catch(() => {});
  }
});

aiAutoEnrichEl.addEventListener('change', () => {
  renderer.aiEnricher.autoEnrich = aiAutoEnrichEl.checked;
  if (aiAutoEnrichEl.checked && renderer.tileStreamer.hasValidPatch) {
    renderer.enrichCurrentTiles().catch(() => {});
  }
});

renderer.aiEnricher.onStatus = (msg) => {
  aiStatusEl.textContent = msg;
};

renderer.onAiTextureChange = ({ active, hasAi }) => {
  if (hasAi) {
    btnAiToggle.classList.remove('hidden');
    btnAiToggle.textContent = active ? 'Original' : '✦ Veredelt';
  } else {
    btnAiToggle.classList.add('hidden');
  }
  updateTelemetry();
};

btnAiEnrich.addEventListener('click', async () => {
  btnAiEnrich.disabled = true;
  try {
    await renderer.enrichCurrentTiles();
  } catch (err) {
    aiStatusEl.textContent = `Hinweis: ${err.message}`;
  } finally {
    btnAiEnrich.disabled = false;
  }
});

btnAiToggle.addEventListener('click', () => {
  renderer.toggleAiTextureView();
});

// ---------------------------------------------------------------------------
// Telemetry & Main Loop
// ---------------------------------------------------------------------------
function updateTelemetry() {
  const { latDeg, lonDeg, alt } = renderer.getCameraLatLon();
  const altKm = alt * 6371;
  let altStr;
  if (altKm >= 100) {
    altStr = `${Math.round(altKm).toLocaleString('de-DE')} km`;
  } else if (altKm >= 1.0) {
    altStr = `${altKm.toFixed(1).replace('.', ',')} km`;
  } else {
    altStr = `${Math.round(altKm * 1000)} m`;
  }
  const latStr = `${Math.abs(latDeg).toFixed(2)}°${latDeg >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lonDeg).toFixed(2)}°${lonDeg >= 0 ? 'E' : 'W'}`;
  statAlt.textContent = `ALT ${altStr} · ${latStr} ${lonStr}`;

  if (renderer.tileStreamer.enabled && renderer.tileStreamer.hasValidPatch && alt < 0.62) {
    const prefix = renderer.showingAiTexture ? '✦ ENH Z' : 'LIVE Z';
    statTile.textContent = `${prefix}${renderer.tileStreamer.activeZoom}`;
    statTile.classList.remove('hidden');
  } else {
    statTile.classList.add('hidden');
  }

  if (renderer.mode === 'live') {
    statRes.textContent = `${renderer.accumWidth}×${renderer.accumHeight}`;
  }
}

renderer.onTileStatusChange = () => updateTelemetry();
renderer.onFlightUpdate = () => {
  syncSlidersFromState();
  updateTelemetry();
};

window.addEventListener('resize', () => {
  renderer.resize();
  updateTelemetry();
});

syncSlidersFromState();
updateTelemetry();

renderer.loadDefaultTextures((msg) => {
  loadingTitle.textContent = msg;
}).then((tier) => {
  statTex.textContent = tier;
  statTex.className = tier.includes('8K') ? 'badge badge-tex-8k' : 'badge badge-tex';
  loadingOverlay.classList.add('hidden');
  let lastTime = performance.now();
  let fpsFrames = 0;
  let fpsStart = lastTime;
  const loop = (now) => {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    renderer.tick(dt);

    fpsFrames++;
    if (now - fpsStart >= 400) {
      const fps = Math.round((fpsFrames * 1000) / (now - fpsStart));
      statFps.textContent = `${fps} FPS`;
      fpsFrames = 0;
      fpsStart = now;
    }

    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
