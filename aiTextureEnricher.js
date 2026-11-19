// Gemini Image API (gemini-2.5-flash-image) Satellite Texture Enricher
// 3-Tier Persistent Cache: RAM -> IndexedDB -> Local Disk (textures/ai_cache/ via server.py)

const STORAGE_KEY = 'terra_gemini_api_key';
const MODEL_ID = 'gemini-2.5-flash-image';
const IDB_NAME = 'terra_ai_textures_v1';
const IDB_STORE = 'patches';

export const AI_STYLES = {
  photoreal: {
    label: 'Fotorealistisch (1:1 Satellit)',
    instruction:
      'Enhance this top-down nadir satellite orthophoto into an ultra-sharp, high-resolution photorealistic aerial photograph. Add realistic fine micro-detail: dense individual tree canopies in forests, crisp rock strata and scree on mountain slopes, natural field textures, sharp rooftops and roads in urban areas, realistic coastal sand, turquoise shallows and subtle ocean waves. Strictly preserve the exact top-down orthographic projection, exact coastline shapes, rivers, mountain ridge positions, and overall color layout pixel-for-pixel. No tilt, no horizon, no borders, no labels, no text, no watermarks.',
  },
  natgeo: {
    label: 'National Geographic (Lebendig)',
    instruction:
      'Transform this top-down nadir satellite orthophoto into a breathtaking, ultra-crisp National Geographic aerial orthophoto with rich natural detail: lush textured forests, dramatic rugged alpine rock faces, crisp snowdrifts, vivid coral/turquoise coastal waters with white shoreline surf, and finely detailed earth and riverbeds. Strictly maintain the exact 1:1 top-down orthographic map alignment, coastlines, rivers, and terrain features so it aligns seamlessly with the underlying 3D elevation map. No tilt, no sky, no borders, no text, no labels.',
  },
  cinematic: {
    label: 'Kino-Detail (Kontrastreich)',
    instruction:
      'Upgrade this top-down nadir satellite orthophoto with cinematic ultra-sharp micro-detail and rich natural contrast: crisp individual trees, sharp rocky cliffs, fine dune and soil patterns, detailed villages and roads, and realistic sparkling water surfaces. Keep the exact 1:1 top-down orthographic alignment of every coastline, river, valley, and ridge unchanged. No perspective tilt, no borders, no text, no watermarks.',
  },
};

