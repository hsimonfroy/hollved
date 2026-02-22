/**
 * Graph loader downloads graph from repository. Each graph consist of:
 *
 * manifest.json - declares where the data is stored.
 *   Legacy format: { "all": ["v1", "v2"], "last": "v2" } (pick one version)
 *   Tracer format: same all/last structure, but each entry directory contains a
 *     meta.json with a "tracer" field → all entries are loaded simultaneously
 *     with per-tracer colors.
 *
 * positions.bin - a binary file of int32 triplets. Each triplet defines
 *   node position in 3d space. Index of triplet is considered as node id.
 * meta.json - optional metadata. If it has a "tracer" field the graph is treated
 *   as a multi-tracer dataset and all entries in manifest.all are loaded together.
 *
 * During download this downloader will report on global event bus its progress:
 *  appEvents.positionsDownloaded - positions file is downloaded;
 *  appEvents.tracerRangesReady - fired after positionsDownloaded with tracer metadata;
 */

import config from '../../config.js';
import request from './request.js';
import createGraph from './graph.js';
import appEvents from './appEvents.js';
import appConfig from '../native/appConfig.js';
import Promise from 'bluebird';

export default loadGraph;

/**
 * @param {string} name of the graph to be downloaded
 * @param {progressCallback} progress notifies when download progress event is received
 */
function loadGraph(name, progress) {
  var manifestEndpoint = config.dataUrl + name;

  return request(manifestEndpoint + '/manifest.json?nocache=' + (+new Date()), {
    responseType: 'json'
  }).then(function(manifest) {
    return loadFromManifest(manifest, manifestEndpoint, name, progress);
  });
}

function loadFromManifest(manifest, manifestEndpoint, name, progress) {
  var allEntries = manifest.all || [];

  if (allEntries.length === 0) {
    var endpoint = manifest.endpoint || manifestEndpoint;
    return loadSingleGraph(endpoint, name, progress).then(buildGraph);
  }

  // Probe the first entry's meta.json to detect tracer-mode vs version-mode
  var firstEntry = allEntries[0];
  var metaUrl = manifestEndpoint + '/' + firstEntry + '/meta.json?nocache=' + (+new Date());

  return request(metaUrl, { responseType: 'json' })
    .then(function(meta) {
      if (meta && meta.tracer) {
        return loadMultiTracer(manifest, manifestEndpoint, name, progress);
      }
      return loadLegacy(manifest, manifestEndpoint, name, progress);
    })
    .catch(function() {
      return loadLegacy(manifest, manifestEndpoint, name, progress);
    });
}

// ---------------------------------------------------------------------------
// Legacy (single version) loading
// ---------------------------------------------------------------------------

function loadLegacy(manifest, manifestEndpoint, name, progress) {
  var endpoint = manifest.endpoint
    ? manifest.endpoint
    : manifestEndpoint + '/' + manifest.last;
  return loadSingleGraph(endpoint, name, progress).then(buildGraph);
}

function loadSingleGraph(endpoint, name, progress) {
  var positions;

  return loadPositions().then(function() {
    return { positions: positions };
  });

  function loadPositions() {
    return request(endpoint + '/positions.bin', {
      responseType: 'arraybuffer',
      progress: reportProgress(name, 'positions', progress)
    }).then(function(buffer) {
      positions = new Int32Array(buffer);
      var scaleFactor = appConfig.getScaleFactor();
      for (var i = 0; i < positions.length; ++i) {
        positions[i] *= scaleFactor;
      }
      appEvents.positionsDownloaded.fire(positions);
    });
  }
}

// ---------------------------------------------------------------------------
// Multi-tracer loading
// ---------------------------------------------------------------------------

function loadMultiTracer(manifest, manifestEndpoint, name, progress) {
  var tracerIds = manifest.all;
  var scaleFactor = appConfig.getScaleFactor();

  return Promise.all(tracerIds.map(function(tracerId) {
    var endpoint = manifestEndpoint + '/' + tracerId;
    return loadTracerData(endpoint, tracerId, name, scaleFactor, progress);
  })).then(mergeTracers);
}

function loadTracerData(endpoint, tracerId, graphName, scaleFactor, progress) {
  var tracerMeta = {};
  var tracerPositions;

  return loadMeta()
    .then(loadPositions)
    .then(function() {
      var tracer = tracerMeta.tracer || {};
      return {
        id: tracer.id || tracerId,
        name: tracer.name || tracerId,
        color: parseColor(tracer.color || '0xffffffff'),
        positions: tracerPositions
      };
    });

  function loadMeta() {
    return request(endpoint + '/meta.json', { responseType: 'json' })
      .then(function(meta) { tracerMeta = meta || {}; })
      .catch(function() { /* meta.json optional */ });
  }

  function loadPositions() {
    return request(endpoint + '/positions.bin', {
      responseType: 'arraybuffer',
      progress: reportProgress(graphName + '/' + tracerId, 'positions', progress)
    }).then(function(buffer) {
      tracerPositions = new Int32Array(buffer);
      for (var i = 0; i < tracerPositions.length; ++i) {
        tracerPositions[i] *= scaleFactor;
      }
    });
  }
}

function mergeTracers(tracerDataArray) {
  var totalNodes = tracerDataArray.reduce(function(sum, t) {
    return sum + (t.positions.length / 3);
  }, 0);

  var allPositions = new Int32Array(totalNodes * 3);
  var tracerRanges = [];
  var nodeOffset = 0;
  var posOffset = 0;

  tracerDataArray.forEach(function(tracer) {
    var nodeCount = tracer.positions.length / 3;

    allPositions.set(tracer.positions, posOffset);
    posOffset += tracer.positions.length;

    tracerRanges.push({
      id: tracer.id,
      name: tracer.name,
      color: tracer.color,
      startNode: nodeOffset,
      nodeCount: nodeCount
    });

    nodeOffset += nodeCount;
  });

  appEvents.positionsDownloaded.fire(allPositions);
  appEvents.tracerRangesReady.fire(tracerRanges);

  return buildGraph({ positions: allPositions });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGraph(data) {
  return createGraph({
    positions: data.positions,
    labels: [],
    outLinks: [],
    inLinks: []
  });
}

function parseColor(colorStr) {
  if (typeof colorStr === 'number') return colorStr;
  return parseInt(String(colorStr).replace(/^0x/i, ''), 16);
}

function reportProgress(name, file, progress) {
  return function(e) {
    var progressInfo = {
      message: name + ': downloading ' + file,
    };
    if (e.percent !== undefined) {
      progressInfo.completed = Math.round(e.percent * 100) + '%';
    } else {
      progressInfo.completed = Math.round(e.loaded) + ' bytes';
    }
    progress(progressInfo);
  };
}
