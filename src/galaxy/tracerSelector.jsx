/**
 * TracerSelector renders a small overlay panel listing all tracers with
 * visibility toggles. It only appears when a multi-tracer graph is loaded
 * (i.e. when appEvents.tracerRangesReady has fired).
 *
 * When manifest.densities is present a ▾ button expands the panel to show
 * a DensityChart below the tracer list. The tracer rows act as an interactive
 * legend — toggling a tracer hides/shows its density curve too.
 *
 * Layout:
 *   GALAXIES  1,234,567          ← sum of visible survey tracer counts
 *   ─────────────────────
 *   ☑ ■ LRG                     ← survey tracer rows (with color swatch)
 *   ☑ ■ ELG
 *   ...
 *   ▾                            ← expand/collapse chart (only when densities present)
 *   ─────────────────────
 *   ☑ ■ Local                   ← aux tracers (swatch when color is set)
 *   ☐ ■ CMB
 *   [satellite only:]
 *   ☐   Radar
 *   ☐   Slice
 */
import { useState, useEffect } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';
import DensityChart from './densityChart.jsx';

var DEFAULT_HIDDEN    = ['cmb', 'radar', 'slice'];
var AUX_IDS           = ['local', 'mw_old', 'cmb', 'radar', 'slice'];
var SATELLITE_AUX_IDS = ['radar', 'slice']; // only shown in satellite mode

export default function TracerSelector() {
  var [tracers, setTracers]     = useState([]);
  var [densities, setDensities] = useState(null);
  var [chartOpen, setChartOpen] = useState(false);
  var [xMode, setXMode]         = useState('chi');
  var [yMode, setYMode]         = useState('volume');
  var [isSatellite, setIsSatellite] = useState(appConfig.getControlMode() === 'satellite');

  useEffect(function() {
    function handleTracerRanges(ranges) {
      setDensities(null);
      setChartOpen(false);

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
      // Append AUX tracers
      mapped.push({
        id: 'local', name: 'Local', color: 0xbbbbbbff, count: null,
        visible: configVisible ? configVisible.indexOf('local') >= 0 : true
      });
      mapped.push({
        id: 'mw_old', name: 'MW (old)', color: null, count: null,
        visible: configVisible ? configVisible.indexOf('mw_old') >= 0 : true
      });
      mapped.push({
        id: 'cmb', name: 'CMB', color: 0x222222ff, count: null,
        visible: configVisible ? configVisible.indexOf('cmb') >= 0 : false
      });
      mapped.push({
        id: 'radar', name: 'Radar', color: null, count: null,
        visible: configVisible ? configVisible.indexOf('radar') >= 0 : false
      });
      mapped.push({
        id: 'slice', name: 'Slice', color: null, count: null,
        visible: configVisible ? configVisible.indexOf('slice') >= 0 : false
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

  useEffect(function() {
    function handleDensities(data) { setDensities(data); }
    appEvents.densitiesReady.on(handleDensities);
    return function() { appEvents.densitiesReady.off(handleDensities); };
  }, []);

  useEffect(function() {
    function handleModeChange(mode) { setIsSatellite(mode === 'satellite'); }
    appEvents.controlModeChanged.on(handleModeChange);
    return function() { appEvents.controlModeChanged.off(handleModeChange); };
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

  // Sum counts for visible survey (non-aux) tracers only
  var galaxyCount = tracers.reduce(function(sum, t) {
    if (AUX_IDS.indexOf(t.id) >= 0 || !t.visible || !t.count) return sum;
    return sum + t.count;
  }, 0);

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
        {tracer.color !== null && <span style={swatchStyle}></span>}
        <span>{tracer.name}</span>
      </label>
    );
  }

  var surveyRows = tracers.filter(function(t) { return AUX_IDS.indexOf(t.id) < 0; }).map(makeRow);
  var auxRows    = tracers.filter(function(t) { return AUX_IDS.indexOf(t.id) >= 0 && SATELLITE_AUX_IDS.indexOf(t.id) < 0; }).map(makeRow);
  var satAuxRows = tracers.filter(function(t) { return SATELLITE_AUX_IDS.indexOf(t.id) >= 0; }).map(makeRow);

  return (
    <div className={'tracer-selector' + (chartOpen ? ' tracer-selector--expanded' : '')}>
      <div className="tracer-selector-list">
        <span className="camera-hud-value">{formatCount(galaxyCount)}</span>
        <span className="camera-hud-label">Galaxies</span>
        {surveyRows}
        {densities && (
          <div>
            <button
              className={'density-chart-toggle' + (chartOpen ? ' open' : '')}
              onClick={function() { setChartOpen(function(v) { return !v; }); }}
              title={chartOpen ? 'Hide density chart' : 'Show density chart'}
            >
              <span className="camera-hud-label">Densities</span>
              <span className="density-chart-toggle-arrow">›</span>
            </button>
          </div>
        )}
        <hr className="tracer-selector-sep" />
        {auxRows}
        {isSatellite && satAuxRows}
      </div>
      {chartOpen && densities && (
        <div className="tracer-selector-chart-panel">
          <DensityChart
            tracers={tracers}
            densities={densities}
            xMode={xMode}
            yMode={yMode}
            onXMode={setXMode}
            onYMode={setYMode}
          />
        </div>
      )}
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
  return n.toLocaleString('en-US');
}
