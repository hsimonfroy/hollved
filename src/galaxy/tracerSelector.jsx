/**
 * TracerSelector renders a small overlay panel listing all tracers with
 * visibility toggles. It only appears when a multi-tracer graph is loaded
 * (i.e. when appEvents.tracerRangesReady has fired).
 *
 * Layout:
 *   GALAXIES  1,234,567          ← sum of visible non-synthetic tracer counts
 *   ─────────────────────
 *   ☑ ■ LRG                     ← tracer rows
 *   ☑ ■ ELG
 *   ...
 *   ☐ ■ CMB
 *   ☐ ■ Radar
 */
import { useState, useEffect } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';

var DEFAULT_HIDDEN = ['cmb', 'radar'];
var SYNTHETIC_IDS  = ['cmb', 'radar'];

export default function TracerSelector() {
  var [tracers, setTracers] = useState([]);

  useEffect(function() {
    function handleTracerRanges(ranges) {
      var configVisible = appConfig.getVisibleTracers();
      var mapped = ranges.map(function(r) {
        return {
          id:      r.id,
          name:    r.name,
          color:   r.color,
          count:   r.count || null,
          visible: configVisible ? configVisible.indexOf(r.id) >= 0 : DEFAULT_HIDDEN.indexOf(r.id) < 0
        };
      });
      // Append synthetic CMB tracer
      mapped.push({
        id: 'cmb', name: 'CMB', color: 0x222222ff, count: null,
        visible: configVisible ? configVisible.indexOf('cmb') >= 0 : false
      });
      // Append synthetic Radar tracer
      mapped.push({
        id: 'radar', name: 'Radar', color: 0xbbbbbbff, count: null,
        visible: configVisible ? configVisible.indexOf('radar') >= 0 : false
      });
      setTracers(mapped);
    }

    appEvents.tracerRangesReady.on(handleTracerRanges);
    return function() { appEvents.tracerRangesReady.off(handleTracerRanges); };
  }, []);

  useEffect(function() {
    function onExternalTracerChange() {
      var configVisible = appConfig.getVisibleTracers();
      setTracers(function(prev) {
        return prev.map(function(t) {
          return {
            id: t.id, name: t.name, color: t.color, count: t.count,
            visible: configVisible ? configVisible.indexOf(t.id) >= 0 : DEFAULT_HIDDEN.indexOf(t.id) < 0
          };
        });
      });
    }
    appConfig.on('tracersChanged', onExternalTracerChange);
    return function() { appConfig.off('tracersChanged', onExternalTracerChange); };
  }, []);

  function toggleTracer(tracerId, visible) {
    var newTracers = tracers.map(function(t) {
      return t.id === tracerId ? {id: t.id, name: t.name, color: t.color, count: t.count, visible: visible} : t;
    });
    setTracers(newTracers);

    appEvents.setTracerVisibility.fire(tracerId, visible);

    var visibleIds = newTracers.filter(function(t) { return t.visible; }).map(function(t) { return t.id; });
    var isDefault = newTracers.every(function(t) {
      return t.visible === (DEFAULT_HIDDEN.indexOf(t.id) < 0);
    });
    appConfig.setVisibleTracers(isDefault ? null : visibleIds);
  }

  if (tracers.length === 0) return null;

  // Sum counts for visible non-synthetic tracers
  var galaxyCount = null;
  tracers.forEach(function(t) {
    if (SYNTHETIC_IDS.indexOf(t.id) >= 0) return;
    if (!t.visible) return;
    if (t.count === null) return;
    if (galaxyCount === null) galaxyCount = 0;
    galaxyCount += t.count;
  });

  function makeRow(tracer) {
    var swatchStyle = {
      display: 'inline-block',
      width: '10px',
      height: '10px',
      backgroundColor: colorToCSS(tracer.color),
      border: '1px solid rgba(255,255,255,0.3)',
      flexShrink: 0
    };
    return (
      <label key={tracer.id} className="tracer-selector-item">
        <input
          type='checkbox'
          checked={tracer.visible}
          onChange={function(e) { toggleTracer(tracer.id, e.target.checked); }}
        />
        <span style={swatchStyle}></span>
        <span>{tracer.name}</span>
      </label>
    );
  }

  var surveyRows    = tracers.filter(function(t) { return SYNTHETIC_IDS.indexOf(t.id) < 0; }).map(makeRow);
  var syntheticRows = tracers.filter(function(t) { return SYNTHETIC_IDS.indexOf(t.id) >= 0; }).map(makeRow);

  return (
    <div className="tracer-selector">
      {/* <div className="tracer-selector-row" style={{flexDirection:'column', gap:0}}>
      </div> */}
        <span className="camera-hud-value">{formatCount(galaxyCount)}</span>
        <span className="camera-hud-label">Galaxies</span>
      {surveyRows}
      <hr className="tracer-selector-sep" />
      {syntheticRows}
    </div>
  );
}

function colorToCSS(color32) {
  var r = (color32 >>> 24) & 0xff;
  var g = (color32 >>> 16) & 0xff;
  var b = (color32 >>> 8)  & 0xff;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function formatCount(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US');
}
