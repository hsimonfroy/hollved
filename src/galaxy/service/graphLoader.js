/**
 * Graph loader downloads graph from repository. Each graph consist of multiple
 * files:
 *
 * manifest.json - declares where the data is stored.
 *   Legacy format: { "all": ["v1", "v2"], "last": "v2" } (pick one version)
 *   Tracer format: same all/last structure, but each entry directory contains a
 *     meta.json with a "tracer" field → all entries are loaded simultaneously
 *     with per-tracer colors.
 *
 * positions.bin - a binary file of int32 triplets. Each triplet defines
 *   node position in 3d space. Index of triplet is considered as node id.
 * links.bin - a sequence of edges. Read https://github.com/anvaka/ngraph.tobinary#linksbin-format
 *   for more information about its structure.
 * labels.json - array of node names. Position of a label in the array corresponds
 *   to the triplet index.
 * meta.json - optional metadata. If it has a "tracer" field the graph is treated
 *   as a multi-tracer dataset and all entries in manifest.all are loaded together.
 *
 * During download this downloader will report on global event bus its progress:
 *  appEvents.labelsDownloaded - labels file is downloaded;
 *  appEvents.linksDownloaded - links file is downloaded;
 *  appEvents.positionsDownloaded - positions file is downloaded;
 *  appEvents.tracerRangesReady - fired after positionsDownloaded with tracer metadata;
 */

import config from '../../config.js';
import request from './request.js';
import createGraph from './graph.js';
import appEvents from './appEvents.js';
import appConfig from '../native/appConfig.js';
import asyncFor from 'rafor';
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
  var positions, labels;
  var outLinks = [];
  var inLinks = [];

  return loadPositions()
    .then(loadLinks)
    .then(loadLabels)
    .then(function() {
      return { positions: positions, labels: labels, outLinks: outLinks, inLinks: inLinks };
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

  function loadLinks() {
    return request(endpoint + '/links.bin', {
      responseType: 'arraybuffer',
      progress: reportProgress(name, 'links', progress)
    }).then(function(buffer) {
      var links = new Int32Array(buffer);
      if (links.length === 0) {
        appEvents.linksDownloaded.fire(outLinks, inLinks);
        return;
      }

      var lastArray = [];
      outLinks[0] = lastArray;
      var srcIndex;
      var processed = 0;
      var total = links.length;
      var deffered = defer();

      asyncFor(links, function processLink(link) {
        if (link < 0) {
          srcIndex = -link - 1;
          lastArray = outLinks[srcIndex] = [];
        } else {
          var toNode = link - 1;
          lastArray.push(toNode);
          if (inLinks[toNode] === undefined) {
            inLinks[toNode] = [srcIndex];
          } else {
            inLinks[toNode].push(srcIndex);
          }
        }
        processed += 1;
        if (processed % 10000 === 0) {
          progress({
            message: name + ': initializing edges ',
            completed: Math.round(processed / total * 100) + '%'
          });
        }
      }, function() {
        appEvents.linksDownloaded.fire(outLinks, inLinks);
        deffered.resolve();
      });

      return deffered.promise;
    });
  }

  function loadLabels() {
    return request(endpoint + '/labels.json', {
      responseType: 'json',
      progress: reportProgress(name, 'labels', progress)
    }).then(function(data) {
      labels = data;
      appEvents.labelsDownloaded.fire(labels);
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
  var tracerLabels = [];
  var tracerOutLinks = [];
  var tracerInLinks = [];

  return loadMeta()
    .then(loadPositions)
    .then(loadLinks)
    .then(loadLabels)
    .then(function() {
      var tracer = tracerMeta.tracer || {};
      return {
        id: tracer.id || tracerId,
        name: tracer.name || tracerId,
        color: parseColor(tracer.color || '0xffffffff'),
        positions: tracerPositions,
        labels: tracerLabels,
        outLinks: tracerOutLinks,
        inLinks: tracerInLinks
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

  function loadLinks() {
    return request(endpoint + '/links.bin', {
      responseType: 'arraybuffer',
      progress: reportProgress(graphName + '/' + tracerId, 'links', progress)
    }).then(function(buffer) {
      var links = new Int32Array(buffer);
      if (links.length === 0) return;

      var lastArray = [];
      tracerOutLinks[0] = lastArray;
      var srcIndex;

      return new Promise(function(resolve) {
        asyncFor(links, function processLink(link) {
          if (link < 0) {
            srcIndex = -link - 1;
            lastArray = tracerOutLinks[srcIndex] = [];
          } else {
            var toNode = link - 1;
            lastArray.push(toNode);
            if (tracerInLinks[toNode] === undefined) {
              tracerInLinks[toNode] = [srcIndex];
            } else {
              tracerInLinks[toNode].push(srcIndex);
            }
          }
        }, resolve);
      });
    });
  }

  function loadLabels() {
    return request(endpoint + '/labels.json', {
      responseType: 'json',
      progress: reportProgress(graphName + '/' + tracerId, 'labels', progress)
    }).then(function(data) { tracerLabels = data || []; });
  }
}

function mergeTracers(tracerDataArray) {
  var totalNodes = tracerDataArray.reduce(function(sum, t) {
    return sum + (t.positions.length / 3);
  }, 0);

  var allPositions = new Int32Array(totalNodes * 3);
  var allLabels = [];
  var tracerRanges = [];
  var allOutLinks = [];
  var allInLinks = [];
  var nodeOffset = 0;
  var posOffset = 0;

  tracerDataArray.forEach(function(tracer) {
    var nodeCount = tracer.positions.length / 3;

    allPositions.set(tracer.positions, posOffset);
    posOffset += tracer.positions.length;

    allLabels = allLabels.concat(tracer.labels);

    // Copy links with node-index offset applied
    for (var i = 0; i < tracer.outLinks.length; ++i) {
      var srcLinks = tracer.outLinks[i];
      if (srcLinks) {
        allOutLinks[i + nodeOffset] = srcLinks.map(function(n) { return n + nodeOffset; });
      }
    }
    for (var j = 0; j < tracer.inLinks.length; ++j) {
      var inList = tracer.inLinks[j];
      if (inList) {
        allInLinks[j + nodeOffset] = inList.map(function(n) { return n + nodeOffset; });
      }
    }

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
  appEvents.linksDownloaded.fire(allOutLinks, allInLinks);
  appEvents.labelsDownloaded.fire(allLabels);

  return buildGraph({
    positions: allPositions,
    labels: allLabels,
    outLinks: allOutLinks,
    inLinks: allInLinks
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildGraph(data) {
  return createGraph({
    positions: data.positions,
    labels: data.labels,
    outLinks: data.outLinks,
    inLinks: data.inLinks
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

function defer() {
  var resolve, reject;
  var promise = new Promise(function() {
    resolve = arguments[0];
    reject = arguments[1];
  });
  return {
    resolve: resolve,
    reject: reject,
    promise: promise
  };
}
