// Dynamic Web Mercator Tile Streamer for Deep-Zoom Earth Raytracing
// Streams Esri World Imagery (Satellite) + AWS Open Terrain (Terrarium DEM)

const ESRI_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

const TERRARIUM_URL = (z, x, y) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

const TILE_SIZE = 256;
const GRID_SIZE = 8; // 8x8 = 2048x2048 dynamic GPU patch (covers full 16:9 widescreen!)
const MAX_CACHE = 480;
const MIN_ZOOM = 4;
const MAX_ZOOM = 19; // Up to ~30 cm/px (rooftops & cars in Esri World Imagery)

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function latLonToTileFloat(latDeg, lonDeg, zoom) {
  const n = Math.pow(2, zoom);
  const latClamped = clamp(latDeg, -85.0511, 85.0511);
  const latRad = (latClamped * Math.PI) / 180;
  const x = ((lonDeg + 180) / 360) * n;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y, n };
}

export function computeIdealZoom(altEarthRadii, fovDeg, latDeg) {
  // Visible ground width in km
  const altKm = Math.max(0.05, altEarthRadii * 6371);
  const visKm = 2 * altKm * Math.tan(((fovDeg * Math.PI) / 180) * 0.5);
  const cosLat = Math.max(0.2, Math.cos((latDeg * Math.PI) / 180));
  // Account for 16:9 widescreen horizontal span so tiles fill 100% edge-to-edge
  const targetTileKm = (visKm * 2.15) / GRID_SIZE;
  const zFloat = Math.log2((40075 * cosLat) / Math.max(targetTileKm, 0.01));
  return clamp(Math.round(zFloat), MIN_ZOOM, MAX_ZOOM);
}

class TileLRUCache {
  constructor(limit) {
    this.limit = limit;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }
}

function loadTileImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export class DynamicTileStreamer {
  constructor(onPatchUpdated) {
    this.onPatchUpdated = onPatchUpdated;
    this.enabled = true;

    this.satCache = new TileLRUCache(MAX_CACHE);
    this.demCache = new TileLRUCache(MAX_CACHE);
    this.inflight = new Map();

    this.satCanvas = document.createElement('canvas');
    this.satCanvas.width = TILE_SIZE * GRID_SIZE;
    this.satCanvas.height = TILE_SIZE * GRID_SIZE;
    this.satCtx = this.satCanvas.getContext('2d');

    this.demCanvas = document.createElement('canvas');
    this.demCanvas.width = TILE_SIZE * GRID_SIZE;
    this.demCanvas.height = TILE_SIZE * GRID_SIZE;
    this.demCtx = this.demCanvas.getContext('2d');
    this.demCtx.imageSmoothingEnabled = false;

    // Current uploaded GPU patch bounds: [xMin, yMin, gridSize, nTiles]
    this.activeBounds = [0, 0, GRID_SIZE, 1];
    // High-precision float64 top-left reference [refLonRad, refLatRad, cosRefLat, sinRefLat]
    this.activeRef = [0, 0, 1, 0];
    this.activeZoom = 0;
    this.hasValidPatch = false;
    this.isLoading = false;
    this.loadedCount = 0;
    this.totalCount = GRID_SIZE * GRID_SIZE;

    this._lastRequestKey = '';
    this._requestId = 0;
    this._debounceTimer = null;
  }

  _fetchCached(cache, key, url) {
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    if (this.inflight.has(key)) return this.inflight.get(key);

    const p = loadTileImage(url).then((img) => {
      this.inflight.delete(key);
      if (img) cache.set(key, img);
      return img;
    });
    this.inflight.set(key, p);
    return p;
  }

  /**
   * Call frequently in live preview; debounces & streams tiles automatically
   * whenever altitude is low enough for high-res imagery (< 3,800 km).
   */
  updateForCamera(latDeg, lonDeg, altEarthRadii, fovDeg, minTileShift = 0) {
    if (!this.enabled || altEarthRadii > 0.62) {
      return;
    }

    const zoom = computeIdealZoom(altEarthRadii, fovDeg, latDeg);
    const { x, y, n } = latLonToTileFloat(latDeg, lonDeg, zoom);

    const xMin = Math.floor(x - GRID_SIZE * 0.5);
    const yMin = clamp(Math.floor(y - GRID_SIZE * 0.5), 0, Math.max(0, n - GRID_SIZE));
    const reqKey = `${zoom}:${xMin}:${yMin}`;

    if (reqKey === this._lastRequestKey) return;

    // During continuous flight, keep current patch until we've moved >= minTileShift tiles
    if (minTileShift > 0 && this.hasValidPatch && zoom === this.activeZoom) {
      const dx = Math.abs(xMin - this.activeBounds[0]);
      const dy = Math.abs(yMin - this.activeBounds[1]);
      if (dx < minTileShift && dy < minTileShift) {
        return;
      }
    }

    this._lastRequestKey = reqKey;

    if (minTileShift > 0) {
      // Load immediately without debounce starvation during flight
      if (!this.isLoading) {
        this._loadPatch(zoom, xMin, yMin, n);
      }
      return;
    }

    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._loadPatch(zoom, xMin, yMin, n);
    }, 90);
  }

  /**
   * Awaits full patch completion (used for offline raytrace & Deep-Zoom video frames).
   */
  async ensureReady(latDeg, lonDeg, altEarthRadii, fovDeg) {
    if (!this.enabled || altEarthRadii > 0.62) {
      return false;
    }
    const zoom = computeIdealZoom(altEarthRadii, fovDeg, latDeg);
    const { x, y, n } = latLonToTileFloat(latDeg, lonDeg, zoom);
    const xMin = Math.floor(x - GRID_SIZE * 0.5);
    const yMin = clamp(Math.floor(y - GRID_SIZE * 0.5), 0, Math.max(0, n - GRID_SIZE));
    const reqKey = `${zoom}:${xMin}:${yMin}`;

    if (reqKey === this._lastRequestKey && this.hasValidPatch && !this.isLoading) {
      return true;
    }
    this._lastRequestKey = reqKey;
    clearTimeout(this._debounceTimer);
    await this._loadPatch(zoom, xMin, yMin, n);
    return this.hasValidPatch;
  }

  async _loadPatch(zoom, xMin, yMin, n) {
    const myReqId = ++this._requestId;
    this.isLoading = true;
    this.loadedCount = 0;
    this.totalCount = GRID_SIZE * GRID_SIZE;

    // Terrarium DEM max zoom is 15
    const demZoom = Math.min(zoom, 15);
    const demScale = Math.pow(2, zoom - demZoom);

    const satImgs = new Array(GRID_SIZE * GRID_SIZE).fill(null);
    const demImgs = new Array(GRID_SIZE * GRID_SIZE).fill(null);

    const tasks = [];
    for (let dy = 0; dy < GRID_SIZE; dy++) {
      for (let dx = 0; dx < GRID_SIZE; dx++) {
        const idx = dy * GRID_SIZE + dx;
        const tx = (((xMin + dx) % n) + n) % n;
        const ty = yMin + dy;
        if (ty < 0 || ty >= n) continue;

        const satKey = `sat:${zoom}:${tx}:${ty}`;
        const dtx = Math.floor(tx / demScale);
        const dty = Math.floor(ty / demScale);
        const demKey = `dem:${demZoom}:${dtx}:${dty}`;

        const t = Promise.all([
          this._fetchCached(this.satCache, satKey, ESRI_URL(zoom, tx, ty)),
          this._fetchCached(this.demCache, demKey, TERRARIUM_URL(demZoom, dtx, dty)),
        ]).then(([satImg, demImg]) => {
          satImgs[idx] = satImg;
          demImgs[idx] = { img: demImg, tx, ty, dtx, dty, demScale };
          this.loadedCount++;
        });
        tasks.push(t);
      }
    }

    await Promise.all(tasks);
    if (myReqId !== this._requestId) return; // superseded by newer camera position

    // Composite complete 6x6 patch onto offscreen canvases (no tearing/half-tiles!)
    this.satCtx.fillStyle = '#0c2344';
    this.satCtx.fillRect(0, 0, this.satCanvas.width, this.satCanvas.height);
    // Neutral sea-level Terrarium RGB = (128, 0, 0) -> 0m elevation
    this.demCtx.fillStyle = 'rgb(128, 0, 0)';
    this.demCtx.fillRect(0, 0, this.demCanvas.width, this.demCanvas.height);

    let anySat = false;
    for (let dy = 0; dy < GRID_SIZE; dy++) {
      for (let dx = 0; dx < GRID_SIZE; dx++) {
        const idx = dy * GRID_SIZE + dx;
        const px = dx * TILE_SIZE;
        const py = dy * TILE_SIZE;

        if (satImgs[idx]) {
          this.satCtx.drawImage(satImgs[idx], px, py, TILE_SIZE, TILE_SIZE);
          anySat = true;
        }
        const d = demImgs[idx];
        if (d && d.img) {
          if (d.demScale === 1) {
            this.demCtx.drawImage(d.img, px, py, TILE_SIZE, TILE_SIZE);
          } else {
            // Crop matching sub-region of zoom-15 DEM tile when sat is at zoom 16
            const subW = TILE_SIZE / d.demScale;
            const sx = (d.tx - d.dtx * d.demScale) * subW;
            const sy = (d.ty - d.dty * d.demScale) * subW;
            this.demCtx.drawImage(d.img, sx, sy, subW, subW, px, py, TILE_SIZE, TILE_SIZE);
          }
        }
      }
    }

    this.isLoading = false;
    if (anySat) {
      this.activeBounds = [xMin, yMin, GRID_SIZE, n];
      const refLonRad = (xMin / n - 0.5) * Math.PI * 2;
      const refLatRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * yMin) / n)));
      this.activeRef = [refLonRad, refLatRad, Math.cos(refLatRad), Math.sin(refLatRad)];
      this.activeZoom = zoom;
      this.hasValidPatch = true;
      if (this.onPatchUpdated) {
        this.onPatchUpdated({
          satCanvas: this.satCanvas,
          demCanvas: this.demCanvas,
          bounds: this.activeBounds,
          zoom: this.activeZoom,
        });
      }
    }
  }
}
