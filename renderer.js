import { fullscreenVert, earthRaytraceFrag, displayFrag } from './shaders.js';

const TEXTURE_SOURCES = {
  day: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/earth_day_4096.jpg',
    './textures/earth_day_4096.jpg',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_atmos_2048.jpg',
  ],
  night: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/earth_night_4096.jpg',
    './textures/earth_night_4096.jpg',
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/textures/planets/earth_lights_2048.jpg',
  ],
  brc: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r175/examples/textures/planets/earth_bump_roughness_clouds_4096.jpg',
    './textures/earth_bump_roughness_clouds_4096.jpg',
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
  } else if (type === 'night') {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, c.width, c.height);
  } else {
    // BRC: R=bump(0.5), G=roughness(0.25), B=clouds(0.0)
    ctx.fillStyle = 'rgb(128, 64, 0)';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
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

    // Float framebuffer support
    this.extFloat = gl.getExtension('EXT_color_buffer_float');
    this.extHalfFloat = gl.getExtension('EXT_color_buffer_half_float');
    this.extFloatLinear = gl.getExtension('OES_texture_float_linear');
    this.extHalfFloatLinear = gl.getExtension('OES_texture_half_float_linear');

    this.rayProgram = createProgram(gl, fullscreenVert, earthRaytraceFrag);
    this.displayProgram = createProgram(gl, fullscreenVert, displayFrag);
    this.vao = gl.createVertexArray();

    // Cache uniform locations
    this.uRay = this._getUniforms(this.rayProgram, [
      'uResolution', 'uCamPos', 'uCamForward', 'uCamRight', 'uCamUp', 'uTanHalfFov',
      'uSunDir', 'uEarthRot', 'uCloudOffset',
      'uAtmoDensity', 'uAtmoHeight', 'uCloudCover', 'uCloudShadow',
      'uBumpStrength', 'uOceanSpec', 'uNightLights', 'uStarsIntensity',
      'uSampleIndex', 'uHighQuality', 'uHasCustomClouds',
      'uDayTex', 'uNightTex', 'uBrcTex', 'uCloudTex',
    ]);
    this.uDisp = this._getUniforms(this.displayProgram, [
      'uAccumTex', 'uResolution', 'uExposure',
    ]);

    // Textures
    this.textures = {
      day: this._createEmptyTexture([12, 32, 68, 255]),
      night: this._createEmptyTexture([0, 0, 0, 255]),
      brc: this._createEmptyTexture([128, 50, 0, 255]),
      clouds: this._createEmptyTexture([0, 0, 0, 255]),
    };
    this.hasCustomClouds = false;

    // Scene state
    this.state = {
      camYaw: 0.28,       // radians (Europe/Africa facing)
      camPitch: 0.44,     // radians (Northern hemisphere view)
      camDist: 3.45,      // Earth radii (1.0 = surface, 3.45 ≈ 15,600 km alt)
      camTargetOffset: [0, 0, 0],
      fovDeg: 38,

      sunAzDeg: -58,
      sunElDeg: 14,
      earthRot: 0,
      cloudOffsetDeg: 0,

      atmoDensity: 1.00,
      atmoHeight: 1.05,
      cloudCover: 0.90,
      cloudShadow: 0.85,
      bumpStrength: 1.35,
      oceanSpec: 1.15,
      nightLights: 1.65,
      starsIntensity: 1.10,
      exposure: 1.05,
      autoRotate: false,
    };

    // Accumulation FBO (shared for preview & offline render)
    this.accumFbo = null;
    this.accumTex = null;
    this.accumWidth = 0;
    this.accumHeight = 0;

    // Render mode state
    this.mode = 'live'; // 'live' | 'rendering' | 'done'
    this.renderTargetSpp = 48;
    this.renderCurrentSpp = 0;
    this.renderStartTime = 0;
    this.onRenderProgress = null;
    this.onRenderComplete = null;

    this.resize();
  }

  _getUniforms(program, names) {
    const map = {};
    for (const n of names) {
      map[n] = this.gl.getUniformLocation(program, n);
    }
    return map;
  }

  _createEmptyTexture(rgba) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  _uploadTexture(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  async loadDefaultTextures(onStatus) {
    const entries = [
      ['day', TEXTURE_SOURCES.day, 'Lade 4K Tag-Satellitenkarte…'],
      ['night', TEXTURE_SOURCES.night, 'Lade 4K Nachtlichter…'],
      ['brc', TEXTURE_SOURCES.brc, 'Lade 4K Relief-, Ozean- & Wolkenkarte…'],
    ];

    await Promise.all(
      entries.map(async ([key, urls, msg]) => {
        try {
          if (onStatus) onStatus(msg);
          const { img } = await loadImageWithFallback(urls);
          this._uploadTexture(this.textures[key], img);
        } catch (err) {
          console.warn(`Fallback procedural texture used for ${key}:`, err);
          this._uploadTexture(this.textures[key], createProceduralFallbackCanvas(key));
        }
      })
    );
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
        resolve();
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
    const { camYaw, camPitch, camDist, camTargetOffset } = this.state;
    const cp = Math.cos(camPitch);
    const sp = Math.sin(camPitch);
    const sy = Math.sin(camYaw);
    const cy = Math.cos(camYaw);

    const pos = [
      camDist * cp * sy,
      camDist * sp,
      camDist * cp * cy,
    ];

    const target = camTargetOffset;
    let fx = target[0] - pos[0];
    let fy = target[1] - pos[1];
    let fz = target[2] - pos[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;

    const upRef = [0, 1, 0];
    // right = normalize(cross(forward, upRef))
    let rx = fy * upRef[2] - fz * upRef[1];
    let ry = fz * upRef[0] - fx * upRef[2];
    let rz = fx * upRef[1] - fy * upRef[0];
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;

    // up = cross(right, forward)
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    return {
      pos,
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

  _bindRayUniforms(width, height, sampleIndex, highQuality) {
    const gl = this.gl;
    const cam = this._computeCameraBasis();
    const sun = this._computeSunDir();
    const tanHalfFov = Math.tan(((this.state.fovDeg * Math.PI) / 180) * 0.5);

    gl.useProgram(this.rayProgram);
    gl.uniform2f(this.uRay.uResolution, width, height);
    gl.uniform3fv(this.uRay.uCamPos, cam.pos);
    gl.uniform3fv(this.uRay.uCamForward, cam.forward);
    gl.uniform3fv(this.uRay.uCamRight, cam.right);
    gl.uniform3fv(this.uRay.uCamUp, cam.up);
    gl.uniform1f(this.uRay.uTanHalfFov, tanHalfFov);

    gl.uniform3fv(this.uRay.uSunDir, sun);
    gl.uniform1f(this.uRay.uEarthRot, this.state.earthRot);
    gl.uniform1f(this.uRay.uCloudOffset, (this.state.cloudOffsetDeg * Math.PI) / 180);

    gl.uniform1f(this.uRay.uAtmoDensity, this.state.atmoDensity);
    gl.uniform1f(this.uRay.uAtmoHeight, this.state.atmoHeight);
    gl.uniform1f(this.uRay.uCloudCover, this.state.cloudCover);
    gl.uniform1f(this.uRay.uCloudShadow, this.state.cloudShadow);
    gl.uniform1f(this.uRay.uBumpStrength, this.state.bumpStrength);
    gl.uniform1f(this.uRay.uOceanSpec, this.state.oceanSpec);
    gl.uniform1f(this.uRay.uNightLights, this.state.nightLights);
    gl.uniform1f(this.uRay.uStarsIntensity, this.state.starsIntensity);

    gl.uniform1i(this.uRay.uSampleIndex, sampleIndex);
    gl.uniform1i(this.uRay.uHighQuality, highQuality ? 1 : 0);
    gl.uniform1i(this.uRay.uHasCustomClouds, this.hasCustomClouds ? 1 : 0);

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

  // Called every animation frame
  tick(dt) {
    const gl = this.gl;
    if (this.mode === 'live') {
      if (this.state.autoRotate) {
        this.state.earthRot += dt * 0.04;
      }
      this._ensureAccumFbo(this.canvas.width, this.canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
      gl.viewport(0, 0, this.accumWidth, this.accumHeight);
      gl.disable(gl.BLEND);

      this._bindRayUniforms(this.accumWidth, this.accumHeight, 0, false);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this._drawDisplayToTarget(null, this.canvas.width, this.canvas.height, false);
    } else if (this.mode === 'rendering') {
      // Progressive offline raytracing: accumulate 1 sample per frame (smooth UI)
      const s = this.renderCurrentSpp;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo);
      gl.viewport(0, 0, this.accumWidth, this.accumHeight);

      if (s === 0) {
        gl.disable(gl.BLEND);
      } else {
        // Running average: out = new * (1/(s+1)) + prev * (s/(s+1))
        const alpha = 1.0 / (s + 1);
        gl.enable(gl.BLEND);
        gl.blendColor(0, 0, 0, alpha);
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      }

      this._bindRayUniforms(this.accumWidth, this.accumHeight, s, true);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);

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
    } else if (this.mode === 'done') {
      // Allow live exposure tweaks on the finished HDR raytrace buffer!
      this._drawDisplayToTarget(null, this.canvas.width, this.canvas.height, true);
    }
  }

  startOfflineRender(width, height, spp) {
    this._ensureAccumFbo(width, height);
    this.mode = 'rendering';
    this.renderTargetSpp = spp;
    this.renderCurrentSpp = 0;
    this.renderStartTime = performance.now();
  }

  returnToLive() {
    this.mode = 'live';
    this.resize();
  }

  exportPng() {
    const gl = this.gl;
    const w = this.accumWidth;
    const h = this.accumHeight;

    // Render tonemapped image into an 8-bit FBO at exact full resolution
    const outTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, outTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    const outFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, outFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);

    this._drawDisplayToTarget(outFbo, w, h, false);

    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(outFbo);
    gl.deleteTexture(outTex);

    // Flip Y onto a 2D canvas and export PNG
    const outCanvas = document.createElement('canvas');
    outCanvas.width = w;
    outCanvas.height = h;
    const ctx = outCanvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    const rowSize = w * 4;
    for (let y = 0; y < h; y++) {
      const srcOffset = (h - 1 - y) * rowSize;
      const dstOffset = y * rowSize;
      imgData.data.set(pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
    }
    ctx.putImageData(imgData, 0, 0);

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
