// Great-Circle Autopilot Flight Engine for TERRA Earth Raytracer
// Supports Bush Plane, Business Jet, and Large Airliner with free 360° passenger/cockpit look-around

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const EARTH_RADIUS_KM = 6371;

export const AIRCRAFT_PROFILES = {
  bush: {
    id: 'bush',
    name: 'Buschflieger',
    shortLabel: 'BUSCHFLIEGER',
    cruiseAltKm: 4.6,
    minAltKm: 1.4,
    speedKmh: 240,
    defaultPitchDeg: -17,
    defaultTimeScale: 10,
  },
  bizjet: {
    id: 'bizjet',
    name: 'Business Jet',
    shortLabel: 'BUSINESS JET',
    cruiseAltKm: 8.2,
    minAltKm: 1.8,
    speedKmh: 760,
    defaultPitchDeg: -15,
    defaultTimeScale: 15,
  },
  airliner: {
    id: 'airliner',
    name: 'Großer Airliner',
    shortLabel: 'AIRLINER FL380',
    cruiseAltKm: 11.6,
    minAltKm: 2.2,
    speedKmh: 900,
    defaultPitchDeg: -14,
    defaultTimeScale: 20,
  },
};

export const SCENIC_ROUTES = {
  'muc-mxp': {
    label: 'München → Mailand (Alpen)',
    from: { name: 'München', lat: 48.1351, lon: 11.5820 },
    to:   { name: 'Mailand', lat: 45.4642, lon: 9.1900 },
  },
  'zrh-nce': {
    label: 'Zürich → Nizza (Matterhorn)',
    from: { name: 'Zürich', lat: 47.3769, lon: 8.5417 },
    to:   { name: 'Nizza',  lat: 43.7102, lon: 7.2620 },
  },
  'inn-vce': {
    label: 'Innsbruck → Venedig',
    from: { name: 'Innsbruck', lat: 47.2692, lon: 11.4041 },
    to:   { name: 'Venedig',   lat: 45.4408, lon: 12.3155 },
  },
  'las-gcn': {
    label: 'Las Vegas → Grand Canyon',
    from: { name: 'Las Vegas',    lat: 36.1699, lon: -115.1398 },
    to:   { name: 'Grand Canyon', lat: 36.1069, lon: -112.1129 },
  },
  'tyo-kix': {
    label: 'Tokio → Kyoto (Mt. Fuji)',
    from: { name: 'Tokio', lat: 35.6762, lon: 139.6503 },
    to:   { name: 'Kyoto', lat: 35.0116, lon: 135.7681 },
  },
  'ber-par': {
    label: 'Berlin → Paris',
    from: { name: 'Berlin', lat: 52.5200, lon: 13.4050 },
    to:   { name: 'Paris',  lat: 48.8566, lon: 2.3522 },
  },
  'tle-moq': {
    label: 'Toliara → Morondava (Madagaskar)',
    from: { name: 'Toliara',   lat: -23.3500, lon: 43.6667 },
    to:   { name: 'Morondava', lat: -20.2833, lon: 44.2833 },
  },
};

function latLonToVec3(latDeg, lonDeg) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const cl = Math.cos(lat);
  return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
}

function vec3ToLatLon(v) {
  const lat = Math.asin(Math.max(-1, Math.min(1, v[1]))) * RAD;
  const lon = Math.atan2(v[0], v[2]) * RAD;
  return { lat, lon };
}

function slerpVec3(a, b, t) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  dot = Math.max(-1, Math.min(1, dot));
  const omega = Math.acos(dot);
  if (omega < 1e-6) {
    return [a[0], a[1], a[2]];
  }
  const sinO = Math.sin(omega);
  const w0 = Math.sin((1 - t) * omega) / sinO;
  const w1 = Math.sin(t * omega) / sinO;
  return [
    a[0] * w0 + b[0] * w1,
    a[1] * w0 + b[1] * w1,
    a[2] * w0 + b[2] * w1,
  ];
}

function computeBearingDeg(lat1Deg, lon1Deg, lat2Deg, lon2Deg) {
  const lat1 = lat1Deg * DEG;
  const lat2 = lat2Deg * DEG;
  const dLon = (lon2Deg - lon1Deg) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * RAD) + 360) % 360;
}

export function offsetLatLon(latDeg, lonDeg, bearingDeg, distKm) {
  const ang = distKm / EARTH_RADIUS_KM;
  const lat1 = latDeg * DEG;
  const lon1 = lonDeg * DEG;
  const brg = bearingDeg * DEG;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(brg)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
    Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
  );
  return {
    lat: lat2 * RAD,
    lon: ((((lon2 * RAD + 180) % 360) + 360) % 360) - 180,
  };
}

