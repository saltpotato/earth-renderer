import { fullscreenVert, earthRaytraceFrag, displayFrag } from './shaders.js';
import { DynamicTileStreamer } from './tileStreamer.js';

const CDN_TEXTURES = {
  day: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/earth_day_4096.jpg',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_atmos_2048.jpg',
  ],
  night: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/earth_night_4096.jpg',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_lights_2048.jpg',
  ],
  brc: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/earth_bump_roughness_clouds_4096.jpg',
  ],
  moon: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/moon_1024.jpg',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/moon_1024.jpg',
  ],
};

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile error:\n${info}`);
  }
  return shader;
}

function createProgram(gl, vertSrc, fragSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`Program link error:\n${info}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function loadImageWithFallback(urls) {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= urls.length) {
        reject(new Error('All texture sources failed'));
        return;
      }
      const url = urls[idx++];
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve({ img, url });
      img.onerror = () => tryNext();
      img.src = url;
    };
    tryNext();
  });
}

function createProceduralFallbackCanvas(type) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (type === 'day') {
    ctx.fillStyle = '#0c2344';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#3b6e4c';
    for (let i = 0; i < 40; i++) {
      ctx.beginPath();
      ctx.arc(
        (Math.sin(i * 12.7) * 0.5 + 0.5) * c.width,
        (Math.cos(i * 7.3) * 0.4 + 0.5) * c.height,
        18 + (i % 5) * 10,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  } else if (type === 'moon') {
    ctx.fillStyle = '#7e7d78';
    ctx.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = i % 2 === 0 ? 'rgba(60,60,60,0.35)' : 'rgba(190,190,185,0.25)';
      ctx.beginPath();
      ctx.arc(
        (Math.sin(i * 19.1) * 0.5 + 0.5) * c.width,
        (Math.cos(i * 11.7) * 0.48 + 0.5) * c.height,
        3 + (i % 9) * 3,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  } else if (type === 'night') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, c.width, c.height);
  } else {
    ctx.fillStyle = 'rgb(128, 64, 0)';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

function pickBestVideoMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return '';
}

export class EarthRaytracer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('WebGL2 wird von diesem Browser nicht unterstützt.');
    }
    this.gl = gl;

    this.extFloat = gl.getExtension('EXT_color_buffer_float');
    this.extHalfFloat = gl.getExtension('EXT_color_buffer_half_float');
    this.extFloatLinear = gl.getExtension('OES_texture_float_linear');
    this.extHalfFloatLinear = gl.getExtension('OES_texture_half_float_linear');

    this.rayProgram = createProgram(gl, fullscreenVert, earthRaytraceFrag);
    this.displayProgram = createProgram(gl, fullscreenVert, displayFrag);
    this.vao = gl.createVertexArray();

    this.uRay = this._getUniforms(this.rayProgram, [
      'uResolution', 'uCamPos', 'uCamAlt', 'uCamForward', 'uCamRight', 'uCamUp', 'uTanHalfFov',
      'uSunDir', 'uEarthRot', 'uCloudOffset', 'uTime',
      'uAtmoDensity', 'uAtmoHeight', 'uCloudCover', 'uCloudShadow',
      'uBumpStrength', 'uOceanSpec', 'uNightLights', 'uStarsIntensity', 'uAuroraIntensity',
      'uMoonEnabled', 'uMoonPos', 'uMoonRadius',
      'uSampleIndex', 'uHighQuality', 'uHasCustomClouds',
      'uTileBounds', 'uTileRef', 'uTileBlend', 'uTerrainExag',
      'uDayTex', 'uNightTex', 'uBrcTex', 'uCloudTex', 'uMoonTex', 'uTileSatTex', 'uTileDemTex',
    ]);
    this.uDisp = this._getUniforms(this.displayProgram, [
      'uAccumTex', 'uResolution', 'uExposure',
    ]);

    this.textures = {
      day: this._createEmptyTexture([12, 32, 68, 255]),
      night: this._createEmptyTexture([0, 0, 0, 255]),
      brc: this._createEmptyTexture([128, 50, 0, 255]),
      clouds: this._createEmptyTexture([0, 0, 0, 255]),
      moon: this._createEmptyTexture([130, 128, 122, 255]),
      tileSat: this._createEmptyTexture([12, 32, 68, 255], true),
      tileDem: this._createEmptyTexture([128, 0, 0, 255], true),
    };
    this.hasCustomClouds = false;
    this.textureTier = '4K CDN';

    // Dynamic Deep-Zoom Tile Streamer (Esri World Imagery + AWS Terrarium DEM)
    this.onTileStatusChange = null;
    this.tileStreamer = new DynamicTileStreamer(({ satCanvas, demCanvas, zoom }) => {
      this._uploadTexture(this.textures.tileSat, satCanvas, true);
      this._uploadTexture(this.textures.tileDem, demCanvas, true);
      if (this.onTileStatusChange) {
        this.onTileStatusChange({ zoom, loading: false });
      }
    });

    // Smooth Deep-Zoom flight animation state
    this.flight = null;

    // Scene state
    this.state = {
      camYaw: 0.28,
      camPitch: 0.44,
      camDist: 3.45,
      camTiltDeg: 0,
      camHeadingDeg: 0,
      camTargetOffset: [0, 0, 0],
      fovDeg: 38,

      sunAzDeg: -58,
      sunElDeg: 14,
      earthRot: 0,
      cloudOffsetDeg: 0,
      time: 0,

      atmoDensity: 1.00,
      atmoHeight: 1.05,
      cloudCover: 0.90,
      cloudShadow: 0.85,
      bumpStrength: 1.35,
      terrainExag: 1.60,
      oceanSpec: 1.15,
      nightLights: 1.65,
      starsIntensity: 1.10,
      auroraIntensity: 0.90,
      exposure: 1.05,
      autoRotate: false,

      moonEnabled: true,
      moonAngleDeg: -124,
      moonDist: 6.2,
    };

    // Accumulation FBO
    this.accumFbo = null;
    this.accumTex = null;
    this.accumWidth = 0;
    this.accumHeight = 0;

    // Still render state
    this.mode = 'live'; // 'live' | 'rendering' | 'done' | 'video' | 'video-done'
    this.renderTargetSpp = 48;
    this.renderCurrentSpp = 0;
    this.renderStartTime = 0;
    this.onRenderProgress = null;
    this.onRenderComplete = null;

    // Video render state
    this.videoJob = null;
    this.lastVideoBlobUrl = null;
    this.lastVideoExt = 'webm';
    this.onVideoProgress = null;
    this.onVideoComplete = null;

    this.resize();
  }

  _getUniforms(program, names) {
    const map = {};
    for (const n of names) {
      map[n] = this.gl.getUniformLocation(program, n);
    }
    return map;
  }

  _createEmptyTexture(rgba, clampS = false) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clampS ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  _uploadTexture(tex, source, clampS = false) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clampS ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  async loadDefaultTextures(onStatus) {
    let manifest = null;
    try {
      const resp = await fetch('./textures/local_manifest.json', { cache: 'no-store' });
      if (resp.ok) {
        manifest = await resp.json();
      }
    } catch {
      manifest = null;
    }

    const use8k = Boolean(manifest && manifest.useLocal8k);
    this.textureTier = use8k ? '8K LOKAL' : '4K CDN';

    const sources = {
      day: use8k && manifest.day ? [manifest.day, ...CDN_TEXTURES.day] : CDN_TEXTURES.day,
      night: use8k && manifest.night ? [manifest.night, ...CDN_TEXTURES.night] : CDN_TEXTURES.night,
      brc: CDN_TEXTURES.brc,
      moon: use8k && manifest.moon ? [manifest.moon, ...CDN_TEXTURES.moon] : CDN_TEXTURES.moon,
    };

    const entries = [
      ['day', sources.day, use8k ? 'Lade lokale 8K Tag-Map…' : 'Lade 4K Tag-Satellitenkarte…'],
      ['night', sources.night, use8k ? 'Lade lokale 8K Nachtlichter…' : 'Lade 4K Nachtlichter…'],
      ['brc', sources.brc, 'Lade 4K Relief- & Ozeankarte…'],
      ['moon', sources.moon, use8k ? 'Lade lokale 8K Mond-Map…' : 'Lade Mond-Textur…'],
    ];

    if (use8k && manifest.clouds) {
      entries.push(['clouds', [manifest.clouds], 'Lade lokale 8K Wolkenkarte…']);
    }

    await Promise.all(
      entries.map(async ([key, urls, msg]) => {
        try {
          if (onStatus) onStatus(msg);
          const { img } = await loadImageWithFallback(urls);
          this._uploadTexture(this.textures[key], img);
          if (key === 'clouds') {
            this.hasCustomClouds = true;
          }
        } catch (err) {
          console.warn(`Fallback procedural texture used for ${key}:`, err);
          if (key !== 'clouds') {
            this._uploadTexture(this.textures[key], createProceduralFallbackCanvas(key));
          }
        }
      })
    );

    return this.textureTier;
  }

  loadCustomTexture(slot, file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        if (slot === 'clouds') {
          this._uploadTexture(this.textures.clouds, img);
          this.hasCustomClouds = true;
        } else if (this.textures[slot]) {
          this._uploadTexture(this.textures[slot], img);
        }
        URL.revokeObjectURL(url);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = (e) => {
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src = url;
    });
  }

  _ensureAccumFbo(width, height) {
    if (this.accumFbo && this.accumWidth === width && this.accumHeight === height) {
      return;
    }
    const gl = this.gl;
    if (this.accumTex) gl.deleteTexture(this.accumTex);
    if (this.accumFbo) gl.deleteFramebuffer(this.accumFbo);

    const formats = [];
    if (this.extFloat) {
      formats.push({
        internal: gl.RGBA32F,
        type: gl.FLOAT,
        filter: this.extFloatLinear ? gl.LINEAR : gl.NEAREST,
      });
    }
    if (this.extFloat || this.extHalfFloat) {
      formats.push({
        internal: gl.RGBA16F,
        type: gl.HALF_FLOAT,
        filter: (this.extHalfFloatLinear || this.extFloatLinear) ? gl.LINEAR : gl.NEAREST,
      });
    }
    formats.push({
      internal: gl.RGBA8,
      type: gl.UNSIGNED_BYTE,
      filter: gl.LINEAR,
    });

    for (const fmt of formats) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, width, height, 0, gl.RGBA, fmt.type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, fmt.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, fmt.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        this.accumTex = tex;
        this.accumFbo = fbo;
        this.accumWidth = width;
        this.accumHeight = height;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return;
      }
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
    }
    throw new Error('Konnte keinen WebGL2 Framebuffer erstellen.');
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.mode === 'live') {
      this._ensureAccumFbo(w, h);
    }
  }

  _computeCameraBasis() {
    const { camYaw, camPitch, camDist, camTiltDeg, camHeadingDeg, camTargetOffset } = this.state;
    const cp = Math.cos(camPitch);
    const sp = Math.sin(camPitch);
    const sy = Math.sin(camYaw);
    const cy = Math.cos(camYaw);

    // Ground point unit normal G on unit sphere
    const gx = cp * sy;
    const gy = sp;
    const gz = cp * cy;
    const alt = Math.max(0.000028, camDist - 1.0);

    // If camTargetOffset is non-zero (e.g. ISS horizon preset), keep classic offset orbit
    const hasOffset =
      camTargetOffset[0] !== 0 || camTargetOffset[1] !== 0 || camTargetOffset[2] !== 0;

    if (hasOffset && Math.abs(camTiltDeg) < 0.01 && Math.abs(camHeadingDeg) < 0.01) {
      const pos = [camDist * gx, camDist * gy, camDist * gz];
      let fx = camTargetOffset[0] - pos[0];
      let fy = camTargetOffset[1] - pos[1];
      let fz = camTargetOffset[2] - pos[2];
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;

      let rx = -fz;
      let ry = 0;
      let rz = fx;
      const rl = Math.hypot(rx, ry, rz) || 1;
      rx /= rl; ry /= rl; rz /= rl;

      const ux = ry * fz - rz * fy;
      const uy = rz * fx - rx * fz;
      const uz = rx * fy - ry * fx;

      return { pos, camAlt: alt, forward: [fx, fy, fz], right: [rx, ry, rz], up: [ux, uy, uz] };
    }

    // Local tangent frame at ground point G: East (E) and North (No)
    let ex = gz;
    let ey = 0;
    let ez = -gx;
    const el = Math.hypot(ex, ey, ez) || 1;
    ex /= el; ez /= el;

    // North = cross(G, E)
    const nx = gy * ez - gz * ey;
    const ny = gz * ex - gx * ez;
    const nz = gx * ey - gy * ex;

    const head = (camHeadingDeg * Math.PI) / 180;
    const tilt = (Math.max(0, Math.min(78, camTiltDeg)) * Math.PI) / 180;
    const ch = Math.cos(head);
    const sh = Math.sin(head);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);

    // Horizontal look direction H on tangent plane
    const hx = ch * nx + sh * ex;
    const hy = ch * ny + sh * ey;
    const hz = ch * nz + sh * ez;

    // Vector from ground point G to camera
    const dcx = ct * gx - st * hx;
    const dcy = ct * gy - st * hy;
    const dcz = ct * gz - st * hz;

    const pos = [
      gx + dcx * alt,
      gy + dcy * alt,
      gz + dcz * alt,
    ];

    // Exact float64 radial altitude |pos| - 1 without catastrophic cancellation
    const q = 2 * alt * ct + alt * alt;
    const camAlt = q / (Math.sqrt(1 + q) + 1);

    const fx = -dcx;
    const fy = -dcy;
    const fz = -dcz;

    // Right = normalize(cross(H, G)) -> smooth & pole-free for all tilts 0..78 deg
    let rx = hy * gz - hz * gy;
    let ry = hz * gx - hx * gz;
    let rz = hx * gy - hy * gx;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    // Up = cross(right, forward)
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    return {
      pos,
      camAlt,
      forward: [fx, fy, fz],
      right: [rx, ry, rz],
      up: [ux, uy, uz],
    };
  }

  _computeSunDir() {
    const az = (this.state.sunAzDeg * Math.PI) / 180;
    const el = (this.state.sunElDeg * Math.PI) / 180;
    const ce = Math.cos(el);
    return [ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)];
  }

  _computeMoonPos() {
    const ang = (this.state.moonAngleDeg * Math.PI) / 180;
    const d = this.state.moonDist;
    return [
      d * Math.sin(ang),
      d * Math.cos(ang * 0.5) * 0.18 + 0.65,
      d * Math.cos(ang),
    ];
  }

  getCameraLatLon() {
    const latDeg = (this.state.camPitch * 180) / Math.PI;
    let lonDeg = ((this.state.camYaw + this.state.earthRot) * 180) / Math.PI;
    lonDeg = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
    return { latDeg, lonDeg, alt: this.state.camDist - 1.0 };
  }

  flyToLocation(
    latDeg,
    lonDeg,
    targetAltKm = 8,
    durationSec = 4.2,
    startFromSpace = true,
    targetTiltDeg = 0,
    targetHeadingDeg = 0
  ) {
    const targetPitch = (latDeg * Math.PI) / 180;
    const targetYaw = (lonDeg * Math.PI) / 180 - this.state.earthRot;
    let deltaYaw = targetYaw - this.state.camYaw;
    while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
    while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;

    const startAlt = startFromSpace
      ? Math.max(this.state.camDist - 1.0, 1.85)
      : Math.max(0.000028, this.state.camDist - 1.0);
    const endAlt = Math.max(0.000028, targetAltKm / 6371);

    const targetSunAz = ((((lonDeg - 42 + 180) % 360) + 360) % 360) - 180;
    const targetSunEl = Math.max(12, Math.min(34, latDeg * 0.45 + 12));

    this.flight = {
      elapsed: 0,
      duration: durationSec,
      startYaw: this.state.camYaw,
      endYaw: this.state.camYaw + deltaYaw,
      startPitch: this.state.camPitch,
      endPitch: targetPitch,
      startLogAlt: Math.log(startAlt),
      endLogAlt: Math.log(endAlt),
      startTilt: this.state.camTiltDeg,
      endTilt: targetTiltDeg,
      startHeading: this.state.camHeadingDeg,
      endHeading: targetHeadingDeg,
      startSunAz: this.state.sunAzDeg,
      endSunAz: targetSunAz,
      startSunEl: this.state.sunElDeg,
      endSunEl: targetSunEl,
    };
    this.state.camTargetOffset = [0, 0, 0];
    this.state.camDist = 1.0 + startAlt;
  }

  cancelFlight() {
    this.flight = null;
  }

  _bindRayUniforms(width, height, sampleIndex, highQuality) {
    const gl = this.gl;
    const cam = this._computeCameraBasis();
    const sun = this._computeSunDir();
    const moonPos = this._computeMoonPos();
    const tanHalfFov = Math.tan(((this.state.fovDeg * Math.PI) / 180) * 0.5);
    const camAlt = Math.max(0.000015, cam.camAlt);

    let tileBlend = 0.0;
    if (this.tileStreamer.enabled && this.tileStreamer.hasValidPatch && camAlt < 0.62) {
      const t = Math.max(0, Math.min(1, (0.58 - camAlt) / 0.34));
      tileBlend = t * t * (3 - 2 * t);
    }

    gl.useProgram(this.rayProgram);
    gl.uniform2f(this.uRay.uResolution, width, height);
    gl.uniform3fv(this.uRay.uCamPos, cam.pos);
    gl.uniform1f(this.uRay.uCamAlt, camAlt);
    gl.uniform3fv(this.uRay.uCamForward, cam.forward);
    gl.uniform3fv(this.uRay.uCamRight, cam.right);
    gl.uniform3fv(this.uRay.uCamUp, cam.up);
    gl.uniform1f(this.uRay.uTanHalfFov, tanHalfFov);

    gl.uniform3fv(this.uRay.uSunDir, sun);
    gl.uniform1f(this.uRay.uEarthRot, this.state.earthRot);
    gl.uniform1f(this.uRay.uCloudOffset, (this.state.cloudOffsetDeg * Math.PI) / 180);
    gl.uniform1f(this.uRay.uTime, this.state.time);

    gl.uniform1f(this.uRay.uAtmoDensity, this.state.atmoDensity);
    gl.uniform1f(this.uRay.uAtmoHeight, this.state.atmoHeight);
    gl.uniform1f(this.uRay.uCloudCover, this.state.cloudCover);
    gl.uniform1f(this.uRay.uCloudShadow, this.state.cloudShadow);
    gl.uniform1f(this.uRay.uBumpStrength, this.state.bumpStrength);
    gl.uniform1f(this.uRay.uOceanSpec, this.state.oceanSpec);
    gl.uniform1f(this.uRay.uNightLights, this.state.nightLights);
    gl.uniform1f(this.uRay.uStarsIntensity, this.state.starsIntensity);
    gl.uniform1f(this.uRay.uAuroraIntensity, this.state.auroraIntensity);

    gl.uniform1i(this.uRay.uMoonEnabled, this.state.moonEnabled ? 1 : 0);
    gl.uniform3fv(this.uRay.uMoonPos, moonPos);
    gl.uniform1f(this.uRay.uMoonRadius, 0.2725);

    gl.uniform1i(this.uRay.uSampleIndex, sampleIndex);
    gl.uniform1i(this.uRay.uHighQuality, highQuality ? 1 : 0);
    gl.uniform1i(this.uRay.uHasCustomClouds, this.hasCustomClouds ? 1 : 0);

    gl.uniform4fv(this.uRay.uTileBounds, this.tileStreamer.activeBounds);
    gl.uniform4fv(this.uRay.uTileRef, this.tileStreamer.activeRef);
    gl.uniform1f(this.uRay.uTileBlend, tileBlend);
    gl.uniform1f(this.uRay.uTerrainExag, this.state.terrainExag);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.day);
    gl.uniform1i(this.uRay.uDayTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.night);
    gl.uniform1i(this.uRay.uNightTex, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.brc);
    gl.uniform1i(this.uRay.uBrcTex, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.clouds);
    gl.uniform1i(this.uRay.uCloudTex, 3);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.moon);
    gl.uniform1i(this.uRay.uMoonTex, 4);

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.tileSat);
    gl.uniform1i(this.uRay.uTileSatTex, 5);

    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.tileDem);
    gl.uniform1i(this.uRay.uTileDemTex, 6);
  }

  _drawDisplayToTarget(targetFbo, targetW, targetH, preserveAspect) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo);
    gl.disable(gl.BLEND);

    if (preserveAspect) {
      gl.viewport(0, 0, targetW, targetH);
      gl.clearColor(0.01, 0.015, 0.03, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      const srcAspect = this.accumWidth / this.accumHeight;
      const dstAspect = targetW / targetH;
      let vw = targetW;
      let vh = targetH;
      let vx = 0;
      let vy = 0;
      if (srcAspect > dstAspect) {
        vh = Math.round(targetW / srcAspect);
        vy = Math.round((targetH - vh) * 0.5);
      } else {
        vw = Math.round(targetH * srcAspect);
        vx = Math.round((targetW - vw) * 0.5);
      }
      gl.viewport(vx, vy, vw, vh);
    } else {
      gl.viewport(0, 0, targetW, targetH);
    }

    gl.useProgram(this.displayProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTex);
    gl.uniform1i(this.uDisp.uAccumTex, 0);
    gl.uniform2f(this.uDisp.uResolution, this.accumWidth, this.accumHeight);
    gl.uniform1f(this.uDisp.uExposure, this.state.exposure);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _renderSampleToAccum(sampleIndex, highQuality) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
    gl.viewport(0, 0, this.accumWidth, this.accumHeight);

    if (sampleIndex === 0) {
      gl.disable(gl.BLEND);
    } else {
      const alpha = 1.0 / (sampleIndex + 1);
      gl.enable(gl.BLEND);
      gl.blendColor(0, 0, 0, alpha);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    }

    this._bindRayUniforms(this.accumWidth, this.accumHeight, sampleIndex, highQuality);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  _readTonemappedTo2DCanvas(outCanvas, outCtx, scratchFbo, scratchPixels, imgData) {
    const gl = this.gl;
    const w = outCanvas.width;
    const h = outCanvas.height;

    this._drawDisplayToTarget(scratchFbo, w, h, false);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, scratchPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const rowSize = w * 4;
    for (let y = 0; y < h; y++) {
      const srcOffset = (h - 1 - y) * rowSize;
      const dstOffset = y * rowSize;
      imgData.data.set(scratchPixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
    }
    outCtx.putImageData(imgData, 0, 0);
  }

  _applyVideoKeyframe(job, progress) {
    const base = job.baseState;
    const smooth = progress * progress * (3 - 2 * progress);
    this.state.time = base.time + progress * job.durationSec;

    if (job.animType === 'deep-zoom') {
      // Exponential Space-to-City Deep Zoom: ~14,000 km -> ~6 km altitude
      const startLogAlt = Math.log(2.20);
      const endLogAlt = Math.log(6 / 6371);
      const ease = 1 - Math.pow(1 - smooth, 1.35);
      const alt = Math.exp(startLogAlt + (endLogAlt - startLogAlt) * ease);
      this.state.camDist = 1.0 + alt;
      this.state.camYaw = base.camYaw;
      this.state.camPitch = base.camPitch;
      this.state.camTargetOffset = [0, 0, 0];
      this.state.cloudOffsetDeg = base.cloudOffsetDeg + progress * 3;
    } else if (job.animType === 'sunrise') {
      this.state.sunAzDeg = base.sunAzDeg - 55 + progress * 110;
      this.state.sunElDeg = base.sunElDeg - 6 + Math.sin(progress * Math.PI) * 14;
      this.state.cloudOffsetDeg = base.cloudOffsetDeg + progress * 6;
    } else if (job.animType === 'orbit') {
      this.state.camYaw = base.camYaw + progress * 0.95;
      this.state.camPitch = base.camPitch + Math.sin(progress * Math.PI) * 0.16;
      this.state.cloudOffsetDeg = base.cloudOffsetDeg + progress * 8;
    } else if (job.animType === 'iss-flyover') {
      this.state.camDist = 1.24;
      this.state.fovDeg = 52;
      this.state.camYaw = base.camYaw - 0.35 + smooth * 0.85;
      this.state.camPitch = 0.58 + Math.sin(progress * Math.PI) * 0.18;
      this.state.camTargetOffset = [0.28, 0.20, -0.12];
      this.state.cloudOffsetDeg = base.cloudOffsetDeg + progress * 5;
    } else if (job.animType === 'rotation-moon') {
      this.state.earthRot = base.earthRot + progress * 0.65;
      this.state.cloudOffsetDeg = base.cloudOffsetDeg + progress * 10;
      this.state.moonAngleDeg = base.moonAngleDeg + progress * 24;
    }
  }

  tick(dt) {
    if (this.mode === 'live') {
      this.state.time += dt;
      if (this.flight) {
        this.flight.elapsed += dt;
        const p = Math.min(1, this.flight.elapsed / this.flight.duration);
        const s = p * p * (3 - 2 * p);
        // Ease tilt in mostly during the second half of the descent for a cinematic swoop!
        const tiltEase = Math.max(0, Math.min(1, (p - 0.35) / 0.65));
        const ts = tiltEase * tiltEase * (3 - 2 * tiltEase);
        this.state.camYaw = this.flight.startYaw + (this.flight.endYaw - this.flight.startYaw) * s;
        this.state.camPitch = this.flight.startPitch + (this.flight.endPitch - this.flight.startPitch) * s;
        const logAlt = this.flight.startLogAlt + (this.flight.endLogAlt - this.flight.startLogAlt) * s;
        this.state.camDist = 1.0 + Math.exp(logAlt);
        this.state.camTiltDeg = this.flight.startTilt + (this.flight.endTilt - this.flight.startTilt) * ts;
        this.state.camHeadingDeg = this.flight.startHeading + (this.flight.endHeading - this.flight.startHeading) * s;
        this.state.sunAzDeg = this.flight.startSunAz + (this.flight.endSunAz - this.flight.startSunAz) * s;
        this.state.sunElDeg = this.flight.startSunEl + (this.flight.endSunEl - this.flight.startSunEl) * s;
        if (this.onFlightUpdate) this.onFlightUpdate();
        if (p >= 1) this.flight = null;
      } else if (this.state.autoRotate) {
        this.state.earthRot += dt * 0.04;
      }

      // Stream dynamic Esri + Terrarium tiles automatically when zoomed in
      const { latDeg, lonDeg, alt } = this.getCameraLatLon();
      this.tileStreamer.updateForCamera(latDeg, lonDeg, alt, this.state.fovDeg);

      this._ensureAccumFbo(this.canvas.width, this.canvas.height);
      this._renderSampleToAccum(0, false);
      this._drawDisplayToTarget(null, this.canvas.width, this.canvas.height, false);
    } else if (this.mode === 'rendering') {
      const s = this.renderCurrentSpp;
      this._renderSampleToAccum(s, true);
      this.renderCurrentSpp++;
      this._drawDisplayToTarget(null, this.canvas.width, this.canvas.height, true);

      const elapsed = (performance.now() - this.renderStartTime) / 1000;
      if (this.onRenderProgress) {
        this.onRenderProgress(this.renderCurrentSpp, this.renderTargetSpp, elapsed);
      }

      if (this.renderCurrentSpp >= this.renderTargetSpp) {
        this.mode = 'done';
        if (this.onRenderComplete) {
          this.onRenderComplete(this.accumWidth, this.accumHeight, this.renderTargetSpp, elapsed);
        }
      }
    } else if (this.mode === 'done' || this.mode === 'video-done') {
      this._drawDisplayToTarget(null, this.canvas.width, this.canvas.height, true);
    } else if (this.mode === 'video' && this.videoJob) {
      this._tickVideoRender();
    }
  }

  async startOfflineRender(width, height, spp) {
    this.cancelFlight();
    const { latDeg, lonDeg, alt } = this.getCameraLatLon();
    if (alt < 0.62 && this.tileStreamer.enabled) {
      await this.tileStreamer.ensureReady(latDeg, lonDeg, alt, this.state.fovDeg);
    }
    this._ensureAccumFbo(width, height);
    this.mode = 'rendering';
    this.renderTargetSpp = spp;
    this.renderCurrentSpp = 0;
    this.renderStartTime = performance.now();
  }

  startVideoRender({ width, height, fps, durationSec, sppPerFrame, animType }) {
    const mimeType = pickBestVideoMimeType();
    if (!mimeType) {
      throw new Error('MediaRecorder wird von diesem Browser nicht unterstützt.');
    }

    this._ensureAccumFbo(width, height);
    const totalFrames = Math.max(2, Math.round(fps * durationSec));

    const gl = this.gl;
    const outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const outFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const outCtx = outCanvas.getContext('2d');
    const imgData = outCtx.createImageData(width, height);
    const scratchPixels = new Uint8Array(width * height * 4);

    const stream = outCanvas.captureStream(0);
    const videoTrack = stream.getVideoTracks()[0];
    const bps = width >= 3840 ? 28_000_000 : width >= 2560 ? 18_000_000 : 12_000_000;
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bps,
    });
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const baseState = {
      ...this.state,
      camTargetOffset: [...this.state.camTargetOffset],
    };

    this.videoJob = {
      width,
      height,
      fps,
      durationSec,
      sppPerFrame,
      animType,
      totalFrames,
      currentFrame: 0,
      currentSpp: 0,
      waitingForTiles: false,
      startTime: performance.now(),
      mimeType,
      outTex,
      outFbo,
      outCanvas,
      outCtx,
      imgData,
      scratchPixels,
      stream,
      videoTrack,
      recorder,
      chunks,
      baseState,
    };

    recorder.start();
    this.mode = 'video';
    this._applyVideoKeyframe(this.videoJob, 0);
  }

  _tickVideoRender() {
    const job = this.videoJob;
    if (!job || job.waitingForTiles) return;

    // Ensure high-res satellite/DEM tiles are loaded before raytracing a low-altitude frame
    if (job.currentSpp === 0 && this.tileStreamer.enabled) {
      const { latDeg, lonDeg, alt } = this.getCameraLatLon();
      if (alt < 0.62) {
        job.waitingForTiles = true;
        this.tileStreamer.ensureReady(latDeg, lonDeg, alt, this.state.fovDeg).then(() => {
          if (this.videoJob === job) {
            job.waitingForTiles = false;
          }
        });
        return;
      }
    }

    // Accumulate samples for the current video frame (up to 2 samples per animation frame)
    const batch = job.width >= 2560 ? 1 : 2;
    for (let b = 0; b < batch && job.currentSpp < job.sppPerFrame; b++) {
      this._renderSampleToAccum(job.currentSpp, true);
      job.currentSpp++;
    }

    this._drawDisplayToTarget(null, this.canvas.width, this.canvas.height, true);

    if (job.currentSpp >= job.sppPerFrame) {
      // Frame complete: push into MediaRecorder stream
      this._readTonemappedTo2DCanvas(
        job.outCanvas,
        job.outCtx,
        job.outFbo,
        job.scratchPixels,
        job.imgData
      );
      if (job.videoTrack && typeof job.videoTrack.requestFrame === 'function') {
        job.videoTrack.requestFrame();
      }

      job.currentFrame++;
      job.currentSpp = 0;

      const elapsed = (performance.now() - job.startTime) / 1000;
      if (this.onVideoProgress) {
        this.onVideoProgress(job.currentFrame, job.totalFrames, elapsed);
      }

      if (job.currentFrame >= job.totalFrames) {
        this._finishVideoRender(false);
        return;
      }

      const progress = job.currentFrame / (job.totalFrames - 1);
      this._applyVideoKeyframe(job, progress);
    }
  }

  _finishVideoRender(cancelled) {
    const job = this.videoJob;
    if (!job) return;

    const gl = this.gl;
    gl.deleteFramebuffer(job.outFbo);
    gl.deleteTexture(job.outTex);

    // Restore original scene state
    Object.assign(this.state, {
      ...job.baseState,
      camTargetOffset: [...job.baseState.camTargetOffset],
    });

    const elapsed = (performance.now() - job.startTime) / 1000;
    const ext = job.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const { width, height, totalFrames, fps } = job;

    job.recorder.onstop = () => {
      job.stream.getTracks().forEach((t) => t.stop());
      if (!cancelled) {
        if (this.lastVideoBlobUrl) URL.revokeObjectURL(this.lastVideoBlobUrl);
        const blob = new Blob(job.chunks, { type: job.mimeType });
        this.lastVideoBlobUrl = URL.createObjectURL(blob);
        this.lastVideoExt = ext;
        if (this.onVideoComplete) {
          this.onVideoComplete({ width, height, totalFrames, fps, elapsed, ext });
        }
      }
    };

    if (job.recorder.state !== 'inactive') {
      job.recorder.stop();
    }
    this.videoJob = null;
    this.mode = cancelled ? 'live' : 'video-done';
    if (cancelled) {
      this.resize();
    }
  }

  downloadLastVideo() {
    if (!this.lastVideoBlobUrl) return;
    const a = document.createElement('a');
    a.href = this.lastVideoBlobUrl;
    a.download = `terra-raytrace-sequence-${this.accumWidth}x${this.accumHeight}.${this.lastVideoExt}`;
    a.click();
  }

  returnToLive() {
    if (this.mode === 'video' && this.videoJob) {
      this._finishVideoRender(true);
      return;
    }
    this.mode = 'live';
    this.resize();
  }

  exportPng() {
    const gl = this.gl;
    const w = this.accumWidth;
    const h = this.accumHeight;

    const outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const outFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const outCtx = outCanvas.getContext('2d');
    const imgData = outCtx.createImageData(w, h);
    const pixels = new Uint8Array(w * h * 4);

    this._readTonemappedTo2DCanvas(outCanvas, outCtx, outFbo, pixels, imgData);

    gl.deleteFramebuffer(outFbo);
    gl.deleteTexture(outTex);

    outCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `terra-raytrace-${w}x${h}-${this.renderCurrentSpp}spp.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }
}
