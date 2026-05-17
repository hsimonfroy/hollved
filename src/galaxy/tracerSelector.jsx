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
var AUX_IDS           = ['local', 'cmb', 'radar', 'slice'];
var SATELLITE_AUX_IDS = ['radar', 'slice']; // only shown in satellite mode

export default function TracerSelector() {
  var [tracers, setTracers]     = useState([]);
  var [densities, setDensities] = useState(null);
  var [chartOpen, setChartOpen] = useState(false);
  var [labelOpen, setLabelOpen] = useState(false);
  var [flipping, setFlipping]   = useState(false);
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
        id: 'local', name: 'Local', color: '#8200ba', count: null,
        visible: configVisible ? configVisible.indexOf('local') >= 0 : true
      });
      mapped.push({
        id: 'cmb', name: 'CMB', color: '#555555', count: null,
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

  function toggleChart() {
    if (flipping) return;
    setFlipping(true);
    setChartOpen(function(v) { return !v; });
    setTimeout(function() { setLabelOpen(function(v) { return !v; }); }, 150);
    setTimeout(function() { setFlipping(false); }, 300);
  }

  if (tracers.length === 0) return null;

  // Sum counts for visible survey (non-aux) tracers only
  var galaxyCount = tracers.reduce(function(sum, t) {
    if (AUX_IDS.indexOf(t.id) >= 0 || !t.visible || !t.count) return sum;
    return sum + t.count;
  }, 0);

  function makeRow(tracer) {
    var inputStyle = tracer.color !== null
      ? { '--row-bg': colorToCSS(tracer.color), '--tick-color': tickColor(tracer.color) }
      : undefined;
    return (
      <label key={tracer.id} className="tracer-selector-item">
        <input
          type='checkbox'
          checked={tracer.visible}
          style={inputStyle}
          onChange={function(e) { toggleTracer(tracer.id, e.target.checked); }}
        />
        <span>{tracer.name}</span>
      </label>
    );
  }

  var surveyRows = tracers.filter(function(t) { return AUX_IDS.indexOf(t.id) < 0; }).map(makeRow);
  var auxRows    = tracers.filter(function(t) { return AUX_IDS.indexOf(t.id) >= 0 && SATELLITE_AUX_IDS.indexOf(t.id) < 0; }).map(makeRow);
  var satAuxRows = tracers.filter(function(t) { return SATELLITE_AUX_IDS.indexOf(t.id) >= 0; }).map(makeRow);

  return (
    <div className={
      'tracer-selector'
      + (chartOpen ? ' tracer-selector--expanded' : '')
      + (isSatellite ? ' is-satellite' : ' is-spaceship')
    }>
      <div className="tracer-selector-list">
        <span className="camera-hud-value">{formatCount(galaxyCount)}</span>
        <span className="camera-hud-label">Galaxies</span>
        {surveyRows}
        {densities && (
          <div>
            <button
              className={'density-chart-toggle camera-hud-label' + (flipping ? ' flipping' : '')}
              onClick={toggleChart}
              title={chartOpen ? 'Hide density chart' : 'Show density chart'}
            >
              {labelOpen
                ? <><span className="density-chart-toggle-arrow">‹</span>DENSITIES</>
                : <>DENSITIES<span className="density-chart-toggle-arrow">›</span></>}
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
  if (typeof color32 === 'string') return color32;
  var r = (color32 >>> 24) & 0xff;
  var g = (color32 >>> 16) & 0xff;
  var b = (color32 >>> 8)  & 0xff;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// Pick a tick color (black or white) based on Rec.709 relative luminance of the
// tracer color. Threshold is the only knob — tweak in one place to flip more
// colors one way or the other.
function tickColor(color32) {
  if (typeof color32 === 'string') {
    color32 = parseInt(color32.slice(1), 16);
  }
  var r = ((color32 >>> 24) & 0xff) / 255;
  var g = ((color32 >>> 16) & 0xff) / 255;
  var b = ((color32 >>> 8)  & 0xff) / 255;
  var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.2 ? '#000' : '#fff';
}

function formatCount(n) {
  return n.toLocaleString('en-US');
}
