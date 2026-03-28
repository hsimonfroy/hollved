import appEvents from '../service/appEvents.js';
import eventify from 'ngraph.events';
import scene from '../store/scene.js';
import qs from 'qs';


var defaultConfig = {
  pos: { x: 0, y: 0, z: 0 },
//   rot: { x: -2.5270, y: -0.5051, z: -1.6015 },  // rotvec (axis * angle)
  rot: { x: -1.0710, y: 0.2761, z: -2.9080 },  // rotvec (axis * angle)
  zoom: 4000,
//   zoom: 10,
  mode: 'satellite',
  visibleTracers: null  // null means all tracers visible
};

export default appConfig();

function appConfig() {
  var hashConfig = parseFromHash(window.location.hash);
  var hashUpdate; // async hash update id

  var api = {
    getCameraPosition:  getCameraPosition,
    getCameraLookAt:    getCameraLookAt,
    getZoom:            getZoom,
    setCameraConfig:    setCameraConfig,
    getVisibleTracers:  getVisibleTracers,
    setVisibleTracers:  setVisibleTracers,
    getControlMode:     getControlMode,
    setControlMode:     setControlMode
  };

  appEvents.queryChanged.on(queryChanged);
  window.addEventListener('hashchange', queryChanged, false);

  eventify(api);
  return api;


  function getZoom() {
    return hashConfig.zoom;
  }

  function getVisibleTracers() {
    return hashConfig.visibleTracers;
  }

  function getCameraPosition() {
    return hashConfig.pos;
  }

  function getCameraLookAt() {
    // Convert stored rotvec → quaternion on the fly
    return rotvecToQuat(hashConfig.rot.x, hashConfig.rot.y, hashConfig.rot.z);
  }

  function queryChanged() {
    var next = parseFromHash(window.location.hash);

    var cameraChanged = !sameVec3(next.pos, hashConfig.pos) ||
                        !sameVec3(next.rot, hashConfig.rot) ||
                        next.zoom !== hashConfig.zoom ||
                        next.mode !== hashConfig.mode;
    var tracersChanged = !sameTracers(next.visibleTracers, hashConfig.visibleTracers);

    if (cameraChanged) {
      hashConfig.pos  = next.pos;
      hashConfig.rot  = next.rot;
      hashConfig.zoom = next.zoom;
      hashConfig.mode = next.mode;
      api.fire('camera');
    }
    if (tracersChanged) {
      hashConfig.visibleTracers = next.visibleTracers;
      api.fire('tracersChanged');
    }
  }

  function getControlMode() {
    return hashConfig.mode;
  }

  function setControlMode(m) {
    hashConfig.mode = m;
    updateHash();
  }

  function setVisibleTracers(tracerIds) {
    hashConfig.visibleTracers = tracerIds && tracerIds.length > 0 ? tracerIds : null;
    updateHash();
  }

  function setCameraConfig(pos, q, zoom) {
    var newRot = quatToRotvec(q.x, q.y, q.z, q.w);
    var changed = !sameVec3(pos, hashConfig.pos) ||
                  !sameVec3(newRot, hashConfig.rot) ||
                  zoom !== hashConfig.zoom;
    if (!changed) return;

    hashConfig.pos.x = pos.x; hashConfig.pos.y = pos.y; hashConfig.pos.z = pos.z;
    hashConfig.rot.x = newRot.x; hashConfig.rot.y = newRot.y; hashConfig.rot.z = newRot.z;
    hashConfig.zoom  = zoom;

    updateHash();
  }

  function updateHash() {
    var name = scene.getGraphName();
    var p = hashConfig.pos;
    var r = hashConfig.rot;
    var hash = '#/' + name +
      '?mode=' + hashConfig.mode +
      '&pos='  + Math.round(p.x) + ',' + Math.round(p.y) + ',' + Math.round(p.z) +
      '&rot='  + r.x.toFixed(4) + ',' + r.y.toFixed(4) + ',' + r.z.toFixed(4) +
      '&zoom=' + Math.round(hashConfig.zoom);

    if (hashConfig.visibleTracers) {
      hash += '&trace=' + hashConfig.visibleTracers.join(',');
    }

    setHash(hash);
  }

  function setHash(hash) {
    if (hashUpdate) {
      window.clearTimeout(hashUpdate);
    }
    hashUpdate = setTimeout(function() {
      if (window.history) {
        window.history.replaceState(undefined, undefined, hash);
      } else {
        window.location.replace(hash);
      }
      hashUpdate = null;
    }, 400);
  }

  function sameVec3(v1, v2) {
    if (!v1 || !v2) return false;
    return v1.x === v2.x && v1.y === v2.y && v1.z === v2.z;
  }

  function sameTracers(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; ++i) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function parseFromHash(hash) {
    if (!hash) return cloneDefault();

    var query = qs.parse(hash.split('?')[1]);

    var visibleTracers = defaultConfig.visibleTracers;
    if (query.trace) {
      var parsed = query.trace.split(',').filter(function(s) { return s.length > 0; });
      visibleTracers = parsed.length > 0 ? parsed : null;
    }

    return {
      pos:  parseCommaVec3(query.pos, defaultConfig.pos),
      rot:  parseCommaVec3(query.rot, defaultConfig.rot),
      zoom: getNumber(query.zoom, defaultConfig.zoom),
      mode: query.mode === 'spaceship' ? 'spaceship' : defaultConfig.mode,
      visibleTracers: visibleTracers
    };
  }
}

function cloneDefault() {
  return {
    pos:  { x: defaultConfig.pos.x, y: defaultConfig.pos.y, z: defaultConfig.pos.z },
    rot:  { x: defaultConfig.rot.x, y: defaultConfig.rot.y, z: defaultConfig.rot.z },
    zoom: defaultConfig.zoom,
    mode: defaultConfig.mode,
    visibleTracers: defaultConfig.visibleTracers
  };
}

function parseCommaVec3(str, def) {
  if (!str) return { x: def.x, y: def.y, z: def.z };
  var p = str.split(',');
  return {
    x: getNumber(p[0], def.x),
    y: getNumber(p[1], def.y),
    z: getNumber(p[2], def.z)
  };
}

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

function getNumber(x, defaultValue) {
  if (defaultValue === undefined) defaultValue = 0;
  x = parseFloat(x);
  if (isNaN(x)) return defaultValue;
  return x;
}
