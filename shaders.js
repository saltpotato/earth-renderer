export const fullscreenVert = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);

out vec2 vUv;

void main() {
  vec2 p = POSITIONS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const earthRaytraceFrag = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform vec2 uResolution;
uniform vec3 uCamPos;
uniform float uCamAlt;
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanHalfFov;

uniform vec3 uSunDir;
uniform float uEarthRot;
uniform float uCloudOffset;
uniform float uTime;

uniform float uAtmoDensity;
uniform float uAtmoHeight;
uniform float uCloudCover;
uniform float uCloudShadow;
uniform float uBumpStrength;
uniform float uOceanSpec;
uniform float uNightLights;
uniform float uStarsIntensity;
uniform float uAuroraIntensity;

uniform int uMoonEnabled;
uniform vec3 uMoonPos;
uniform float uMoonRadius;

uniform int uSampleIndex;
uniform int uHighQuality;
uniform int uHasCustomClouds;

uniform vec4 uTileBounds;      // xMin, yMin, gridSize, nTiles
uniform vec4 uTileRef;         // refLonRad, refLatRad, cosRefLat, sinRefLat (float64 origin)
uniform float uTileBlend;      // 0..1 blend weight for dynamic satellite/DEM patch
uniform float uTerrainExag;    // 0 = flat sphere + bump, 1..4 = true 3D DEM raymarched mountains!

uniform sampler2D uDayTex;
uniform sampler2D uNightTex;
uniform sampler2D uBrcTex;     // R: elevation/bump, G: roughness, B: clouds
uniform sampler2D uCloudTex;   // Optional custom cloud texture (e.g. 8K clouds)
uniform sampler2D uMoonTex;    // Lunar albedo / crater map
uniform sampler2D uTileSatTex; // Dynamic Esri World Imagery patch
uniform sampler2D uTileDemTex; // Dynamic AWS Terrarium DEM patch

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;
const float R_EARTH = 1.0;

// ---------------------------------------------------------------------------
// Hashing & Low-Discrepancy Sampling
// ---------------------------------------------------------------------------
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

vec2 r2Sequence(int n) {
  float fn = float(n + 1);
  return fract(vec2(0.7548776662466927, 0.5698402909980532) * fn);
}

float valueNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash33(i + vec3(0, 0, 0)).x;
  float n100 = hash33(i + vec3(1, 0, 0)).x;
  float n010 = hash33(i + vec3(0, 1, 0)).x;
  float n110 = hash33(i + vec3(1, 1, 0)).x;
  float n001 = hash33(i + vec3(0, 0, 1)).x;
  float n101 = hash33(i + vec3(1, 0, 1)).x;
  float n011 = hash33(i + vec3(0, 1, 1)).x;
  float n111 = hash33(i + vec3(1, 1, 1)).x;

  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);

  float nxy0 = mix(nx00, nx10, f.y);
  float nxy1 = mix(nx01, nx11, f.y);
  return mix(nxy0, nxy1, f.z);
}

