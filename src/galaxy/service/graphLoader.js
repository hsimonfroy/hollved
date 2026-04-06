/**
 * Loads a multi-tracer graph from the data server. Each graph has:
 *   <name>/manifest.json  — { "all": ["tracer1", "tracer2", ...] }
 *   <name>/<tracerId>/positions.bin  — float16 LE triplets (x,y,z per node, in Mpc)
 *   <name>/<tracerId>/meta.json      — optional, flat { id, name, count, color }
 *
 * Fires on the global event bus:
 *   appEvents.positionsDownloaded — merged Uint16Array of all positions (raw float16 bits)
 *   appEvents.tracerRangesReady   — array of { id, name, color, startNode, nodeCount }
 */

import config from '../../config.js';
import request from './request.js';
import appEvents from './appEvents.js';

export default loadGraph;

async function loadGraph(name, progress) {
  var [manifest] = await Promise.all([
    // request(config.dataUrl + name + '/manifest.json?nocache=' + (+new Date()), { responseType: 'json' }),
    request(config.dataUrl + name + '/manifest.json', { responseType: 'json' }),
    fetchRadar()
  ]);
  var tracers = await Promise.all(manifest.all.map(function(tracerId) {
    return loadTracerData(config.dataUrl + name + '/' + tracerId, tracerId, name, progress);
  }));
  mergeTracers(tracers);
}

async function fetchRadar() {
  try {
    // var data = await request(config.dataUrl + 'radar.json?nocache=' + (+new Date()), { responseType: 'json' });
    var data = await request(config.dataUrl + 'aux/radar.json', { responseType: 'json' });
    appEvents.radarReady.fire(data);
  } catch (_) {
    // radar.json not found or network error — degrade gracefully (no ruler rings)
    appEvents.radarReady.fire({ ring: [], sphere: [], hud: null });
  }
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
  var positions = new Uint16Array(buffer);  // raw float16 bits

  return {
    id:        meta.id    || tracerId,
    name:      meta.name  || tracerId,
    color:     parseColor(meta.color || '0xffffffff'),
    positions: positions
  };
}

function mergeTracers(tracerDataArray) {
  var totalNodes = tracerDataArray.reduce(function(sum, t) {
    return sum + (t.positions.length / 3);
  }, 0);

  var allPositions = new Uint16Array(totalNodes * 3);
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
      message: name + ' loading',
    };
    if (e.percent !== undefined) {
      progressInfo.completed = Math.round(e.percent * 100) + '%';
    } else {
      progressInfo.completed = Math.round(e.loaded) + ' bytes';
    }
    progress(progressInfo);
  };
}
