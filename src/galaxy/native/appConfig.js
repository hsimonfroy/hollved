import appEvents from '../service/appEvents.js';
import eventify from 'ngraph.events';
import scene from '../store/scene.js';
import qs from 'qs';
import { cartToRaDecR, raDec2Cart, unitVecToRaDec, raDec2UnitVec } from './coordUtils.js';

// Distances and speeds span 25 orders of magnitude — a spaceship crossing a
// planet's surface at 1e-16 Mpc/s, a satellite orbit at 1e4 Mpc. Fixed-point
// decimals cannot hold that: .toFixed(3) writes every solar-system radius as
// "0.000". So the three magnitudes below are stored as log10 of the SI value
// (metres, m/s), trading absolute resolution for relative resolution — a flat
// ±0.115% at every scale, which is what a zoom actually needs.
var MPC_TO_M = 3.085677581e22;  // matches KM_TO_MPC in solarRenderer.js
var LOG_MAX  = 28;              // 1e28 m ~ 3e5 Mpc, past CAMERA_FAR (1e5 Mpc)

// Mpc -> log10(metres). Floored at 1 m so r = 0 writes a clean "0.000" rather
// than -Infinity; 1 m is 3.2e-23 Mpc, which cartToRaDecR already collapses back
// to exactly 0, so the origin is a stable cycle.
function toLog(mpc) {
  return Math.log10(Math.max(mpc * MPC_TO_M, 1));
}

// log10(metres) -> Mpc. The clamp is load-bearing: a pre-existing bookmark holds
// azaltr=...,4000, and 10^4000 is Infinity, which turns the camera matrix to NaN
// and the screen black. Clamped, an old link degrades to a very distant view.
function fromLog(log) {
  return Math.pow(10, Math.min(Math.max(log, 0), LOG_MAX)) / MPC_TO_M;
}

// Default view: Butterfly. Written the way the hash writes them, so the default
// and its own serialisation are the same number and reloading never nudges it.
var LOG_POS_R  = 0.000;   // 1 m from the origin — the origin, at scene scale
var LOG_RADIUS = 26;  // ~ 4000 Mpc
var LOG_SPEED  = 22.5;  // ~ 1 Mpc/s

var defaultConfig = {
  mode:   'satellite',
  pos:    { ra: 0.000, dec:  0.000, r: fromLog(LOG_POS_R) },
  zen:    { ra: 270.000, dec: 0.000 },
  azaltr: { az:  28.000, alt:  0.000, r: fromLog(LOG_RADIUS) },
  rot:    { x: 0.760, y: 0.000, z: 3.048 },
  speed:  fromLog(LOG_SPEED), // Mpc/s
  visibleTracers: null
};

export default appConfig();

