// Gemini Image API (gemini-2.5-flash-image) Satellite Texture Enricher
// Enhances streamed Esri satellite tile patches in-place with photorealistic micro-detail
// while strictly preserving top-down orthophoto geometry (coastlines, rivers, ridges, roads).

const STORAGE_KEY = 'terra_gemini_api_key';
const MODEL_ID = 'gemini-2.5-flash-image';

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

export class AiTextureEnricher {
  constructor() {
    this.apiKey = this._loadKey();
    this.autoEnrich = false;
    this.styleId = 'photoreal';
    this.model = MODEL_ID;

    this.cache = new Map(); // key -> HTMLImageElement
    this.maxCache = 24;
    this.isBusy = false;
    this._pending = null; // latest queued job if autoEnrich fires while busy
    this.onStatus = null;
  }

  _loadKey() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch {
      return '';
    }
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

  getCached(patchKey) {
    return this.cache.get(`${this.styleId}:${patchKey}`) || null;
  }

  _setCache(cacheKey, img) {
    if (this.cache.has(cacheKey)) this.cache.delete(cacheKey);
    this.cache.set(cacheKey, img);
    if (this.cache.size > this.maxCache) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
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

  _loadBase64Image(mimeType, base64Data) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('KI-Bild konnte nicht dekodiert werden.'));
      img.src = `data:${mimeType};base64,${base64Data}`;
    });
  }

  /**
   * Enrich a 2048x2048 satellite tile patch using Gemini Image API.
   * Returns an HTMLImageElement or throws on error.
   */
  async enrichPatch({ patchKey, satCanvas, latDeg, lonDeg, zoom }) {
    if (!this.hasKey()) {
      throw new Error('Bitte zuerst einen Gemini API-Key eingeben.');
    }

    const cacheKey = `${this.styleId}:${patchKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (this.onStatus) this.onStatus(`KI-Cache geladen (Z${zoom})`);
      return cached;
    }

    if (this.isBusy) {
      // Coalesce rapid flight updates: keep only the latest queued patch
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
          // ignore parse error
        }
        throw new Error(detail);
      }

      const json = await resp.json();
      const parts = json?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!imgPart) {
        throw new Error('Gemini hat kein Bild zurückgegeben (evtl. Safety-Filter oder Modell-Limit).');
      }

      const img = await this._loadBase64Image(
        imgPart.inlineData.mimeType || 'image/png',
        imgPart.inlineData.data
      );
      this._setCache(cacheKey, img);

      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      if (this.onStatus) this.onStatus(`✦ KI-Textur aktiv (Z${zoom} · ${sec}s)`);
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