float fbm3D(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * valueNoise3D(p);
    p = p * 2.03 + vec3(17.1, 31.7, 11.3);
    a *= 0.5;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Geometry & Coordinates
// ---------------------------------------------------------------------------
vec2 intersectSphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

// High-precision intersection for camera rays near R_EARTH = 1.0 + dR
// Avoids float32 cancellation of dot(ro,ro) - 1.0 when zoomed down to ~1 km altitude!
vec2 intersectSphereFromCam(vec3 ro, vec3 rd, float camAlt, float dR) {
  float b = dot(ro, rd);
  float diff = camAlt - dR;
  float c = diff * (camAlt + dR + 2.0);
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

vec3 rotateY(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}

vec2 sphereToMercatorTileUv(vec3 n, float lonOffset, vec4 bounds) {
  vec3 nr = rotateY(n, lonOffset);
  float lon = atan(nr.x, nr.z);
  float nTiles = bounds.w;

  if (nTiles >= 2048.0) {
    // High-precision local Mercator coordinates relative to float64 patch origin (crisp up to Z19!)
    float dLon = mod(lon - uTileRef.x + PI, TWO_PI) - PI;
    float dx = (dLon / TWO_PI) * nTiles;

    float lat = asin(clamp(nr.y, -0.996, 0.996));
    float dLat = lat - uTileRef.y;
    float c = max(uTileRef.z, 0.08);
    float s = uTileRef.w;
    float dMercY = -(dLat / c + 0.5 * dLat * dLat * (s / (c * c))) / TWO_PI;
    float dy = dMercY * nTiles;
    return vec2(dx, dy) / bounds.z;
  }

  float tx = (lon / TWO_PI + 0.5) * nTiles;
  float sinLat = clamp(nr.y, -0.996, 0.996);
  float mercY = 0.5 - log((1.0 + sinLat) / (1.0 - sinLat)) / (4.0 * PI);
  float ty = mercY * nTiles;

  float dx = mod(tx - bounds.x + nTiles * 0.5, nTiles) - nTiles * 0.5;
  float dy = ty - bounds.y;
  return vec2(dx, dy) / bounds.z;
}

float decodeTerrariumMeters(vec3 rgb) {
  return (rgb.r * 255.0 * 256.0 + rgb.g * 255.0 + rgb.b * (255.0 / 256.0)) - 32768.0;
}

// Fast 1-tap exact Terrarium decode (no RGB carry artifacts, 4x faster for coarse raymarch!)
float sampleTerrariumFast(vec2 uv) {
  ivec2 p = clamp(ivec2(clamp(uv, 0.0, 1.0) * 2047.0), ivec2(0), ivec2(2047));
  return decodeTerrariumMeters(texelFetch(uTileDemTex, p, 0).rgb);
}

// Exact bilinear height decode (used for normals & HQ binary search)
float sampleTerrariumMeters(vec2 uv) {
  vec2 texSize = vec2(2048.0);
  vec2 p = clamp(uv, 0.0, 1.0) * texSize - 0.5;
  vec2 i = floor(p);
  vec2 f = fract(p);
  ivec2 maxIdx = ivec2(2047);
  ivec2 p00 = clamp(ivec2(i), ivec2(0), maxIdx);
  ivec2 p10 = clamp(p00 + ivec2(1, 0), ivec2(0), maxIdx);
  ivec2 p01 = clamp(p00 + ivec2(0, 1), ivec2(0), maxIdx);
  ivec2 p11 = clamp(p00 + ivec2(1, 1), ivec2(0), maxIdx);

  float h00 = decodeTerrariumMeters(texelFetch(uTileDemTex, p00, 0).rgb);
  float h10 = decodeTerrariumMeters(texelFetch(uTileDemTex, p10, 0).rgb);
  float h01 = decodeTerrariumMeters(texelFetch(uTileDemTex, p01, 0).rgb);
  float h11 = decodeTerrariumMeters(texelFetch(uTileDemTex, p11, 0).rgb);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

// Zero-cancellation radial altitude above R_EARTH = 1.0 along camera ray
float rayAltFromCam(vec3 ro, vec3 rd, float camAlt, float t) {
  vec3 p = ro + rd * t;
  float r2Minus1 = camAlt * (camAlt + 2.0) + t * (2.0 * dot(ro, rd) + t);
  return r2Minus1 / (length(p) + 1.0);
}

// Sample 3D DEM height in Earth-radii units (fast 1-tap in live preview, bilinear in HQ)
float sampleTerrainHeightRadii(vec3 n, bool fastTap) {
  vec2 tuv = sphereToMercatorTileUv(n, uEarthRot, uTileBounds);
  if (tuv.x <= 0.002 || tuv.x >= 0.998 || tuv.y <= 0.002 || tuv.y >= 0.998) {
    return 0.0;
  }
  float fx = smoothstep(0.002, 0.08, tuv.x) * smoothstep(0.998, 0.92, tuv.x);
  float fy = smoothstep(0.002, 0.08, tuv.y) * smoothstep(0.998, 0.92, tuv.y);
  float meters = max(0.0, fastTap ? sampleTerrariumFast(tuv) : sampleTerrariumMeters(tuv));
  return (meters / 6371000.0) * uTerrainExag * fx * fy * uTileBlend;
}

// 3D Heightfield Raymarching over the spherical DEM shell (fast adaptive steps!)
float raymarchTerrain3D(vec3 ro, vec3 rd, float camAlt, float tStart, float tEnd, float jitter) {
  if (tEnd <= tStart) return -1.0;
  float tLimit = tStart + min(tEnd - tStart, 0.042);
  int steps = (uHighQuality == 1) ? 96 : 36;
  float stepGrowth = (uHighQuality == 1) ? 0.028 : 0.078;
  float minStep = (uHighQuality == 1) ? 0.00005 : 0.00014;
  int binSteps = (uHighQuality == 1) ? 8 : 5;

  float tPrev = tStart;
  float t = tStart + minStep * jitter;
  for (int i = 0; i < 96; i++) {
    if (i >= steps || t > tLimit) break;
    vec3 p = ro + rd * t;
    float hRay = rayAltFromCam(ro, rd, camAlt, t);
    float hTerr = sampleTerrainHeightRadii(normalize(p), true);

    if (hRay <= hTerr) {
      float lo = tPrev;
      float hi = t;
      for (int b = 0; b < 8; b++) {
        if (b >= binSteps) break;
        float mid = 0.5 * (lo + hi);
        float hm = rayAltFromCam(ro, rd, camAlt, mid);
        float ht = sampleTerrainHeightRadii(normalize(ro + rd * mid), uHighQuality == 0);
        if (hm <= ht) {
          hi = mid;
        } else {
          lo = mid;
        }
      }
      return 0.5 * (lo + hi);
    }
    tPrev = t;
    t += max(minStep, (t - tStart) * stepGrowth);
  }
  return -1.0;
}

// Soft 3D terrain cast shadows (fast 1-tap with altitude bias)
float traceTerrainShadow(vec3 hitPos, float hitAlt, vec3 sunDir) {
  if (uTerrainExag <= 0.01 || uTileBlend <= 0.05) return 1.0;
  float dMax = 0.00145 * uTerrainExag;
  float baseAlt = max(hitAlt, sampleTerrainHeightRadii(normalize(hitPos), true)) + 0.000010;
  int steps = (uHighQuality == 1) ? 14 : 8;
  float shadow = 1.0;
  float t = 0.00014;
  for (int i = 0; i < 14; i++) {
    if (i >= steps) break;
    vec3 p = hitPos + sunDir * t;
    float r2Minus1 = baseAlt * (baseAlt + 2.0) + t * (2.0 * dot(hitPos, sunDir) + t);
    float hRay = r2Minus1 / (length(p) + 1.0);
    if (hRay > dMax) break;
    float hTerr = sampleTerrainHeightRadii(normalize(p), true);
    float diff = hRay - hTerr;
    if (diff < -0.000004) return 0.16;
    shadow = min(shadow, clamp(0.16 + (diff / (t * 0.14 + 1e-5)), 0.16, 1.0));
    t *= (uHighQuality == 1) ? 1.45 : 1.72;
  }
  return shadow;
}

vec2 intersectSphereAt(vec3 ro, vec3 rd, vec3 center, float r) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  float s = sqrt(h);
  return vec2(-b - s, -b + s);
}

vec2 sphereToUv(vec3 n, float lonOffset) {
  vec3 nr = rotateY(n, lonOffset);
  float u = fract(0.5 + atan(nr.x, nr.z) / TWO_PI);
  float v = 0.5 - asin(clamp(nr.y, -1.0, 1.0)) / PI;
  return vec2(u, v);
}

float sampleCloudDensity(vec3 n) {
  vec2 uv = sphereToUv(n, uEarthRot + uCloudOffset);
  float raw = (uHasCustomClouds == 1)
    ? textureLod(uCloudTex, uv, 0.0).r
    : textureLod(uBrcTex, uv, 0.0).b;

  float detail = fbm3D(rotateY(n, uEarthRot + uCloudOffset) * 34.0);
  float c = raw * mix(0.84, 1.18, detail);
  c = clamp(c * uCloudCover, 0.0, 1.0);
  return smoothstep(0.06, 0.92, c);
}

// ---------------------------------------------------------------------------
// Deep Space: Stars, Milky Way & Solar Corona
// ---------------------------------------------------------------------------
vec3 renderStarLayer(vec3 rd, float scale, float threshold, float brightness) {
  vec3 p = rd * scale;
  vec3 cell = floor(p);
  vec3 f = fract(p) - 0.5;
  vec3 rnd = hash33(cell);

  if (rnd.x < threshold) return vec3(0.0);

  vec3 offset = (rnd - 0.5) * 0.65;
  float d = length(f - offset);
  float size = mix(0.028, 0.085, fract(rnd.y * 19.3));
  float star = exp(-(d * d) / (size * size));

  float temp = fract(rnd.z * 37.1);
  vec3 col = mix(vec3(0.68, 0.80, 1.0), vec3(1.0, 0.96, 0.90), smoothstep(0.0, 0.55, temp));
  col = mix(col, vec3(1.0, 0.72, 0.48), smoothstep(0.55, 1.0, temp));

  float mag = pow(fract(rnd.x * 91.7), 3.0);
  return col * star * (0.25 + 1.8 * mag) * brightness;
}

vec3 renderSpace(vec3 rd, vec3 sunDir) {
  vec3 col = vec3(0.0005, 0.0008, 0.0016);

  if (uStarsIntensity > 0.001) {
    vec3 stars = vec3(0.0);
    stars += renderStarLayer(rd, 130.0, 0.965, 1.25);
    stars += renderStarLayer(rd, 260.0, 0.955, 0.72);
    stars += renderStarLayer(rd, 480.0, 0.945, 0.38);

    vec3 galDir = normalize(vec3(
      rd.x * 0.82 - rd.y * 0.57,
      rd.x * 0.57 + rd.y * 0.82,
      rd.z
    ));
    float band = exp(-pow(galDir.y * 4.8, 2.0));
    float dust = fbm3D(galDir * 5.5);
    float fineDust = fbm3D(galDir * 14.0 + 3.7);
    float rift = smoothstep(0.32, 0.78, dust) * (1.0 - 0.55 * smoothstep(0.45, 0.75, fineDust));
    vec3 mwColor = mix(vec3(0.015, 0.024, 0.048), vec3(0.042, 0.036, 0.032), dust);
    col += (stars + mwColor * band * rift * 0.85) * uStarsIntensity;
  }

  float sunCos = max(dot(rd, sunDir), 0.0);
  float sunDisk = smoothstep(0.99978, 0.99993, sunCos);
  float corona1 = pow(sunCos, 640.0) * 1.4;
  float corona2 = pow(sunCos, 48.0) * 0.09;
  vec3 sunCol = vec3(1.0, 0.97, 0.91);
  col += sunCol * (sunDisk * 28.0 + corona1 + corona2 * vec3(1.0, 0.88, 0.74));

  return col;
}

// ---------------------------------------------------------------------------
// Raytraced Moon (Lommel-Seeliger Regolith + Crater Relief + Earthshine)
// ---------------------------------------------------------------------------
vec3 shadeMoon(vec3 hitPos, vec3 rd, vec3 sunDir) {
  vec3 N = normalize(hitPos - uMoonPos);
  vec3 V = -rd;
  vec2 uv = sphereToUv(N, 1.2);

  vec3 moonSRGB = textureLod(uMoonTex, uv, 0.0).rgb;
  vec3 albedo = pow(max(moonSRGB, 0.0), vec3(2.2));

  // Crater relief from luminance gradient
  vec3 upRef = abs(N.y) < 0.995 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(upRef, N));
  vec3 B = cross(N, T);
  float eps = 0.0022;
  float hL = textureLod(uMoonTex, sphereToUv(normalize(N - T * eps), 1.2), 0.0).r;
  float hR = textureLod(uMoonTex, sphereToUv(normalize(N + T * eps), 1.2), 0.0).r;
  float hD = textureLod(uMoonTex, sphereToUv(normalize(N - B * eps), 1.2), 0.0).r;
  float hU = textureLod(uMoonTex, sphereToUv(normalize(N + B * eps), 1.2), 0.0).r;
  vec3 Ncrater = normalize(N - ((hR - hL) * T + (hU - hD) * B) * 2.6);

  float NdotL = max(dot(Ncrater, sunDir), 0.0);
  float NdotV = max(dot(Ncrater, V), 0.001);
  float macroNdotL = dot(N, sunDir);

  // Lommel-Seeliger + subtle Lambert blend (authentic powdery lunar regolith)
  float ls = NdotL / max(NdotL + NdotV, 0.08);
  float lunarDiff = mix(NdotL, ls * 1.35, 0.65) * smoothstep(-0.02, 0.04, macroNdotL);

  // Check if Earth eclipses the Moon (subtle coppery lunar eclipse shadow!)
  vec2 eclipseHit = intersectSphere(hitPos, sunDir, R_EARTH);
  vec3 sunColor = vec3(2.15, 2.10, 2.02);
  if (eclipseHit.x > 0.0) {
    // Penumbra / umbra reddening from Earth's atmosphere
    vec3 closest = hitPos + sunDir * eclipseHit.x;
    float missDist = length(cross(hitPos, sunDir));
    float penumbra = smoothstep(R_EARTH * 0.92, R_EARTH * 1.03, missDist);
    sunColor = mix(vec3(0.18, 0.035, 0.012), sunColor, penumbra);
  }

  // Subtle blue Earthshine on the Moon's dark hemisphere
  vec3 dirToEarth = normalize(-hitPos);
  float earthLit = max(dot(normalize(uMoonPos), sunDir) * -0.5 + 0.5, 0.0);
  float earthBounce = max(dot(N, dirToEarth), 0.0) * earthLit * 0.035;
  vec3 earthshine = vec3(0.28, 0.52, 0.95) * earthBounce;

  return albedo * (lunarDiff * sunColor + earthshine);
}

// ---------------------------------------------------------------------------
// Volumetric 3D Aurora Borealis & Australis
// ---------------------------------------------------------------------------
vec3 integrateAurora(vec3 ro, vec3 rd, float tMaxHit, vec3 sunDir, float jitter) {
  if (uAuroraIntensity <= 0.001 || uCamAlt < 0.08) return vec3(0.0);

  float rInner = R_EARTH + 0.012 * max(uAtmoHeight, 0.6);
  float rOuter = R_EARTH + 0.044 * max(uAtmoHeight, 0.6);

  vec2 outerHit = intersectSphere(ro, rd, rOuter);
  if (outerHit.y <= 0.0) return vec3(0.0);

  float tStart = max(outerHit.x, 0.0);
  float tEnd = outerHit.y;
  if (tMaxHit > 0.0) {
    tEnd = min(tEnd, tMaxHit);
  }
  if (tEnd <= tStart) return vec3(0.0);

  // Geomagnetic axis slightly tilted relative to geographic pole
  vec3 magAxis = normalize(vec3(-0.14, 0.984, 0.105));
  vec3 magRight = normalize(cross(vec3(0.0, 0.0, 1.0), magAxis));
  vec3 magFwd = cross(magAxis, magRight);

  int steps = (uHighQuality == 1) ? 24 : 12;
  float dt = (tEnd - tStart) / float(steps);
  vec3 accum = vec3(0.0);

  for (int i = 0; i < 24; i++) {
    if (i >= steps) break;
    float t = tStart + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float r = length(p);
    if (r < rInner || r > rOuter) continue;

    vec3 n = p / r;
    vec3 nr = rotateY(n, uEarthRot);

    // Geomagnetic latitude (oval around ~68-74 deg north & south)
    float sinLat = dot(nr, magAxis);
    float absLat = asin(clamp(abs(sinLat), 0.0, 1.0)); // radians
    float targetLat = 1.21; // ~69.3 deg
    float ovalDist = abs(absLat - targetLat);
    float ovalMask = exp(-(ovalDist * ovalDist) / (0.075 * 0.075));
    if (ovalMask < 0.01) continue;

    // Aurora only visible in night & twilight
    float nightMask = smoothstep(0.08, -0.18, dot(n, sunDir));
    if (nightMask < 0.005) continue;

    // Flowing magnetic curtain ribbons (projected onto pole plane for vertical streaks)
    float lon = atan(dot(nr, magRight), dot(nr, magFwd));
    vec3 sheetCoord = vec3(cos(lon) * 3.8, sin(lon) * 3.8, absLat * 14.0);
    float warp = fbm3D(sheetCoord * 1.15 + vec3(uTime * 0.07, -uTime * 0.05, 0.0));
    float ribbon = sin(absLat * 46.0 + warp * 9.5 + uTime * 0.35);
    ribbon = smoothstep(0.15, 0.96, ribbon * 0.5 + 0.5);

    // Fine vertical ray structure along magnetic field lines
    float rays = valueNoise3D(vec3(cos(lon) * 28.0 + warp * 4.0, sin(lon) * 28.0, uTime * 0.25));
    rays = smoothstep(0.28, 0.88, rays);

    // Vertical altitude profile (sharp glowing bottom, fading wispy top)
    float hNorm = clamp((r - rInner) / (rOuter - rInner), 0.0, 1.0);
    float vertProfile = smoothstep(0.0, 0.16, hNorm) * pow(1.0 - hNorm, 1.65);

    // Spectral emission: pink-magenta base -> bright oxygen green -> violet/crimson top
    vec3 colBottom = vec3(0.85, 0.22, 0.65);
    vec3 colGreen  = vec3(0.08, 1.00, 0.48);
    vec3 colTop    = vec3(0.52, 0.14, 0.92);
    vec3 emission = mix(colBottom, colGreen, smoothstep(0.02, 0.18, hNorm));
    emission = mix(emission, colTop, smoothstep(0.32, 0.85, hNorm));

    float density = ovalMask * ribbon * mix(0.45, 1.25, rays) * vertProfile * nightMask;
    accum += emission * density * dt * 15.0;
  }

  return accum * uAuroraIntensity;
}

// ---------------------------------------------------------------------------
// Physically-Based Atmosphere (Rayleigh + Mie + Ozone)
// ---------------------------------------------------------------------------
struct AtmoParams {
  float rAtmo;
  float hRayleigh;
  float hMie;
  vec3 betaR;
  vec3 betaM;
  vec3 betaOz;
};

AtmoParams getAtmoParams() {
  AtmoParams a;
  float hScale = max(uAtmoHeight, 0.25);
  a.rAtmo = R_EARTH + 0.024 * hScale;
  a.hRayleigh = 0.00165 * hScale;
  a.hMie = 0.00036 * hScale;

  float k = uAtmoDensity / hScale;
  a.betaR = vec3(13.5, 34.5, 94.0) * k;
  a.betaM = vec3(7.5) * k;
  a.betaOz = vec3(2.2, 6.8, 0.35) * k;
  return a;
}

vec3 sampleAtmoDensity(float alt, AtmoParams a) {
  float altClamped = max(alt, 0.0);
  float dR = exp(-altClamped / a.hRayleigh);
  float dM = exp(-altClamped / a.hMie);
  float ozCenter = 0.0046 * max(uAtmoHeight, 0.25);
  float ozWidth = 0.0028 * max(uAtmoHeight, 0.25);
  float dOz = max(0.0, 1.0 - abs(altClamped - ozCenter) / ozWidth);
  return vec3(dR, dM, dOz);
}

vec3 computeOpticalDepthToSun(vec3 pos, vec3 sunDir, AtmoParams a, int lightSteps) {
  vec2 earthHit = intersectSphere(pos, sunDir, R_EARTH * 0.9992);
  if (earthHit.x > 0.0) {
    return vec3(1e5);
  }
  vec2 atmoHit = intersectSphere(pos, sunDir, a.rAtmo);
  if (atmoHit.y <= 0.0) return vec3(0.0);

  float tMax = atmoHit.y;
  float dt = tMax / float(lightSteps);
  vec3 od = vec3(0.0);
  for (int i = 0; i < 16; i++) {
    if (i >= lightSteps) break;
    float t = (float(i) + 0.5) * dt;
    vec3 p = pos + sunDir * t;
    float alt = length(p) - R_EARTH;
    od += sampleAtmoDensity(alt, a) * dt;
  }
  return od;
}

vec3 transmittanceFromOD(vec3 od, AtmoParams a) {
  vec3 tau = a.betaR * od.x + (a.betaM * 1.11) * od.y + a.betaOz * od.z;
  return exp(-tau);
}

void integrateAtmosphere(
  vec3 ro,
  vec3 rd,
  float tStart,
  float tEnd,
  vec3 sunDir,
  AtmoParams a,
  float jitter,
  out vec3 outInscatter,
  out vec3 outTransmittance
) {
  outInscatter = vec3(0.0);
  outTransmittance = vec3(1.0);
  if (uAtmoDensity <= 0.001 || tEnd <= tStart) return;

  int viewSteps = (uHighQuality == 1) ? 56 : 12;
  int lightSteps = (uHighQuality == 1) ? 14 : 4;

  float dt = (tEnd - tStart) / float(viewSteps);
  float cosTheta = dot(rd, sunDir);

  float phaseR = 3.0 / (16.0 * PI) * (1.0 + cosTheta * cosTheta);
  float g = 0.78;
  float g2 = g * g;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosTheta * cosTheta)) /
                 ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));

  vec3 viewOD = vec3(0.0);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);

  for (int i = 0; i < 56; i++) {
    if (i >= viewSteps) break;
    float t = tStart + (float(i) + jitter) * dt;
    vec3 p = ro + rd * t;
    float alt = length(p) - R_EARTH;

    vec3 dens = sampleAtmoDensity(alt, a);
    vec3 stepOD = dens * dt;
    vec3 midViewOD = viewOD + stepOD * 0.5;
    viewOD += stepOD;

    vec3 sunOD = computeOpticalDepthToSun(p, sunDir, a, lightSteps);
    if (sunOD.x < 1e4) {
      vec3 totalT = transmittanceFromOD(midViewOD + sunOD, a);
      sumR += dens.x * totalT * dt;
      sumM += dens.y * totalT * dt;
    }
  }

  float sunIntensity = 12.0;
  outInscatter = sunIntensity * (sumR * a.betaR * phaseR + sumM * a.betaM * phaseM);
  outTransmittance = transmittanceFromOD(viewOD, a);
}

