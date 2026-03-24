/**
 * TracerSelector renders a small overlay panel listing all tracers with
 * visibility toggles. It only appears when a multi-tracer graph is loaded
 * (i.e. when appEvents.tracerRangesReady has fired).
 */
import { useState, useEffect } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';

export default function TracerSelector() {
  var [tracers, setTracers] = useState([]);

  useEffect(function() {
    function handleTracerRanges(ranges) {
      var configVisible = appConfig.getVisibleTracers();
      var mapped = ranges.map(function(r) {
        return {
          id: r.id,
          name: r.name,
          color: r.color,
          visible: configVisible ? configVisible.indexOf(r.id) >= 0 : true
        };
      });
      // Append synthetic CMB tracer — rendered as a sphere by renderer.js, not as particles
      mapped.push({
        id: 'cmb',
        name: 'CMB',
        color: 0x888888ff,
        visible: configVisible ? configVisible.indexOf('cmb') >= 0 : true
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
            id: t.id, name: t.name, color: t.color,
            visible: configVisible ? configVisible.indexOf(t.id) >= 0 : true
          };
        });
      });
    }
    appConfig.on('tracersChanged', onExternalTracerChange);
    return function() { appConfig.off('tracersChanged', onExternalTracerChange); };
  }, []);

  function toggleTracer(tracerId, visible) {
    var newTracers = tracers.map(function(t) {
      return t.id === tracerId ? {id: t.id, name: t.name, color: t.color, visible: visible} : t;
    });
    setTracers(newTracers);

    appEvents.setTracerVisibility.fire(tracerId, visible);

    var visibleIds = newTracers.filter(function(t) { return t.visible; }).map(function(t) { return t.id; });
    appConfig.setVisibleTracers(visibleIds.length < newTracers.length ? visibleIds : null);
  }

  if (tracers.length === 0) return null;

  var rows = tracers.map(function(tracer) {
    var swatchStyle = {
      display: 'inline-block',
      width: '14px',
      height: '14px',
      backgroundColor: colorToCSS(tracer.color),
      border: '1px solid rgba(255,255,255,0.3)',
      marginRight: '6px',
      verticalAlign: 'middle',
      flexShrink: 0
    };

    return (
      <label key={tracer.id} style={rowStyle}>
        <input
          type='checkbox'
          checked={tracer.visible}
          onChange={function(e) { toggleTracer(tracer.id, e.target.checked); }}
          style={{marginRight: '6px', verticalAlign: 'middle'}}
        />
        <span style={swatchStyle}></span>
        <span style={{verticalAlign: 'middle'}}>{tracer.name}</span>
      </label>
    );
  });

  return (
    <div style={panelStyle}>
      {rows}
    </div>
  );
}

function colorToCSS(color32) {
  // color32 is 0xRRGGBBAA
  var r = (color32 >>> 24) & 0xff;
  var g = (color32 >>> 16) & 0xff;
  var b = (color32 >>> 8) & 0xff;
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

var panelStyle = {
  position: 'absolute',
  top: '10px',
  left: '10px',
  backgroundColor: 'rgba(0, 0, 0, 0.6)',
  color: '#fff',
  padding: '8px 12px',
  borderRadius: '4px',
  fontSize: '13px',
  userSelect: 'none',
  zIndex: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: '4px'
};

var rowStyle = {
  display: 'flex',
  alignItems: 'center',
  cursor: 'pointer',
  margin: 0
};
