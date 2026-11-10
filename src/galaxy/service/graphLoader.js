/**
 * Loads a multi-tracer graph from the data server. Each graph has:
 *   <name>/manifest.json  — { "tracers": ["tracer1", "tracer2", ...] }
 *   <name>/<tracerId>/positions.bin  — float16 LE triplets (x,y,z per node, in Mpc)
 *   <name>/<tracerId>/meta.json      — optional, flat { id, name, count, color }
 *
 * Fires on the global event bus:
 *   appEvents.positionsDownloaded — array of { id, color, positions }, one per
 *                                   tracer, positions as raw float16 bits
 *   appEvents.tracerRangesReady   — array of { id, name, color, count }, for the UI.
 *                                   Kept apart so React never holds the buffers.
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
  var tracers = await Promise.all(manifest.tracers.map(function(tracerId) {
    return loadTracerData(config.dataUrl + name + '/' + tracerId, tracerId, name, progress);
  }));
  appEvents.positionsDownloaded.fire(tracers);
  appEvents.tracerRangesReady.fire(tracers.map(function(t) {
    return { id: t.id, name: t.name, color: t.color, count: t.count };
  }));
  if (manifest.densities) {
    appEvents.densitiesReady.fire(Object.assign({}, manifest.densities, { footprint: manifest.footprint || [] }));
  }
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

  var expectedBytes = meta.count ? meta.count * 3 * 2 : null;
  var buffer = await request(endpoint + '/positions.bin', {
    responseType: 'arraybuffer',
    progress: reportProgress(graphName + '/' + tracerId, progress, expectedBytes)
  });

  return {
    id:        meta.id    || tracerId,
    name:      meta.name  || tracerId,
    color:     parseColor(meta.color || '0xffffffff'),
    count:     meta.count || null,
    positions: new Uint16Array(buffer)  // raw float16 bits
  };
}

function parseColor(colorStr) {
  if (typeof colorStr === 'number') return colorStr;
  return parseInt(String(colorStr).replace(/^0x/i, ''), 16);
}

function reportProgress(name, progress, expectedBytes) {
  return function(e) {
    var progressInfo = { message: name + ' loading' };
    var total = e.total || expectedBytes;
    if (total) {
      progressInfo.completed = Math.round(e.loaded / total * 100) + '%';
    } else {
      progressInfo.completed = Math.round(e.loaded / 1e6 * 10) / 10 + ' MB';
    }
    progress(progressInfo);
  };
}