function appConfig() {
  var hashConfig = parseFromHash(window.location.hash);
  var hashUpdate;

  var api = {
    getCameraPosition:  getCameraPosition,
    getUpAxis:          getUpAxis,
    getAzAlt:           getAzAlt,
    getRadius:          getRadius,
    getCameraLookAt:    getCameraLookAt,
    getSpeed:           getSpeed,
    getVisibleTracers:  getVisibleTracers,
    setVisibleTracers:  setVisibleTracers,
    getControlMode:     getControlMode,
    setControlMode:     setControlMode,
    setSatelliteState:  setSatelliteState,
    setSpaceshipState:  setSpaceshipState
  };

  appEvents.queryChanged.on(queryChanged);
  window.addEventListener('hashchange', queryChanged, false);

  eventify(api);
  return api;

  // ── Getters ─────────────────────────────────────────────────────────────────

  function getCameraPosition() {
    var p = hashConfig.pos;
    return raDec2Cart(p.ra, p.dec, p.r);
  }

  function getUpAxis() {
    var z = hashConfig.zen;
    return raDec2UnitVec(z.ra, z.dec);
  }

  function getAzAlt() {
    return { az: hashConfig.azaltr.az, alt: hashConfig.azaltr.alt };
  }

  function getRadius() {
    return hashConfig.azaltr.r;
  }

  function getCameraLookAt() {
    var r = hashConfig.rot;
    return rotvecToQuat(r.x, r.y, r.z);
  }

  function getSpeed() {
    return hashConfig.speed;
  }

  function getVisibleTracers() {
    return hashConfig.visibleTracers;
  }

  function getControlMode() {
    return hashConfig.mode;
  }

  // ── Setters ─────────────────────────────────────────────────────────────────

  // Both setters write first and compare afterwards: two states are "the same
  // view" exactly when they serialise identically. The comparison this replaced
  // was five hand-tuned ABSOLUTE epsilons (1e-4), and at a radius of 1e-15 Mpc no
  // zoom, however large, ever cleared one — the URL simply stopped updating in
  // the regime the log encoding exists to serve.
  function setSatelliteState(pivot_xyz, radius, upAxis_xyz, az_deg, alt_deg) {
    var before = formatCamera(hashConfig);

    hashConfig.mode   = 'satellite';
    hashConfig.pos    = cartToRaDecR(pivot_xyz.x, pivot_xyz.y, pivot_xyz.z);
    hashConfig.zen    = unitVecToRaDec(upAxis_xyz.x, upAxis_xyz.y, upAxis_xyz.z);
    hashConfig.azaltr = { az: az_deg, alt: alt_deg, r: radius };

    if (formatCamera(hashConfig) !== before) updateHash();
  }

  function setSpaceshipState(pos_xyz, q, speed) {
    var before = formatCamera(hashConfig);

    hashConfig.mode  = 'spaceship';
    hashConfig.pos   = cartToRaDecR(pos_xyz.x, pos_xyz.y, pos_xyz.z);
    hashConfig.rot   = quatToRotvec(q.x, q.y, q.z, q.w);
    hashConfig.speed = speed;

    if (formatCamera(hashConfig) !== before) updateHash();
  }

  function setVisibleTracers(tracerIds) {
    hashConfig.visibleTracers = tracerIds !== undefined ? tracerIds : null;
    updateHash();
  }

  function setControlMode(m) {
    hashConfig.mode = m;
    updateHash();
  }

  // ── Hash serialization ──────────────────────────────────────────────────────

  function updateHash() {
    var hash = '#/' + scene.getGraphName() + '?' + formatCamera(hashConfig);

    if (hashConfig.visibleTracers !== null) {
      hash += '&trace=' + hashConfig.visibleTracers.join(',');
    }

    setHash(hash);
  }

  function setHash(hash) {
    if (hashUpdate) window.clearTimeout(hashUpdate);
    hashUpdate = setTimeout(function() {
      if (window.history) {
        window.history.replaceState(undefined, undefined, hash);
      } else {
        window.location.replace(hash);
      }
      hashUpdate = null;
    }, 400);
  }

  // ── Hash change listener ────────────────────────────────────────────────────

  function queryChanged() {
    var next = parseFromHash(window.location.hash);

    var cameraChanged  = formatCamera(next) !== formatCamera(hashConfig);
    var tracersChanged = !sameTracers(next.visibleTracers, hashConfig.visibleTracers);

    if (cameraChanged || tracersChanged) hashConfig = next;
    if (cameraChanged)  api.fire('camera');
    if (tracersChanged) api.fire('tracersChanged');
  }
}

// ── Serialization ─────────────────────────────────────────────────────────────

// The camera half of the query — and, because it is the only thing the URL
// records, the definition of "the view changed". Distances go through toLog;
// zen, az/alt and rot do not, being pure orientation, where 0.001 of a unit is
// well under a pixel at any zoom.
function formatCamera(c) {
  var s = 'pos=' + fix3(c.pos.ra) + ',' + fix3(c.pos.dec) + ',' + fix3(toLog(c.pos.r));
  if (c.mode === 'satellite') {
    s += '&zen='    + fix3(c.zen.ra) + ',' + fix3(c.zen.dec);
    s += '&azaltr=' + fix3(c.azaltr.az) + ',' + fix3(c.azaltr.alt) +
                                          ',' + fix3(toLog(c.azaltr.r));
  } else {
    s += '&rot='   + fix3(c.rot.x) + ',' + fix3(c.rot.y) + ',' + fix3(c.rot.z);
    s += '&speed=' + fix3(toLog(c.speed));
  }
  return s;
}

