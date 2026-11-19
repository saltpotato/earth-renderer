// 100% Local, Zero-Install Satellite Texture Enhancer
// Dehazing + Multi-Scale Unsharp Mask + DEM-Guided Biome Detail Baking
// 3-Tier Persistent Cache: RAM -> IndexedDB -> Local Disk (textures/ai_cache/ via server.py)

const IDB_NAME = 'terra_local_enh_v1';
const IDB_STORE = 'patches';

export const ENHANCE_STYLES = {
  esrgan: {
    label: 'Real-ESRGAN x4 (Lokale KI · 2048px)',
    useEsrgan: true,
    model: 'realesrgan-x4plus',
  },
  sharp: {
    label: 'Klar & Scharf (Sofort · Dehaze)',
    dehaze: 0.24,
    sharpen: 1.15,
    vibrance: 0.18,
    microDetail: 0.22,
    contrast: 1.08,
  },
  natgeo: {
    label: 'National Geographic (Sofort)',
    dehaze: 0.34,
    sharpen: 1.35,
    vibrance: 0.34,
    microDetail: 0.30,
    contrast: 1.14,
  },
};

function sanitizeCacheFilename(cacheKey) {
  return `${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function hash2i(x, y) {
  let n = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Gecachte Textur konnte nicht dekodiert werden.'));
    };
    img.src = url;
  });
}

class TextureIDB {
  constructor() {
    this._dbPromise = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    return this._dbPromise;
  }

  async get(key) {
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async set(key, blob) {
    const db = await this._open();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async count() {
    const db = await this._open();
    if (!db) return 0;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
  }

  async clear() {
    const db = await this._open();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}

export class AiTextureEnricher {
  constructor() {
    this.autoEnrich = true;
    this.styleId = 'esrgan';

    this.cache = new Map();
    this.maxCache = 32;
    this.idb = new TextureIDB();
    this.diskCacheSupported = false;
    this.esrganSupported = false;
    this.diskFiles = new Set();
    this.cachedCount = 0;

    this.isBusy = false;
    this._pending = null;
    this.onStatus = null;
    this.onCacheStatsChange = null;
  }

  hasKey() {
    return true; // 100% local — no API key needed!
  }

  async initPersistentCache() {
    try {
      const resp = await fetch('/api/ai-cache', { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        this.diskCacheSupported = true;
        this.esrganSupported = Boolean(data.esrgan);
        this.diskFiles = new Set(data.files || []);
      }
    } catch {
      this.diskCacheSupported = false;
      this.esrganSupported = false;
    }
    if (!this.esrganSupported && this.styleId === 'esrgan') {
      this.styleId = 'natgeo';
    }
    await this._refreshCacheStats();
  }

  async _refreshCacheStats() {
    const idbCount = await this.idb.count();
    this.cachedCount = Math.max(idbCount, this.diskFiles.size, this.cache.size);
    if (this.onCacheStatsChange) {
      this.onCacheStatsChange({
        count: this.cachedCount,
        disk: this.diskCacheSupported,
        esrgan: this.esrganSupported,
      });
    }
  }

  _makeKey(patchKey) {
    return `loc_${this.styleId}:${patchKey}`;
  }

  getCached(patchKey) {
    return this.cache.get(this._makeKey(patchKey)) || null;
  }

  async getCachedAsync(patchKey) {
    const cacheKey = this._makeKey(patchKey);
    const ramHit = this.cache.get(cacheKey);
    if (ramHit) return ramHit;

    const idbBlob = await this.idb.get(cacheKey);
    if (idbBlob) {
      try {
        const img = await blobToImage(idbBlob);
        this._setRamCache(cacheKey, img);
        return img;
      } catch {
        // ignore
      }
    }

    const filename = sanitizeCacheFilename(cacheKey);
    if (this.diskCacheSupported && this.diskFiles.has(filename)) {
      try {
        const resp = await fetch(`/api/ai-cache/${filename}`, { cache: 'no-store' });
        if (resp.ok) {
          const blob = await resp.blob();
          const img = await blobToImage(blob);
          this._setRamCache(cacheKey, img);
          this.idb.set(cacheKey, blob).catch(() => {});
          return img;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  _setRamCache(cacheKey, img) {
    if (this.cache.has(cacheKey)) this.cache.delete(cacheKey);
    this.cache.set(cacheKey, img);
    if (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  async _persistBlob(cacheKey, blob) {
    await this.idb.set(cacheKey, blob);
    if (this.diskCacheSupported) {
      const filename = sanitizeCacheFilename(cacheKey);
      try {
        const resp = await fetch(`/api/ai-cache/${filename}`, {
          method: 'PUT',
          headers: { 'Content-Type': blob.type || 'image/png' },
          body: blob,
        });
        if (resp.ok) this.diskFiles.add(filename);
      } catch {
        // ignore
      }
    }
    await this._refreshCacheStats();
  }

  async clearAllCache() {
    this.cache.clear();
    await this.idb.clear();
    if (this.diskCacheSupported) {
      try {
        await fetch('/api/ai-cache', { method: 'DELETE' });
        this.diskFiles.clear();
      } catch {
        // ignore
      }
    }
    await this._refreshCacheStats();
    if (this.onStatus) this.onStatus('Lokaler Textur-Cache geleert.');
  }

  /**
   * Local GPU/Canvas satellite texture enhancer:
   * 1. Dark-channel atmospheric dehazing
   * 2. Multi-scale unsharp mask (crisp edges, roads, coastlines, ridges)
   * 3. DEM-guided rock/canopy/coastline micro-detail baking
   * 4. Natural vibrance & filmic contrast
   */
  _enhanceCanvasLocally(satCanvas, demCanvas, style) {
    const size = 1024;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = size;
    outCanvas.height = size;
    const ctx = outCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(satCanvas, 0, 0, size, size);
    const imgData = ctx.getImageData(0, 0, size, size);
    const src = imgData.data;

    // Sample matching DEM canvas for elevation & slope-aware enhancement
    let demData = null;
    if (demCanvas) {
      const dCanvas = document.createElement('canvas');
      dCanvas.width = size;
      dCanvas.height = size;
      const dCtx = dCanvas.getContext('2d', { willReadFrequently: true });
      dCtx.imageSmoothingEnabled = false;
      dCtx.drawImage(demCanvas, 0, 0, size, size);
      demData = dCtx.getImageData(0, 0, size, size).data;
    }

    const total = size * size;
    const lum = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      const o = i * 4;
      lum[i] = 0.2126 * src[o] + 0.7152 * src[o + 1] + 0.0722 * src[o + 2];
    }

    // Fast separable 5-tap blur for local unsharp mask
    const blurH = new Float32Array(total);
    const blur = new Float32Array(total);
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const xm2 = x > 1 ? x - 2 : 0;
        const xm1 = x > 0 ? x - 1 : 0;
        const xp1 = x < size - 1 ? x + 1 : size - 1;
        const xp2 = x < size - 2 ? x + 2 : size - 1;
        blurH[row + x] =
          (lum[row + xm2] + 2 * lum[row + xm1] + 4 * lum[row + x] + 2 * lum[row + xp1] + lum[row + xp2]) * 0.1;
      }
    }
    for (let y = 0; y < size; y++) {
      const ym2 = (y > 1 ? y - 2 : 0) * size;
      const ym1 = (y > 0 ? y - 1 : 0) * size;
      const y0 = y * size;
      const yp1 = (y < size - 1 ? y + 1 : size - 1) * size;
      const yp2 = (y < size - 2 ? y + 2 : size - 1) * size;
      for (let x = 0; x < size; x++) {
        blur[y0 + x] =
          (blurH[ym2 + x] + 2 * blurH[ym1 + x] + 4 * blurH[y0 + x] + 2 * blurH[yp1 + x] + blurH[yp2 + x]) * 0.1;
      }
    }

    const { dehaze, sharpen, vibrance, microDetail, contrast } = style;

    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 0; x < size; x++) {
        const idx = row + x;
        const o = idx * 4;
        let r = src[o];
        let g = src[o + 1];
        let b = src[o + 2];

        // 1. Subtle Dark-Channel Dehazing (clears orbital blue haze from Esri tiles)
        const minC = Math.min(r, g, b);
        const haze = minC * dehaze * 0.42;
        const invT = 1.0 / (1.0 - dehaze * 0.24);
        r = (r - haze) * invT;
        g = (g - haze) * invT;
        b = (b - haze * 1.12) * invT;

        // 2. Multi-scale Unsharp Mask (edge-preserving crispness)
        const detail = lum[idx] - blur[idx];
        const sharpBoost = detail * sharpen;
        r += sharpBoost;
        g += sharpBoost;
        b += sharpBoost;

        // 3. DEM-guided micro-detail baking (rock strata on slopes, foliage grain on green)
        if (microDetail > 0) {
          let elevM = 50;
          let slope = 0;
          if (demData) {
            elevM = demData[o] * 256 + demData[o + 1] - 32768;
            const oR = (row + (x < size - 1 ? x + 1 : x)) * 4;
            const oD = ((y < size - 1 ? y + 1 : y) * size + x) * 4;
            const eR = demData[oR] * 256 + demData[oR + 1] - 32768;
            const eD = demData[oD] * 256 + demData[oD + 1] - 32768;
            slope = Math.min(1, (Math.abs(eR - elevM) + Math.abs(eD - elevM)) / 90);
          }

          const isWater = elevM < 2 && b > r * 1.12;
          if (!isWater) {
            const n = (hash2i(x, y) - 0.5) * 2.0;
            const isGreen = g > r * 1.03 && g > b * 1.05;
            const strata = slope > 0.15 ? Math.sin(elevM * 0.14 + n * 1.2) * slope * 18 : 0;
            const grain = n * (isGreen ? 15 : 10) * microDetail + strata * microDetail;
            r += grain;
            g += grain * (isGreen ? 1.15 : 1.0);
            b += grain * 0.92;
          }
        }

        // 4. Natural Vibrance (boosts muted colors more than already saturated ones)
        const mx = Math.max(r, g, b);
        const mn = Math.min(r, g, b);
        const sat = mx > 1 ? (mx - mn) / mx : 0;
        const vibGain = 1.0 + vibrance * (1.0 - sat * 0.65);
        const avg = 0.299 * r + 0.587 * g + 0.114 * b;
        r = avg + (r - avg) * vibGain;
        g = avg + (g - avg) * vibGain;
        b = avg + (b - avg) * vibGain;

        // 5. Filmic S-curve contrast around midpoint
        r = (r - 128) * contrast + 128;
        g = (g - 128) * contrast + 128;
        b = (b - 128) * contrast + 128;

        src[o] = clamp255(r);
        src[o + 1] = clamp255(g);
        src[o + 2] = clamp255(b);
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return outCanvas;
  }

  async _canvasToJpegBlob(srcCanvas, targetSize = 512) {
    const tmp = document.createElement('canvas');
    tmp.width = targetSize;
    tmp.height = targetSize;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, targetSize, targetSize);
    return new Promise((resolve) => tmp.toBlob(resolve, 'image/jpeg', 0.92));
  }

  async enrichPatch({ patchKey, satCanvas, demCanvas, zoom }) {
    const cacheKey = this._makeKey(patchKey);
    const cached = await this.getCachedAsync(patchKey);
    if (cached) {
      if (this.onStatus) this.onStatus(`✦ Aus lokalem Cache geladen (Z${zoom})`);
      return cached;
    }

    if (this.isBusy) {
      this._pending = { patchKey, satCanvas, demCanvas, zoom };
      return null;
    }

    this.isBusy = true;
    const t0 = performance.now();
    try {
      const style = ENHANCE_STYLES[this.styleId] || ENHANCE_STYLES.natgeo;
      let blob;

      if (style.useEsrgan && this.esrganSupported) {
        if (this.onStatus) this.onStatus(`Real-ESRGAN (M1 GPU) reichert Z${zoom} auf 2048px an…`);
        // 512x512 -> 4x Real-ESRGAN neural super-resolution -> crisp 2048x2048 PNG!
        const inBlob = await this._canvasToJpegBlob(satCanvas, 512);
        const filename = sanitizeCacheFilename(cacheKey);
        const resp = await fetch(
          `/api/ai-upscale?key=${encodeURIComponent(filename)}&model=${encodeURIComponent(style.model)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'image/jpeg' },
            body: inBlob,
          }
        );
        if (!resp.ok) {
          throw new Error(`Real-ESRGAN HTTP ${resp.status}`);
        }
        blob = await resp.blob();
        this.diskFiles.add(filename);
        await this.idb.set(cacheKey, blob);
        await this._refreshCacheStats();
      } else {
        const outCanvas = this._enhanceCanvasLocally(satCanvas, demCanvas, style);
        blob = await new Promise((resolve) => outCanvas.toBlob(resolve, 'image/png'));
        await this._persistBlob(cacheKey, blob);
      }

      const img = await blobToImage(blob);
      this._setRamCache(cacheKey, img);

      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      const label = style.useEsrgan && this.esrganSupported ? 'Real-ESRGAN 2048px' : 'Lokal';
      if (this.onStatus) this.onStatus(`✦ ${label} gespeichert (Z${zoom} · ${sec}s)`);
      return img;
    } finally {
      this.isBusy = false;
    }
  }

  consumePending() {
    const p = this._pending;
    this._pending = null;
    return p;
  }
}
