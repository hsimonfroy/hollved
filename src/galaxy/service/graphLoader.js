/**
 * Loads a multi-tracer graph from the data server. Each graph has:
 *   <name>/manifest.json  — { "all": ["tracer1", "tracer2", ...] }
 *   <name>/<tracerId>/positions.bin  — int32 triplets (x,y,z per node)
 *   <name>/<tracerId>/meta.json      — optional, contains tracer.id/name/color
 *
 * Fires on the global event bus:
 *   appEvents.positionsDownloaded — merged Float32Array of all positions
 *   appEvents.tracerRangesReady   — array of { id, name, color, startNode, nodeCount }
 */

import config from '../../config.js';
import request from './request.js';
import appEvents from './appEvents.js';

export default loadGraph;

async function loadGraph(name, progress) {
  var manifest = await request(
    config.dataUrl + name + '/manifest.json?nocache=' + (+new Date()),
    { responseType: 'json' }
  );
  var tracers = await Promise.all(manifest.all.map(function(tracerId) {
    return loadTracerData(config.dataUrl + name + '/' + tracerId, tracerId, name, progress);
  }));
  mergeTracers(tracers);
}

async function loadTracerData(endpoint, tracerId, graphName, progress) {
  var meta = {};
  try {
    meta = await request(endpoint + '/meta.json', { responseType: 'json' }) || {};
  } catch (_) { /* meta.json is optional */ }

  var buffer = await request(endpoint + '/positions.bin', {
    responseType: 'arraybuffer',
    progress: reportProgress(graphName + '/' + tracerId, 'positions', progress)
  });
  var positions = new Float32Array(new Int32Array(buffer));

  var tracer = meta.tracer || {};
  return {
    id:        tracer.id    || tracerId,
    name:      tracer.name  || tracerId,
    color:     parseColor(tracer.color || '0xffffffff'),
    positions: positions
  };
}

function mergeTracers(tracerDataArray) {
  var totalNodes = tracerDataArray.reduce(function(sum, t) {
    return sum + (t.positions.length / 3);
  }, 0);

  var allPositions = new Float32Array(totalNodes * 3);
  var tracerRanges = [];
  var nodeOffset = 0;
  var posOffset = 0;

  tracerDataArray.forEach(function(tracer) {
    var nodeCount = tracer.positions.length / 3;

    allPositions.set(tracer.positions, posOffset);
    posOffset += tracer.positions.length;

    tracerRanges.push({
      id:        tracer.id,
      name:      tracer.name,
      color:     tracer.color,
      startNode: nodeOffset,
      nodeCount: nodeCount
    });

    nodeOffset += nodeCount;
  });

  appEvents.positionsDownloaded.fire(allPositions);
  appEvents.tracerRangesReady.fire(tracerRanges);
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