function sanitizeCacheFilename(cacheKey) {
  return `${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
}

function base64ToBlob(base64Data, mimeType) {
  const bin = atob(base64Data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
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
      reject(new Error('Gecachtes KI-Bild konnte nicht dekodiert werden.'));
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
    this.apiKey = this._loadKey();
    this.autoEnrich = false;
    this.styleId = 'photoreal';
    this.model = MODEL_ID;

    this.cache = new Map(); // RAM LRU: cacheKey -> HTMLImageElement
    this.maxCache = 32;
    this.idb = new TextureIDB();
    this.diskCacheSupported = false;
    this.diskFiles = new Set(); // Known filenames in textures/ai_cache/
    this.cachedCount = 0;

    this.isBusy = false;
    this._pending = null;
    this.onStatus = null;
    this.onCacheStatsChange = null;
  }

  async initPersistentCache() {
    // Check if local server.py disk cache API is available
    try {
      const resp = await fetch('/api/ai-cache', { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        this.diskCacheSupported = true;
        this.diskFiles = new Set(data.files || []);
      }
    } catch {
      this.diskCacheSupported = false;
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
      });
    }
  }

  _loadKey() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  async loadKeyFromEnv() {
    if (this.hasKey()) return this.apiKey;
    try {
      const resp = await fetch('./.env', { cache: 'no-store' });
      if (!resp.ok) return '';
      const text = await resp.text();
      const match = text.match(/^\s*GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
      if (match && match[1]) {
        this.apiKey = match[1].trim();
        return this.apiKey;
      }
    } catch {
      // .env not present (e.g. hosted on GitHub Pages)
    }
    return '';
  }

  setApiKey(key) {
    this.apiKey = (key || '').trim();
    try {
      if (this.apiKey) {
        localStorage.setItem(STORAGE_KEY, this.apiKey);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }

  hasKey() {
    return this.apiKey.length > 10;
  }

  _makeKey(patchKey) {
    return `${this.styleId}:${patchKey}`;
  }

  getCached(patchKey) {
    return this.cache.get(this._makeKey(patchKey)) || null;
  }

  /**
   * Checks RAM -> IndexedDB -> Local Disk (textures/ai_cache/) for a cached AI patch.
   */
  async getCachedAsync(patchKey) {
    const cacheKey = this._makeKey(patchKey);
    const ramHit = this.cache.get(cacheKey);
    if (ramHit) return ramHit;

    // 1. Check IndexedDB
    const idbBlob = await this.idb.get(cacheKey);
    if (idbBlob) {
      try {
        const img = await blobToImage(idbBlob);
        this._setRamCache(cacheKey, img);
        return img;
      } catch {
        // corrupted blob, ignore
      }
    }

    // 2. Check local disk cache (only if filename is in known diskFiles set -> zero 404s!)
    const filename = sanitizeCacheFilename(cacheKey);
    if (this.diskCacheSupported && this.diskFiles.has(filename)) {
      try {
        const resp = await fetch(`/api/ai-cache/${filename}`, { cache: 'no-store' });
        if (resp.ok) {
          const blob = await resp.blob();
          const img = await blobToImage(blob);
          this._setRamCache(cacheKey, img);
          // Mirror into IndexedDB for faster future loads
          this.idb.set(cacheKey, blob).catch(() => {});
          return img;
        }
      } catch {
        // ignore disk fetch errors
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
        if (resp.ok) {
          this.diskFiles.add(filename);
        }
      } catch {
        // ignore disk write errors
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
    if (this.onStatus) this.onStatus('KI-Textur-Cache geleert.');
  }

  _canvasToBase64Jpeg(srcCanvas, targetSize = 1024) {
    const tmp = document.createElement('canvas');
    tmp.width = targetSize;
    tmp.height = targetSize;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, targetSize, targetSize);
    const dataUrl = tmp.toDataURL('image/jpeg', 0.88);
    return dataUrl.split(',')[1];
  }

  async enrichPatch({ patchKey, satCanvas, latDeg, lonDeg, zoom }) {
    const cacheKey = this._makeKey(patchKey);
    const cached = await this.getCachedAsync(patchKey);
    if (cached) {
      if (this.onStatus) this.onStatus(`✦ Aus lokalem Cache geladen (Z${zoom})`);
      return cached;
    }

    if (!this.hasKey()) {
      throw new Error('Bitte zuerst einen Gemini API-Key eingeben.');
    }

    if (this.isBusy) {
      this._pending = { patchKey, satCanvas, latDeg, lonDeg, zoom };
      return null;
    }

    this.isBusy = true;
    const t0 = performance.now();
    if (this.onStatus) this.onStatus(`Gemini reichert Z${zoom}-Satellitenkacheln an…`);

    try {
      const base64Input = this._canvasToBase64Jpeg(satCanvas, 1024);
      const style = AI_STYLES[this.styleId] || AI_STYLES.photoreal;
      const geoHint = `Location context: latitude ${latDeg.toFixed(2)}°, longitude ${lonDeg.toFixed(2)}°, map zoom level ${zoom}.`;
      const prompt = `${style.instruction} ${geoHint}`;

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const body = {
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: base64Input,
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
        },
      };

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const errJson = await resp.json();
          if (errJson?.error?.message) detail = errJson.error.message;
        } catch {
          // ignore
        }
        throw new Error(detail);
      }

      const json = await resp.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!imgPart) {
        throw new Error('Gemini hat kein Bild zurückgegeben.');
      }

      const mimeType = imgPart.inlineData.mimeType || 'image/png';
      const blob = base64ToBlob(imgPart.inlineData.data, mimeType);
      const img = await blobToImage(blob);

      this._setRamCache(cacheKey, img);
      await this._persistBlob(cacheKey, blob);

      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      const loc = this.diskCacheSupported ? 'Disk + IDB' : 'Browser-Cache';
      if (this.onStatus) this.onStatus(`✦ KI-Textur gespeichert (${loc} · Z${zoom} · ${sec}s)`);
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
