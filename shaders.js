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
uniform vec3 uCamForward;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform float uTanHalfFov;

uniform vec3 uSunDir;
uniform float uEarthRot;
uniform float uCloudOffset;

uniform float uAtmoDensity;
uniform float uAtmoHeight;
uniform float uCloudCover;
uniform float uCloudShadow;
uniform float uBumpStrength;
uniform float uOceanSpec;
uniform float uNightLights;
uniform float uStarsIntensity;

uniform int uSampleIndex;
uniform int uHighQuality;
uniform int uHasCustomClouds;

uniform sampler2D uDayTex;
uniform sampler2D uNightTex;
uniform sampler2D uBrcTex;     // R: elevation/bump, G: roughness, B: clouds
uniform sampler2D uCloudTex;   // Optional custom cloud texture

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

vec3 rotateY(vec3 v, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
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

  // Add subtle high-frequency procedural wispiness so clouds stay crisp up close
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
  float star = exp(- (d * d) / (size * size));

  // Realistic star spectral color (O/B blue -> G white -> K/M amber)
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

    // Subtle Milky Way galactic band
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

  // Solar disk & corona
  float sunCos = max(dot(rd, sunDir), 0.0);
  float sunDisk = smoothstep(0.99978, 0.99993, sunCos);
  float corona1 = pow(sunCos, 640.0) * 1.4;
  float corona2 = pow(sunCos, 48.0) * 0.09;
  vec3 sunCol = vec3(1.0, 0.97, 0.91);
  col += sunCol * (sunDisk * 28.0 + corona1 + corona2 * vec3(1.0, 0.88, 0.74));

  return col;
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

  // Calibrated to realistic space-photography optical depth (clear nadir, rich cobalt limb)
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
  // Ozone layer centered around ~25 km equivalent altitude
  float ozCenter = 0.0046 * max(uAtmoHeight, 0.25);
  float ozWidth = 0.0028 * max(uAtmoHeight, 0.25);
  float dOz = max(0.0, 1.0 - abs(altClamped - ozCenter) / ozWidth);
  return vec3(dR, dM, dOz);
}