// A hair below zero formats as "-0.000", which is honest but ugly in a URL and,
// now that the string IS the equality test, counts as a change when the view has
// not moved. Both spellings mean the same thing at this resolution.
function fix3(x) {
  var s = x.toFixed(3);
  return s === '-0.000' ? '0.000' : s;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseFromHash(hash) {
  if (!hash) return cloneDefault();

  var query = qs.parse(hash.split('?')[1]);

  var visibleTracers = defaultConfig.visibleTracers;
  if ('trace' in query) {
    visibleTracers = query.trace
      ? query.trace.split(',').filter(function(s) { return s.length > 0; })
      : [];
  }

  var mode = ('rot' in query || 'speed' in query) ? 'spaceship' : 'satellite';
  // The third component is log10(metres) — its fallback is a log too, so a
  // missing field and a present one decode through exactly the same path.
  var posArr = parseFloats3(query.pos,
    defaultConfig.pos.ra, defaultConfig.pos.dec, LOG_POS_R);

  if (mode === 'satellite') {
    var zenArr    = parseFloats2(query.zen,
      defaultConfig.zen.ra, defaultConfig.zen.dec);
    var azaltrArr = parseFloats3(query.azaltr,
      defaultConfig.azaltr.az, defaultConfig.azaltr.alt, LOG_RADIUS);
    return {
      mode:   'satellite',
      pos:    { ra: posArr[0],    dec: posArr[1],    r: fromLog(posArr[2])    },
      zen:    { ra: zenArr[0],    dec: zenArr[1] },
      azaltr: { az: azaltrArr[0], alt: azaltrArr[1], r: fromLog(azaltrArr[2]) },
      rot:    { x: defaultConfig.rot.x, y: defaultConfig.rot.y, z: defaultConfig.rot.z },
      speed:  defaultConfig.speed,
      visibleTracers: visibleTracers
    };
  } else {
    var rotArr = parseFloats3(query.rot,
      defaultConfig.rot.x, defaultConfig.rot.y, defaultConfig.rot.z);
    return {
      mode:   'spaceship',
      pos:    { ra: posArr[0], dec: posArr[1], r: fromLog(posArr[2]) },
      zen:    { ra: defaultConfig.zen.ra, dec: defaultConfig.zen.dec },
      azaltr: { az: defaultConfig.azaltr.az, alt: defaultConfig.azaltr.alt, r: defaultConfig.azaltr.r },
      rot:    { x: rotArr[0], y: rotArr[1], z: rotArr[2] },
      speed:  fromLog(getNumber(query.speed, LOG_SPEED)),
      visibleTracers: visibleTracers
    };
  }
}

function cloneDefault() {
  return {
    mode:   defaultConfig.mode,
    pos:    { ra: defaultConfig.pos.ra, dec: defaultConfig.pos.dec, r: defaultConfig.pos.r },
    zen:    { ra: defaultConfig.zen.ra, dec: defaultConfig.zen.dec },
    azaltr: { az: defaultConfig.azaltr.az, alt: defaultConfig.azaltr.alt, r: defaultConfig.azaltr.r },
    rot:    { x: defaultConfig.rot.x, y: defaultConfig.rot.y, z: defaultConfig.rot.z },
    speed:  defaultConfig.speed,
    visibleTracers: defaultConfig.visibleTracers
  };
}

// ── Equality helpers ──────────────────────────────────────────────────────────

function sameTracers(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; ++i) if (a[i] !== b[i]) return false;
  return true;
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseFloats3(str, d0, d1, d2) {
  if (!str) return [d0, d1, d2];
  var p = str.split(',');
  return [getNumber(p[0], d0), getNumber(p[1], d1), getNumber(p[2], d2)];
}

function parseFloats2(str, d0, d1) {
  if (!str) return [d0, d1];
  var p = str.split(',');
  return [getNumber(p[0], d0), getNumber(p[1], d1)];
}

function getNumber(x, defaultValue) {
  if (defaultValue === undefined) defaultValue = 0;
  x = parseFloat(x);
  if (isNaN(x)) return defaultValue;
  return x;
}

// ── Quaternion ↔ rotvec ───────────────────────────────────────────────────────

function quatToRotvec(qx, qy, qz, qw) {
  if (qw < 0) { qx = -qx; qy = -qy; qz = -qz; qw = -qw; }
  var angle = 2 * Math.acos(Math.min(1, qw));
  if (angle < 1e-10) return { x: 0, y: 0, z: 0 };
  var s = angle / Math.sin(angle / 2);
  return { x: qx * s, y: qy * s, z: qz * s };
}

function rotvecToQuat(rx, ry, rz) {
  var angle = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (angle < 1e-10) return { x: 0, y: 0, z: 0, w: 1 };
  var s = Math.sin(angle / 2) / angle;
  return { x: rx * s, y: ry * s, z: rz * s, w: Math.cos(angle / 2) };
}