// ---------------------------------------------------------------------------
// Physically-Based Ocean GGX Specular
// ---------------------------------------------------------------------------
float distributionGGX(float NdotH, float rough) {
  float a = rough * rough;
  float a2 = a * a;
  float d = (NdotH * NdotH) * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-5);
}

float geometrySchlickGGX(float NdotV, float rough) {
  float r = rough + 1.0;
  float k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

// ---------------------------------------------------------------------------
// Procedural Biome Micro-Detail Synthesis (Rocks, Forest Canopy, Snow, Soil, Ocean Waves)
// ---------------------------------------------------------------------------
float noise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2DFast(vec2 p) {
  float v = 0.55 * noise2D(p);
  p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.13 + vec2(13.7, 29.3);
  v += 0.30 * noise2D(p);
  p = mat2(0.80, 0.60, -0.60, 0.80) * p * 2.17 + vec2(7.1, 19.9);
  v += 0.15 * noise2D(p);
  return v;
}

void applyBiomeMicroDetail(
  vec3 N,
  vec3 T,
  vec3 B,
  vec2 tileUv,
  float tileMask,
  float distKm,
  inout vec3 dayAlbedo,
  inout vec3 Nsurf,
  inout float oceanMask
) {
  if (tileMask <= 0.02 || distKm > 150.0) return;

  float nearFade = 1.0 - smoothstep(18.0, 140.0, distKm);
  float fineFade = 1.0 - smoothstep(4.0, 44.0, distKm);
  float w = tileMask * nearFade;
  if (w <= 0.005) return;

  float cosLat = max(0.2, sqrt(max(0.0, 1.0 - N.y * N.y)));
  float patchKm = (8.0 * 40075.0 * cosLat) / max(uTileBounds.w, 1.0);
  vec2 kmPos = tileUv * patchKm;
  float elevM = sampleTerrariumFast(tileUv);
  float slope = 1.0 - clamp(dot(Nsurf, N), 0.0, 1.0);

  float maxRGB = max(dayAlbedo.r, max(dayAlbedo.g, dayAlbedo.b));
  float minRGB = min(dayAlbedo.r, min(dayAlbedo.g, dayAlbedo.b));
  float sat = (maxRGB - minRGB) / max(maxRGB, 0.001);
  float lum = dot(dayAlbedo, vec3(0.2126, 0.7152, 0.0722));

  float isMarineBlue = smoothstep(0.95, 1.25, dayAlbedo.b / max(dayAlbedo.r, 0.005)) *
                       smoothstep(0.32, 0.05, dayAlbedo.r);
  float localWater = smoothstep(3.0, 0.4, elevM) * isMarineBlue;
  oceanMask = mix(oceanMask, max(oceanMask * smoothstep(8.0, 1.0, elevM), localWater), tileMask);

  if (oceanMask > 0.5) {
    vec2 wUv = kmPos * 6.0 + vec2(uTime * 0.16, uTime * 0.10);
    float h0 = fbm2DFast(wUv);
    float hx = noise2D(wUv * 2.2 + vec2(0.14, 0.0)) - noise2D(wUv * 2.2);
    float hy = noise2D(wUv * 2.2 + vec2(0.0, 0.14)) - noise2D(wUv * 2.2);
    vec3 Nwave = normalize(N - (hx * T + hy * B) * 1.1 * w);
    Nsurf = normalize(mix(Nsurf, Nwave, oceanMask * w));

    float shoreBand = smoothstep(0.0, 0.35, elevM) * smoothstep(2.4, 0.5, elevM);
    float foam = smoothstep(0.45, 0.76, h0);
    dayAlbedo = mix(dayAlbedo, vec3(0.76, 0.84, 0.90), shoreBand * foam * 0.48 * w);
    return;
  }

  float isSnow   = smoothstep(0.28, 0.55, lum) * smoothstep(0.26, 0.08, sat) * smoothstep(900.0, 2200.0, elevM);
  float isRock   = smoothstep(0.06, 0.28, slope) * (1.0 - isSnow * 0.65);
  float isForest = smoothstep(1.01, 1.14, dayAlbedo.g / max(dayAlbedo.r, 0.005)) *
                   smoothstep(1.04, 1.20, dayAlbedo.g / max(dayAlbedo.b, 0.005)) *
                   (1.0 - isRock * 0.85) * (1.0 - isSnow);
  float isSoil   = clamp(1.0 - isRock - isForest - isSnow, 0.0, 1.0);

  // Shared 3-octave macro + fine micro detail (8x faster than per-biome FBMs!)
  float macro = fbm2DFast(kmPos * 4.5);
  float fine  = noise2D(kmPos * 32.0) * fineFade;
  float strata = sin(elevM * 0.095 + macro * 7.5) * 0.5 + 0.5;

  float rockMod   = mix(0.68, 1.24, mix(macro, strata, 0.45) * 0.72 + fine * 0.28);
  float forestMod = mix(0.72, 1.22, mix(macro, fine, 0.55 * fineFade));
  float snowMod   = mix(0.88, 1.10, macro);
  float soilMod   = mix(0.80, 1.18, macro * 0.68 + fine * 0.32);

  float totalMod = isRock * rockMod + isForest * forestMod + isSnow * snowMod + isSoil * soilMod;
  dayAlbedo *= mix(1.0, totalMod, w * 0.85);

  vec3 cliffTint = vec3(0.24, 0.25, 0.27) * mix(0.75, 1.25, mix(macro, strata, 0.4));
  dayAlbedo = mix(dayAlbedo, mix(dayAlbedo, cliffTint, 0.38), isRock * smoothstep(0.18, 0.45, slope) * w);

  // Fast 2-tap normal gradient from fine noise
  vec2 nPos = kmPos * mix(9.0, 20.0, isForest * 0.7 + isSoil * 0.3);
  float n0 = noise2D(nPos);
  float nx = noise2D(nPos + vec2(0.16, 0.0)) - n0;
  float ny = noise2D(nPos + vec2(0.0, 0.16)) - n0;
  float bumpAmp = (isRock * 1.4 + isForest * 0.9 + isSoil * 0.6 + isSnow * 0.4) * w * (0.45 + 0.55 * fineFade);
  Nsurf = normalize(Nsurf - (nx * T + ny * B) * bumpAmp);
}

// ---------------------------------------------------------------------------
// Main Raytrace Entry
// ---------------------------------------------------------------------------
void main() {
  vec2 subpixel = vec2(0.0);
  float hashSeed = hash12(gl_FragCoord.xy + float(uSampleIndex) * 13.71);
  if (uHighQuality == 1) {
    subpixel = r2Sequence(uSampleIndex) - 0.5;
  }

  vec2 px = gl_FragCoord.xy + subpixel;
  vec2 ndc = (px / uResolution) * 2.0 - 1.0;
  float aspect = uResolution.x / uResolution.y;

  vec3 rd = normalize(
    uCamForward +
    ndc.x * aspect * uTanHalfFov * uCamRight +
    ndc.y * uTanHalfFov * uCamUp
  );
  vec3 ro = uCamPos;

  vec3 sunDir = normalize(uSunDir);
  if (uHighQuality == 1) {
    vec2 sRnd = r2Sequence(uSampleIndex + 137);
    float angle = sRnd.x * TWO_PI;
    float radius = sqrt(sRnd.y) * 0.011;
    vec3 sUp = abs(sunDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 sRight = normalize(cross(sUp, sunDir));
    vec3 sOrthoUp = cross(sunDir, sRight);
    sunDir = normalize(sunDir + (cos(angle) * sRight + sin(angle) * sOrthoUp) * radius);
  }

  AtmoParams atmo = getAtmoParams();
  float dAtmo = atmo.rAtmo - R_EARTH;
  float dCloud = 0.0038 * max(uAtmoHeight, 0.4);
  float rCloud = R_EARTH + dCloud;

  vec2 atmoHit = intersectSphereFromCam(ro, rd, uCamAlt, dAtmo);
  vec2 earthHit = intersectSphereFromCam(ro, rd, uCamAlt, 0.0);
  vec2 cloudHit = intersectSphereFromCam(ro, rd, uCamAlt, dCloud);
  vec2 moonHit = (uMoonEnabled == 1)
    ? intersectSphereAt(ro, rd, uMoonPos, uMoonRadius)
    : vec2(-1.0);

  float jitter = (uHighQuality == 1) ? hashSeed : 0.5;
  // Interleaved gradient noise breaks up any coherent raymarch ring patterns in live preview
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float terrJitter = (uHighQuality == 1) ? hashSeed : ign;

  // Optional 3D Heightfield Raymarching over active AWS Terrarium DEM patch
  float tSurface = earthHit.x;
  bool hitTerrain3D = false;
  if (uTerrainExag > 0.01 && uTileBlend > 0.02 && uTileBounds.w >= 16.0 && uCamAlt < 0.25) {
    float dMaxElev = 0.00145 * uTerrainExag;
    vec2 topHit = intersectSphereFromCam(ro, rd, uCamAlt, dMaxElev);
    if (topHit.y > 0.0) {
      float tStart = max(topHit.x, 0.0);
      float tEnd = (earthHit.x > 0.0) ? earthHit.x : topHit.y;
      float tTerr = raymarchTerrain3D(ro, rd, uCamAlt, tStart, tEnd, terrJitter);
      if (tTerr > 0.0) {
        tSurface = tTerr;
        hitTerrain3D = true;
      }
    }
  }

  bool hitEarth = tSurface > 0.0;
  bool hitMoon = moonHit.x > 0.0 && (!hitEarth || moonHit.x < tSurface);

  vec3 radiance = vec3(0.0);

  if (hitEarth && !hitMoon) {
    // -----------------------------------------------------------------------
    // Ray hits Earth Surface (or 3D Raymarched Mountain Terrain)
    // -----------------------------------------------------------------------
    vec3 hitPos = ro + rd * tSurface;
    float hitAlt = hitTerrain3D ? rayAltFromCam(ro, rd, uCamAlt, tSurface) : 0.0;
    vec3 N = normalize(hitPos);
    vec3 V = -rd;
    vec2 uv = sphereToUv(N, uEarthRot);

    vec3 daySRGB = textureLod(uDayTex, uv, 0.0).rgb;
    vec3 dayAlbedo = pow(max(daySRGB, 0.0), vec3(2.2));
    vec3 nightSRGB = textureLod(uNightTex, uv, 0.0).rgb;
    vec3 brc = textureLod(uBrcTex, uv, 0.0).rgb;

    float roughness = clamp(brc.g, 0.05, 1.0);
    float oceanMask = smoothstep(0.50, 0.24, roughness);
    float landMask = 1.0 - oceanMask;

    // Dynamic Deep-Zoom Satellite Tile Patch (Esri World Imagery + AWS Terrarium DEM)
    // Sample with hardware trilinear mipmaps + 16x anisotropic filtering to eliminate Moiré waves
    float tileMask = 0.0;
    vec2 tileUv = (uTileBounds.w > 1.5)
      ? sphereToMercatorTileUv(N, uEarthRot, uTileBounds)
      : vec2(-1.0);
    vec3 satSRGB = texture(uTileSatTex, clamp(tileUv, 0.0, 1.0)).rgb;
    if (uTileBlend > 0.001 && uTileBounds.w > 1.5) {
      if (tileUv.x > 0.0 && tileUv.x < 1.0 && tileUv.y > 0.0 && tileUv.y < 1.0) {
        float fx = smoothstep(0.0, 0.10, tileUv.x) * smoothstep(1.0, 0.90, tileUv.x);
        float fy = smoothstep(0.0, 0.10, tileUv.y) * smoothstep(1.0, 0.90, tileUv.y);
        tileMask = fx * fy * uTileBlend;

        vec3 satLinear = pow(max(satSRGB, 0.0), vec3(2.2));
        dayAlbedo = mix(dayAlbedo, satLinear, tileMask);
      }
    }

    vec3 upRef = abs(N.y) < 0.995 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(upRef, N));
    vec3 B = cross(N, T);

    vec3 Nsurf = N;
    if (uBumpStrength > 0.001) {
      float eps = 0.00055;
      float hL = textureLod(uBrcTex, sphereToUv(normalize(N - T * eps), uEarthRot), 0.0).r;
      float hR = textureLod(uBrcTex, sphereToUv(normalize(N + T * eps), uEarthRot), 0.0).r;
      float hD = textureLod(uBrcTex, sphereToUv(normalize(N - B * eps), uEarthRot), 0.0).r;
      float hU = textureLod(uBrcTex, sphereToUv(normalize(N + B * eps), uEarthRot), 0.0).r;

      float reliefScale = uBumpStrength * 14.0 * landMask;
      vec3 Nglobal = normalize(N - ((hR - hL) * T + (hU - hD) * B) * reliefScale);

      if (tileMask > 0.01) {
        // High-resolution Terrarium DEM finite-difference normal (8x8 = 2048x2048 patch)
        float du = 2.0 / 2048.0;
        float dL = sampleTerrariumMeters(tileUv - vec2(du, 0.0));
        float dR = sampleTerrariumMeters(tileUv + vec2(du, 0.0));
        // Note: tileUv.y increases southward, so -du is North (+B)
        float dN = sampleTerrariumMeters(tileUv - vec2(0.0, du));
        float dS = sampleTerrariumMeters(tileUv + vec2(0.0, du));

        float cosLat = max(0.2, sqrt(max(0.0, 1.0 - N.y * N.y)));
        float spanMeters = max(12.0, (4.0 * 156543.0 * cosLat) / uTileBounds.w);
        float slopeBoost = hitTerrain3D ? max(uTerrainExag, 1.0) : (uBumpStrength * 1.45);
        float sx = clamp(((dR - dL) / spanMeters) * slopeBoost, -3.5, 3.5);
        float sy = clamp(((dN - dS) / spanMeters) * slopeBoost, -3.5, 3.5);
        vec3 Nlocal = normalize(N - (sx * T + sy * B));
        Nsurf = normalize(mix(Nglobal, Nlocal, tileMask));
      } else {
        Nsurf = Nglobal;
      }
    }

    // Synthesize crisp procedural biome micro-detail (rocks, forests, snow, soil, ocean waves)
    float distKm = tSurface * 6371.0;
    applyBiomeMicroDetail(N, T, B, tileUv, tileMask, distKm, dayAlbedo, Nsurf, oceanMask);
    landMask = 1.0 - oceanMask;

    if (oceanMask > 0.01 && tileMask < 0.5) {
      vec3 wavePos = rotateY(N, uEarthRot) * 180.0;
      float w1 = valueNoise3D(wavePos) - 0.5;
      float w2 = valueNoise3D(wavePos * 2.1 + 19.3) - 0.5;
      vec3 Nocean = normalize(N + (T * w1 + B * w2) * 0.035);
      Nsurf = normalize(mix(Nsurf, Nocean, oceanMask));
    }

    int surfLightSteps = (uHighQuality == 1) ? 14 : 6;
    vec3 sunOD = computeOpticalDepthToSun(hitPos + N * 0.0003, sunDir, atmo, surfLightSteps);
    vec3 sunTrans = (sunOD.x < 1e4) ? transmittanceFromOD(sunOD, atmo) : vec3(0.0);

    // Smoothly part global clouds when diving into low-altitude Deep Zoom (< 280 km)
    float deepCloudFade = smoothstep(0.003, 0.045, uCamAlt);

    float cloudShadowFactor = 1.0;
    if (uCloudCover > 0.01 && uCloudShadow > 0.01 && deepCloudFade > 0.01 && dot(N, sunDir) > -0.05) {
      vec2 shHit = intersectSphere(hitPos, sunDir, rCloud);
      if (shHit.y > 0.0) {
        vec3 cloudShadowPos = hitPos + sunDir * shHit.y;
        float cDens = sampleCloudDensity(normalize(cloudShadowPos));
        cloudShadowFactor = 1.0 - cDens * uCloudShadow * 0.88 * deepCloudFade;
      }
    }

    // Real 3D mountain self-shadowing across valleys
    float terrainShadow = hitTerrain3D ? traceTerrainShadow(hitPos, hitAlt, sunDir) : 1.0;

    float NdotL = max(dot(Nsurf, sunDir), 0.0);
    float macroNdotL = dot(N, sunDir);
    float horizonVis = smoothstep(-0.04, 0.06, macroNdotL);
    vec3 directLight = vec3(3.85) * sunTrans * cloudShadowFactor * terrainShadow * horizonVis;

    float lum = dot(dayAlbedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 vividAlbedo = mix(vec3(lum), dayAlbedo, mix(1.12, 1.28, landMask));
    vividAlbedo = mix(vividAlbedo, vividAlbedo * vec3(0.68, 0.80, 1.04), oceanMask * 0.65);

    vec3 diffuse = (vividAlbedo / PI) * NdotL * directLight;
    vec3 skyAmbient = vec3(0.014, 0.032, 0.075) * uAtmoDensity * smoothstep(-0.14, 0.35, macroNdotL);
    // Slightly richer sky-fill in shadowed alpine valleys when zoomed into 3D terrain
    float valleyFill = hitTerrain3D ? 1.85 : 1.0;
    vec3 surfColor = diffuse + vividAlbedo * skyAmbient * valleyFill * (0.35 + 0.65 * cloudShadowFactor);

    if (oceanMask > 0.01 && uOceanSpec > 0.001 && NdotL > 0.0) {
      vec3 H = normalize(V + sunDir);
      float NdotV = max(dot(Nsurf, V), 0.001);
      float NdotH = max(dot(Nsurf, H), 0.0);
      float VdotH = max(dot(V, H), 0.0);

      float oceanRough = mix(0.22, 0.11, oceanMask);
      float D = distributionGGX(NdotH, oceanRough);
      float G = geometrySchlickGGX(NdotV, oceanRough) * geometrySchlickGGX(NdotL, oceanRough);
      float F = 0.02 + 0.98 * pow(1.0 - VdotH, 5.0);

      vec3 spec = vec3((D * G * F) / max(4.0 * NdotV * NdotL, 0.001));
      surfColor += spec * NdotL * directLight * oceanMask * uOceanSpec * 1.15;
    }

    if (uNightLights > 0.001) {
      float nightMask = smoothstep(0.09, -0.14, macroNdotL);
      vec3 lights = pow(max(nightSRGB, 0.0), vec3(2.0));
      lights *= vec3(1.18, 0.96, 0.68);
      surfColor += lights * nightMask * uNightLights * 0.95;
    }

    // Elevated 3D Cloud Layer
    if (uCloudCover > 0.01 && cloudHit.x > 0.0 && cloudHit.x < tSurface) {
      vec3 cPos = ro + rd * cloudHit.x;
      vec3 cN = normalize(cPos);
      float cDens = sampleCloudDensity(cN);

      if (cDens > 0.005) {
        vec3 cSunOD = computeOpticalDepthToSun(cPos, sunDir, atmo, surfLightSteps);
        vec3 cSunTrans = (cSunOD.x < 1e4) ? transmittanceFromOD(cSunOD, atmo) : vec3(0.0);

        vec3 cShift = normalize(cN + sunDir * 0.0055);
        float cSelf = sampleCloudDensity(cShift);
        float selfShadow = mix(1.0, 0.58, clamp((cSelf - cDens) * 2.2 + 0.25, 0.0, 1.0));

        float cNdotL = dot(cN, sunDir);
        float wrapLight = smoothstep(-0.14, 0.85, cNdotL);
        float cosSun = dot(rd, sunDir);
        float silverLining = pow(max(cosSun, 0.0), 8.0) * 0.45 * (1.0 - cDens * 0.6);

        vec3 cloudDirect = vec3(1.28) * cSunTrans * (wrapLight * selfShadow + silverLining);
        vec3 cloudAmbient = vec3(0.018, 0.036, 0.08) * uAtmoDensity * smoothstep(-0.18, 0.28, cNdotL);
        vec3 cloudCol = cloudDirect + cloudAmbient;

        if (uNightLights > 0.001) {
          float cNight = smoothstep(0.06, -0.15, cNdotL);
          vec3 underLights = pow(max(nightSRGB, 0.0), vec3(2.0)) * vec3(1.1, 0.85, 0.55);
          cloudCol += underLights * cNight * uNightLights * 0.22 * (1.0 - cDens * 0.55);
        }

        float alpha = smoothstep(0.04, 0.88, cDens) * deepCloudFade;
        surfColor = mix(surfColor, cloudCol, alpha);
      }
    }

    float tAtmoStart = max(atmoHit.x, 0.0);
    float tAtmoEnd = tSurface;
    vec3 inscatter, atmoTrans;
    integrateAtmosphere(ro, rd, tAtmoStart, tAtmoEnd, sunDir, atmo, jitter, inscatter, atmoTrans);

    vec3 aurora = integrateAurora(ro, rd, tSurface, sunDir, jitter);
    radiance = surfColor * atmoTrans + inscatter + aurora;
  } else {
    // -----------------------------------------------------------------------
    // Background: Moon or Deep Space + Earth's Atmospheric Limb & Polar Aurora
    // -----------------------------------------------------------------------
    vec3 bgCol = hitMoon
      ? shadeMoon(ro + rd * moonHit.x, rd, sunDir)
      : renderSpace(rd, sunDir);

    float tMaxObj = hitMoon ? moonHit.x : -1.0;

    if (atmoHit.y > 0.0 && (!hitMoon || atmoHit.x < moonHit.x)) {
      float tAtmoStart = max(atmoHit.x, 0.0);
      float tAtmoEnd = hitMoon ? min(atmoHit.y, moonHit.x) : atmoHit.y;
      vec3 inscatter, atmoTrans;
      integrateAtmosphere(ro, rd, tAtmoStart, tAtmoEnd, sunDir, atmo, jitter, inscatter, atmoTrans);
      bgCol = bgCol * atmoTrans + inscatter;
    }

    vec3 aurora = integrateAurora(ro, rd, tMaxObj, sunDir, jitter);
    radiance = bgCol + aurora;
  }

  radiance = max(radiance, vec3(0.0));
  outColor = vec4(radiance, 1.0);
}
`;

export const displayFrag = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uAccumTex;
uniform vec2 uResolution;
uniform float uExposure;

vec3 acesToneMap(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec3 col = texture(uAccumTex, vUv).rgb;

  vec2 texel = 1.0 / uResolution;
  vec3 bloom = vec3(0.0);
  float totalW = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      if (x == 0 && y == 0) continue;
      vec2 off = vec2(float(x), float(y)) * texel * 2.4;
      vec3 s = texture(uAccumTex, clamp(vUv + off, 0.0, 1.0)).rgb;
      float bright = max(max(s.r, s.g), s.b);
      float contrib = smoothstep(0.85, 3.0, bright);
      float w = exp(-0.35 * float(x * x + y * y));
      bloom += s * contrib * w;
      totalW += w;
    }
  }
  col += (bloom / max(totalW, 1.0)) * 0.28;

  col *= uExposure;
  col = acesToneMap(col);

  vec2 vigUv = vUv * 2.0 - 1.0;
  float vig = 1.0 - 0.12 * dot(vigUv, vigUv);
  col *= clamp(vig, 0.82, 1.0);

  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