export class FlightAutopilot {
  constructor() {
    this.active = false;
    this.paused = false;
    this.aircraftId = 'bush';
    this.timeScale = 10;

    this.from = SCENIC_ROUTES['muc-mxp'].from;
    this.to = SCENIC_ROUTES['muc-mxp'].to;
    this.vecA = latLonToVec3(this.from.lat, this.from.lon);
    this.vecB = latLonToVec3(this.to.lat, this.to.lon);
    this.totalDistKm = 0;

    this.progress = 0; // 0..1
    this.elapsedReal = 0;

    // Current telemetry
    this.lat = this.from.lat;
    this.lon = this.from.lon;
    this.altKm = 2.6;
    this.headingDeg = 180;
    this.speedKmh = 220;
    this.phase = 'CRUISE';

    // Free passenger/cockpit look-around offsets relative to aircraft heading
    this.lookYawDeg = 0;     // -180..+180 (0 = cockpit ahead, -75 = left window, +75 = right window)
    this.lookPitchDeg = -14; // -80..+65
  }

  startRoute(from, to, aircraftId = 'bush', timeScale = null) {
    const profile = AIRCRAFT_PROFILES[aircraftId] || AIRCRAFT_PROFILES.bush;
    this.aircraftId = profile.id;
    this.from = from;
    this.to = to;
    this.vecA = latLonToVec3(from.lat, from.lon);
    this.vecB = latLonToVec3(to.lat, to.lon);

    const dot = Math.max(-1, Math.min(1,
      this.vecA[0] * this.vecB[0] + this.vecA[1] * this.vecB[1] + this.vecA[2] * this.vecB[2]
    ));
    this.totalDistKm = Math.max(5, Math.acos(dot) * EARTH_RADIUS_KM);

    this.timeScale = timeScale !== null ? timeScale : profile.defaultTimeScale;
    this.progress = 0.02; // Start just airborne on climbout
    this.elapsedReal = 0;
    this.paused = false;
    this.active = true;
    this.lookYawDeg = 0;
    this.lookPitchDeg = profile.defaultPitchDeg;

    this._recomputePose();
  }

  stop() {
    this.active = false;
    this.paused = false;
  }

  setAircraft(aircraftId) {
    const profile = AIRCRAFT_PROFILES[aircraftId];
    if (!profile) return;
    this.aircraftId = profile.id;
    this._recomputePose();
  }

  setProgress(p) {
    this.progress = Math.max(0, Math.min(1, p));
    this._recomputePose();
  }

  setLookView(yawDeg, pitchDeg) {
    this.lookYawDeg = yawDeg;
    this.lookPitchDeg = pitchDeg;
  }

  step(dt) {
    if (!this.active) return;
    this.elapsedReal += dt;

    if (!this.paused) {
      const profile = AIRCRAFT_PROFILES[this.aircraftId];
      // km covered in dt seconds at current timeScale
      const kmPerSec = (profile.speedKmh / 3600) * this.timeScale;
      const dp = (kmPerSec * dt) / Math.max(this.totalDistKm, 1);
      this.progress = Math.min(1, this.progress + dp);
      if (this.progress >= 1) {
        this.paused = true;
      }
    }
    this._recomputePose();
  }

  _recomputePose() {
    const profile = AIRCRAFT_PROFILES[this.aircraftId];
    const p = this.progress;
    const posVec = slerpVec3(this.vecA, this.vecB, p);
    const cur = vec3ToLatLon(posVec);

    // Sample slightly ahead along the great circle for exact forward bearing
    const pAhead = Math.min(1, p + 0.002);
    const aheadVec = slerpVec3(this.vecA, this.vecB, pAhead);
    const ahead = vec3ToLatLon(aheadVec);

    this.lat = cur.lat;
    this.lon = cur.lon;
    if (pAhead > p + 1e-5) {
      this.headingDeg = computeBearingDeg(cur.lat, cur.lon, ahead.lat, ahead.lon);
    }

    // Realistic vertical flight profile: Climb (0..12%) -> Cruise -> Descent (88..100%)
    const climbFrac = Math.min(0.14, 22 / Math.max(this.totalDistKm, 40));
    const descFrac = Math.min(0.16, 26 / Math.max(this.totalDistKm, 40));
    let altFactor = 1.0;
    if (p < climbFrac) {
      const u = p / climbFrac;
      altFactor = u * u * (3 - 2 * u);
      this.phase = 'CLIMB';
    } else if (p > 1 - descFrac) {
      const u = (1 - p) / descFrac;
      altFactor = u * u * (3 - 2 * u);
      this.phase = p >= 0.995 ? 'ARRIVED' : 'APPROACH';
    } else {
      this.phase = 'CRUISE';
    }

    // Subtle gentle breathing motion on bush plane / airliner
    const gentleBob = Math.sin(this.elapsedReal * 0.7) * (this.aircraftId === 'bush' ? 0.012 : 0.004);
    this.altKm = profile.minAltKm + (profile.cruiseAltKm - profile.minAltKm) * altFactor + gentleBob;
    this.speedKmh = Math.round(profile.speedKmh * (0.65 + 0.35 * altFactor));
  }

  getRemainingKm() {
    return Math.max(0, this.totalDistKm * (1 - this.progress));
  }
}