vec3 computeOpticalDepthToSun(vec3 pos, vec3 sunDir, AtmoParams a, int lightSteps) {
  // Check planet shadow
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

  int viewSteps = (uHighQuality == 1) ? 56 : 18;
  int lightSteps = (uHighQuality == 1) ? 14 : 6;

  float dt = (tEnd - tStart) / float(viewSteps);
  float cosTheta = dot(rd, sunDir);

  // Rayleigh & Henyey-Greenstein Mie phase functions
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
// Main Raytrace Entry
// ---------------------------------------------------------------------------
void main() {
  // Low-discrepancy subpixel anti-aliasing in offline raytrace mode
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

  // Soft angular sun disk sampling during progressive raytracing
  vec3 sunDir = normalize(uSunDir);
  if (uHighQuality == 1) {
    vec2 sRnd = r2Sequence(uSampleIndex + 137);
    float angle = sRnd.x * TWO_PI;
    float radius = sqrt(sRnd.y) * 0.011; // ~0.63 deg solar disk penumbra
    vec3 sUp = abs(sunDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 sRight = normalize(cross(sUp, sunDir));
    vec3 sOrthoUp = cross(sunDir, sRight);
    sunDir = normalize(sunDir + (cos(angle) * sRight + sin(angle) * sOrthoUp) * radius);
  }

  AtmoParams atmo = getAtmoParams();
  float rCloud = R_EARTH + 0.0038 * max(uAtmoHeight, 0.4);

  vec2 atmoHit = intersectSphere(ro, rd, atmo.rAtmo);
  vec2 earthHit = intersectSphere(ro, rd, R_EARTH);
  vec2 cloudHit = intersectSphere(ro, rd, rCloud);

  float jitter = (uHighQuality == 1) ? hashSeed : 0.5;
  vec3 radiance = vec3(0.0);

  if (earthHit.x > 0.0) {
    // -----------------------------------------------------------------------
    // Ray hits Earth Surface
    // -----------------------------------------------------------------------
    vec3 hitPos = ro + rd * earthHit.x;
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

    // Tangent frame on sphere for 4K relief normal perturbation
    vec3 upRef = abs(N.y) < 0.995 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(upRef, N)); // East
    vec3 B = cross(N, T);                // North

    vec3 Nsurf = N;
    if (uBumpStrength > 0.001) {
      float eps = 0.00055;
      float hL = textureLod(uBrcTex, sphereToUv(normalize(N - T * eps), uEarthRot), 0.0).r;
      float hR = textureLod(uBrcTex, sphereToUv(normalize(N + T * eps), uEarthRot), 0.0).r;
      float hD = textureLod(uBrcTex, sphereToUv(normalize(N - B * eps), uEarthRot), 0.0).r;
      float hU = textureLod(uBrcTex, sphereToUv(normalize(N + B * eps), uEarthRot), 0.0).r;

      float reliefScale = uBumpStrength * 14.0 * landMask;
      Nsurf = normalize(N - ((hR - hL) * T + (hU - hD) * B) * reliefScale);
    }

    // Subtle ocean micro-waves for realistic sparkling sun glint
    if (oceanMask > 0.01) {
      vec3 wavePos = rotateY(N, uEarthRot) * 180.0;
      float w1 = valueNoise3D(wavePos) - 0.5;
      float w2 = valueNoise3D(wavePos * 2.1 + 19.3) - 0.5;
      vec3 Nocean = normalize(N + (T * w1 + B * w2) * 0.035);
      Nsurf = normalize(mix(Nsurf, Nocean, oceanMask));
    }

    // Atmospheric transmittance of sunlight reaching this surface point
    int surfLightSteps = (uHighQuality == 1) ? 14 : 6;
    vec3 sunOD = computeOpticalDepthToSun(hitPos + N * 0.0003, sunDir, atmo, surfLightSteps);
    vec3 sunTrans = (sunOD.x < 1e4) ? transmittanceFromOD(sunOD, atmo) : vec3(0.0);

    // Raytraced cloud shadow onto the Earth surface
    float cloudShadowFactor = 1.0;
    if (uCloudCover > 0.01 && uCloudShadow > 0.01 && dot(N, sunDir) > -0.05) {
      vec2 shHit = intersectSphere(hitPos, sunDir, rCloud);
      if (shHit.y > 0.0) {
        vec3 cloudShadowPos = hitPos + sunDir * shHit.y;
        float cDens = sampleCloudDensity(normalize(cloudShadowPos));
        cloudShadowFactor = 1.0 - cDens * uCloudShadow * 0.88;
      }
    }

    // Direct solar irradiance at surface
    float NdotL = max(dot(Nsurf, sunDir), 0.0);
    float macroNdotL = dot(N, sunDir);
    // Soft twilight grazing falloff
    float horizonVis = smoothstep(-0.04, 0.06, macroNdotL);
    vec3 directLight = vec3(3.85) * sunTrans * cloudShadowFactor * horizonVis;

    // Enhance landmass saturation & deep marine ocean color for crisp satellite look
    float lum = dot(dayAlbedo, vec3(0.2126, 0.7152, 0.0722));
    vec3 vividAlbedo = mix(vec3(lum), dayAlbedo, mix(1.12, 1.28, landMask));
    vividAlbedo = mix(vividAlbedo, vividAlbedo * vec3(0.68, 0.80, 1.04), oceanMask * 0.65);

    // Diffuse surface reflection
    vec3 diffuse = (vividAlbedo / PI) * NdotL * directLight;

    // Subtle atmospheric sky-dome bounce ambient on sunlit hemisphere
    vec3 skyAmbient = vec3(0.014, 0.032, 0.075) * uAtmoDensity * smoothstep(-0.14, 0.35, macroNdotL);
    vec3 surfColor = diffuse + vividAlbedo * skyAmbient * (0.35 + 0.65 * cloudShadowFactor);

    // Physically-based GGX Ocean Sun Glint
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

    // Night-side city lights
    if (uNightLights > 0.001) {
      float nightMask = smoothstep(0.09, -0.14, macroNdotL);
      vec3 lights = pow(max(nightSRGB, 0.0), vec3(2.0));
      // Warm sodium/LED city glow
      lights *= vec3(1.18, 0.96, 0.68);
      surfColor += lights * nightMask * uNightLights * 0.95;
    }

    // -----------------------------------------------------------------------
    // Elevated 3D Cloud Layer over Surface
    // -----------------------------------------------------------------------
    if (uCloudCover > 0.01 && cloudHit.x > 0.0 && cloudHit.x < earthHit.x) {
      vec3 cPos = ro + rd * cloudHit.x;
      vec3 cN = normalize(cPos);
      float cDens = sampleCloudDensity(cN);

      if (cDens > 0.005) {
        vec3 cSunOD = computeOpticalDepthToSun(cPos, sunDir, atmo, surfLightSteps);
        vec3 cSunTrans = (cSunOD.x < 1e4) ? transmittanceFromOD(cSunOD, atmo) : vec3(0.0);

        // Cloud self-shadowing: sample cloud slightly toward sun
        vec3 cShift = normalize(cN + sunDir * 0.0055);
        float cSelf = sampleCloudDensity(cShift);
        float selfShadow = mix(1.0, 0.58, clamp((cSelf - cDens) * 2.2 + 0.25, 0.0, 1.0));

        float cNdotL = dot(cN, sunDir);
        // Wrapped diffuse for multiple scattering inside clouds
        float wrapLight = smoothstep(-0.14, 0.85, cNdotL);
        float cosSun = dot(rd, sunDir);
        float silverLining = pow(max(cosSun, 0.0), 8.0) * 0.45 * (1.0 - cDens * 0.6);

        vec3 cloudDirect = vec3(1.28) * cSunTrans * (wrapLight * selfShadow + silverLining);
        vec3 cloudAmbient = vec3(0.018, 0.036, 0.08) * uAtmoDensity * smoothstep(-0.18, 0.28, cNdotL);
        vec3 cloudCol = cloudDirect + cloudAmbient;

        // Subtle warm glow of city lights diffusing through thin clouds on the night side
        if (uNightLights > 0.001) {
          float cNight = smoothstep(0.06, -0.15, cNdotL);
          vec3 underLights = pow(max(nightSRGB, 0.0), vec3(2.0)) * vec3(1.1, 0.85, 0.55);
          cloudCol += underLights * cNight * uNightLights * 0.22 * (1.0 - cDens * 0.55);
        }

        // Alpha composite cloud over surface
        float alpha = smoothstep(0.04, 0.88, cDens);
        surfColor = mix(surfColor, cloudCol, alpha);
      }
    }

    // -----------------------------------------------------------------------
    // Atmospheric In-Scattering & Aerial Perspective from Camera to Surface
    // -----------------------------------------------------------------------
    float tAtmoStart = max(atmoHit.x, 0.0);
    float tAtmoEnd = earthHit.x;
    vec3 inscatter, atmoTrans;
    integrateAtmosphere(ro, rd, tAtmoStart, tAtmoEnd, sunDir, atmo, jitter, inscatter, atmoTrans);

    radiance = surfColor * atmoTrans + inscatter;
  } else {
    // -----------------------------------------------------------------------
    // Ray misses Earth -> Deep Space + Atmospheric Limb Glow
    // -----------------------------------------------------------------------
    vec3 spaceCol = renderSpace(rd, sunDir);

    if (atmoHit.y > 0.0) {
      float tAtmoStart = max(atmoHit.x, 0.0);
      float tAtmoEnd = atmoHit.y;
      vec3 inscatter, atmoTrans;
      integrateAtmosphere(ro, rd, tAtmoStart, tAtmoEnd, sunDir, atmo, jitter, inscatter, atmoTrans);
      radiance = spaceCol * atmoTrans + inscatter;
    } else {
      radiance = spaceCol;
    }
  }

  // Clamp NaNs/Infs just in case
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

// ACES Filmic Tone Mapping (Narkowicz fit)
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

  // Subtle optical bloom for bright limb glow, sun glint & solar corona
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

  // Exposure & ACES Filmic Tone Mapping
  col *= uExposure;
  col = acesToneMap(col);

  // Subtle cinematic vignette
  vec2 vigUv = vUv * 2.0 - 1.0;
  float vig = 1.0 - 0.12 * dot(vigUv, vigUv);
  col *= clamp(vig, 0.82, 1.0);

  // Gamma encode to sRGB
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}
`;
