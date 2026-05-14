import appEvents from '../service/appEvents.js';
import eventify from 'ngraph.events';
import scene from '../store/scene.js';
import qs from 'qs';
import { cartToRaDecR, raDec2Cart, unitVecToRaDec, raDec2UnitVec } from './coordUtils.js';

// Default view: Butterfly
var defaultConfig = {
  mode:   'satellite',
  pos:    { ra: 0.000, dec:  0.000, r:    0.000 },
  zen:    { ra: 270.000, dec: 0.000 },
  azaltr: { az:  28.000, alt:  0.000, r: 4000.000 },
  rot:    { x: 0.7600, y: 0.0000, z: 3.0483 },
  speed:  10.00,
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

  function setSatelliteState(pivot_xyz, radius, upAxis_xyz, az_deg, alt_deg) {
    var pr = cartToRaDecR(pivot_xyz.x, pivot_xyz.y, pivot_xyz.z);
    var ur = unitVecToRaDec(upAxis_xyz.x, upAxis_xyz.y, upAxis_xyz.z);

    var changed = hashConfig.mode !== 'satellite' ||
      !sameRaDecR(pr, hashConfig.pos) ||
      !sameRaDec(ur, hashConfig.zen) ||
      Math.abs(az_deg  - hashConfig.azaltr.az)  > 1e-4 ||
      Math.abs(alt_deg - hashConfig.azaltr.alt) > 1e-4 ||
      Math.abs(radius  - hashConfig.azaltr.r)   > 1e-4;

    if (!changed) return;

    hashConfig.mode   = 'satellite';
    hashConfig.pos    = pr;
    hashConfig.zen    = ur;
    hashConfig.azaltr = { az: az_deg, alt: alt_deg, r: radius };
    updateHash();
  }

  function setSpaceshipState(pos_xyz, q, speed) {
    var pr     = cartToRaDecR(pos_xyz.x, pos_xyz.y, pos_xyz.z);
    var newRot = quatToRotvec(q.x, q.y, q.z, q.w);

    var changed = hashConfig.mode !== 'spaceship' ||
      !sameRaDecR(pr, hashConfig.pos) ||
      !sameVec3(newRot, hashConfig.rot) ||
      Math.abs(speed - hashConfig.speed) > 1e-4;

    if (!changed) return;

    hashConfig.mode  = 'spaceship';
    hashConfig.pos   = pr;
    hashConfig.rot   = newRot;
    hashConfig.speed = speed;
    updateHash();
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
    var name = scene.getGraphName();
    var p    = hashConfig.pos;
    var hash = '#/' + name +
      '?pos=' + p.ra.toFixed(3) + ',' + p.dec.toFixed(3) + ',' + p.r.toFixed(3);

    if (hashConfig.mode === 'satellite') {
      var z = hashConfig.zen;
      var a = hashConfig.azaltr;
      hash += '&zen='    + z.ra.toFixed(3) + ',' + z.dec.toFixed(3);
      hash += '&azaltr=' + a.az.toFixed(3) + ',' + a.alt.toFixed(3) + ',' + a.r.toFixed(3);
    } else {
      var r = hashConfig.rot;
      hash += '&rot='   + r.x.toFixed(4) + ',' + r.y.toFixed(4) + ',' + r.z.toFixed(4);
      hash += '&speed=' + hashConfig.speed.toFixed(2);
    }

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

    var cameraChanged  = !stateEqual(next, hashConfig);
    var tracersChanged = !sameTracers(next.visibleTracers, hashConfig.visibleTracers);

    if (cameraChanged || tracersChanged) hashConfig = next;
    if (cameraChanged)  api.fire('camera');
    if (tracersChanged) api.fire('tracersChanged');
  }
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
  var posArr = parseFloats3(query.pos,
    defaultConfig.pos.ra, defaultConfig.pos.dec, defaultConfig.pos.r);

  if (mode === 'satellite') {
    var zenArr    = parseFloats2(query.zen,
      defaultConfig.zen.ra, defaultConfig.zen.dec);
    var azaltrArr = parseFloats3(query.azaltr,
      defaultConfig.azaltr.az, defaultConfig.azaltr.alt, defaultConfig.azaltr.r);
    return {
      mode:   'satellite',
      pos:    { ra: posArr[0],    dec: posArr[1],    r: posArr[2] },
      zen:    { ra: zenArr[0],    dec: zenArr[1] },
      azaltr: { az: azaltrArr[0], alt: azaltrArr[1], r: azaltrArr[2] },
      rot:    { x: defaultConfig.rot.x, y: defaultConfig.rot.y, z: defaultConfig.rot.z },
      speed:  defaultConfig.speed,
      visibleTracers: visibleTracers
    };
  } else {
    var rotArr = parseFloats3(query.rot,
      defaultConfig.rot.x, defaultConfig.rot.y, defaultConfig.rot.z);
    return {
      mode:   'spaceship',
      pos:    { ra: posArr[0], dec: posArr[1], r: posArr[2] },
      zen:    { ra: defaultConfig.zen.ra, dec: defaultConfig.zen.dec },
      azaltr: { az: defaultConfig.azaltr.az, alt: defaultConfig.azaltr.alt, r: defaultConfig.azaltr.r },
      rot:    { x: rotArr[0], y: rotArr[1], z: rotArr[2] },
      speed:  getNumber(query.speed, defaultConfig.speed),
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

function stateEqual(a, b) {
  if (a.mode !== b.mode) return false;
  if (!sameRaDecR(a.pos, b.pos)) return false;
  if (a.mode === 'satellite') {
    return sameRaDec(a.zen, b.zen) &&
      Math.abs(a.azaltr.az  - b.azaltr.az)  < 1e-4 &&
      Math.abs(a.azaltr.alt - b.azaltr.alt) < 1e-4 &&
      Math.abs(a.azaltr.r   - b.azaltr.r)   < 1e-4;
  }
  return sameVec3(a.rot, b.rot) && Math.abs(a.speed - b.speed) < 1e-4;
}

function sameRaDecR(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.ra  - b.ra)  < 1e-4 &&
         Math.abs(a.dec - b.dec) < 1e-4 &&
         Math.abs(a.r   - b.r)   < 1e-4;
}

function sameRaDec(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.ra - b.ra) < 1e-4 && Math.abs(a.dec - b.dec) < 1e-4;
}

function sameVec3(v1, v2) {
  if (!v1 || !v2) return false;
  return v1.x === v2.x && v1.y === v2.y && v1.z === v2.z;
}

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
