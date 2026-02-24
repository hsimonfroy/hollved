import appEvents from '../service/appEvents.js';
import eventify from 'ngraph.events';
import scene from '../store/scene.js';
import qs from 'qs';


var defaultConfig = {
  pos: {x : 0, y: 0, z: 0 },
//   lookAt: {x: -0.3582, y: -0.7468, z: -0.4612, w: -0.3182},
  lookAt: {x: -0.8317, y: -0.1663, z: -0.5269, w: 0.0539},
  maxVisibleDistance: 150,
  scale: 1.,
  visibleTracers: ['lrg', 'elg', 'qso']  // null means all tracers visible
};

export default appConfig();

function appConfig() {
  var hashConfig = parseFromHash(window.location.hash);
  var hashUpdate; // async hash update id

  var api = {
    getCameraPosition: getCameraPosition,
    getCameraLookAt: getCameraLookAt,
    getScaleFactor: getScaleFactor,
    getMaxVisibleEdgeLength: getMaxVisibleEdgeLength,
    setCameraConfig: setCameraConfig,
    getVisibleTracers: getVisibleTracers,
    setVisibleTracers: setVisibleTracers
  };

  appEvents.queryChanged.on(queryChanged);

  eventify(api);
  return api;


  function getScaleFactor() {
    return hashConfig.scale;
  }

  function getVisibleTracers() {
    return hashConfig.visibleTracers;
  }

  function getMaxVisibleEdgeLength() {
    return hashConfig.maxVisibleDistance * hashConfig.maxVisibleDistance * hashConfig.scale;
  }

  function getCameraPosition() {
    return hashConfig.pos;
  }

  function getCameraLookAt() {
    return hashConfig.lookAt;
  }

  function queryChanged() {
    var currentHashConfig = parseFromHash(window.location.hash);
    var cameraChanged = !same(currentHashConfig.pos, hashConfig.pos) ||
                        !same(currentHashConfig.lookAt, hashConfig.lookAt);
    var tracersChanged = !sameTracers(currentHashConfig.visibleTracers, hashConfig.visibleTracers);

    if (cameraChanged) {
      setCameraConfig(currentHashConfig.pos, currentHashConfig.lookAt);
      api.fire('camera');
    }
    if (tracersChanged) {
      hashConfig.visibleTracers = currentHashConfig.visibleTracers;
      api.fire('tracersChanged');
    }
  }

  function setVisibleTracers(tracerIds) {
    hashConfig.visibleTracers = tracerIds && tracerIds.length > 0 ? tracerIds : null;
    updateHash();
  }

  function setCameraConfig(pos, lookAt) {
    if (same(pos, hashConfig.pos) &&
        same(lookAt, hashConfig.lookAt) &&
        lookAt.w === hashConfig.lookAt.w) return;

    hashConfig.pos.x = pos.x;
    hashConfig.pos.y = pos.y;
    hashConfig.pos.z = pos.z;

    hashConfig.lookAt.x = lookAt.x;
    hashConfig.lookAt.y = lookAt.y;
    hashConfig.lookAt.z = lookAt.z;
    hashConfig.lookAt.w = lookAt.w;

    updateHash();
  }

  function updateHash() {
    var name = scene.getGraphName();
    var pos = hashConfig.pos;
    var lookAt = hashConfig.lookAt;
    var hash = '#/galaxy/' + name +
      '?cx=' + Math.round(pos.x) +
      '&cy=' + Math.round(pos.y) +
      '&cz=' + Math.round(pos.z) +
      '&lx=' + lookAt.x.toFixed(4) +
      '&ly=' + lookAt.y.toFixed(4) +
      '&lz=' + lookAt.z.toFixed(4) +
      '&lw=' + lookAt.w.toFixed(4) +
      '&ml=' + hashConfig.maxVisibleDistance +
      '&s=' + hashConfig.scale;

    if (hashConfig.visibleTracers) {
      hash += '&tracers=' + hashConfig.visibleTracers.join(',');
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

  function same(v1, v2) {
    if (!v1 || !v2) return false;
    return v1.x === v2.x &&
           v1.y === v2.y &&
           v1.z === v2.z;
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
    if (!hash) {
      return defaultConfig;
    }

    var query = qs.parse(hash.split('?')[1]);

    var pos = {
      x: getNumber(query.cx, defaultConfig.pos.x),
      y: getNumber(query.cy, defaultConfig.pos.y),
      z: getNumber(query.cz, defaultConfig.pos.z)
    };

    var lookAt = {
      x: getNumber(query.lx, defaultConfig.lookAt.x),
      y: getNumber(query.ly, defaultConfig.lookAt.y),
      z: getNumber(query.lz, defaultConfig.lookAt.z),
      w: getNumber(query.lw, defaultConfig.lookAt.w)
    };

    var visibleTracers = defaultConfig.visibleTracers;
    if (query.tracers) {
      var parsed = query.tracers.split(',').filter(function(s) { return s.length > 0; });
      visibleTracers = parsed.length > 0 ? parsed : null;
    }

    return {
      pos: normalize(pos),
      lookAt: normalize(lookAt),
      maxVisibleDistance: getNumber(query.ml, defaultConfig.maxVisibleDistance),
      scale: getNumber(query.s, defaultConfig.scale),
      visibleTracers: visibleTracers
    };
  }
}

function normalize(v) {
  if (!v) return v;
  v.x = getNumber(v.x);
  v.y = getNumber(v.y);
  v.z = getNumber(v.z);
  return v;
}

function getNumber(x, defaultValue) {
  if (defaultValue === undefined) defaultValue = 0;
  x = parseFloat(x);
  if (isNaN(x)) return defaultValue;
  return x;
}
