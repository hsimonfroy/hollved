/**
 * Bridge between the particle renderer and the React world.
 *
 * Listens to graph loading events. Once positions are downloaded it calls
 * the native renderer to display them. Tracer colors and visibility are
 * managed here.
 *
 * Control modes (F key or on-screen button to toggle)
 * ----------------------------------------------------
 * Both modes share keyboard controls (W/A/S/D, Q/E, Space/Ctrl, arrows).
 * The mode only changes mouse behaviour:
 *   Turntable — left-drag orbit, scroll zoom, right-drag pan
 *   Spaceship — hold left button to look (pitch/yaw, absolute screen-centre)
 */
import unrender from '../../unrender';
window.THREE = unrender.THREE;

import eventify from 'ngraph.events';
import appEvents from '../service/appEvents.js';
import appConfig from './appConfig.js';
import createBaseControl     from './baseControl.js';
import createSpaceshipControl from './spaceshipControl.js';
import createTurntableControl from './turntableControl.js';
import createMobileControl   from './mobileControl.js';

export default sceneRenderer;

var NODE_SIZE = 2; // change this to resize all nodes

function sceneRenderer(container) {
  var renderer, positions, mobileControl, turntableControl, spaceshipControl, baseControl;
  var currentMode = appConfig.getControlMode();
  var queryUpdateId = setInterval(updateQuery, 200);

  // Tracer state
  var tracerRanges = null;   // [{ id, name, color, startNode, nodeCount }]
  var baseColors = null;     // Uint8Array: per-node resting colors
  var tracerVisibility = {}; // { tracerId: boolean }

  appEvents.positionsDownloaded.on(setPositions);
  appEvents.tracerRangesReady.on(setTracerRanges);
  appEvents.setTracerVisibility.on(handleSetTracerVisibility);
  appEvents.toggleControlMode.on(toggleControlMode);
  appEvents.accelerateNavigation.on(accelarate);
  appEvents.focusScene.on(focusScene);

  appConfig.on('camera', moveCamera);

  var api = {
    destroy: destroy
  };

  eventify(api);

  return api;

  function accelarate(isPrecise) {
    if (!spaceshipControl) return;
    var factor = isPrecise ? 4 : 0.25;
    spaceshipControl.movementSpeed *= factor;
    spaceshipControl.rollSpeed     *= factor;
  }

  function updateQuery() {
    if (!renderer) return;
    var camera = renderer.camera();
    appConfig.setCameraConfig(camera.position, camera.quaternion);
  }

  function toggleControlMode() {
    if (!renderer) return;

    if (currentMode === 'turntable') {
      currentMode = 'spaceship';
      turntableControl.setEnabled(false);
      spaceshipControl.setEnabled(true);
    } else {
      currentMode = 'turntable';
      spaceshipControl.setEnabled(false);
      turntableControl.setEnabled(true, renderer.camera(), true);
    }

    if (mobileControl) mobileControl.setMode(currentMode);
    appEvents.controlModeChanged.fire(currentMode);
    appConfig.setControlMode(currentMode);
  }

  function focusScene() {
    setTimeout(function() {
      container.focus();
    }, 30);
  }

  function setPositions(_positions) {
    positions = _positions;

    // Reset tracer state when new positions arrive
    tracerRanges = null;
    baseColors = null;
    tracerVisibility = {};

    focusScene();

    if (!renderer) {
      renderer = unrender(container);
      var camera = renderer.camera();
      camera.fov = 70; // default is 45, human central vision is about 60
      camera.updateProjectionMatrix();
      moveCameraInternal();

      var cam = renderer.camera();
      baseControl      = createBaseControl(renderer.markDirty);
      turntableControl = createTurntableControl(cam, container, renderer.markDirty, baseControl.keyState);
      spaceshipControl = createSpaceshipControl(cam, container, baseControl.keyState, renderer.markDirty,
        function(v) { appEvents.accelerateNavigation.fire(v); });

      // Wire both controls into the per-frame update slot exposed by unrender.
      // baseControl.isActive() keeps the loop alive while keys are held
      // (camera may not have moved yet on the very first key-down frame).
      renderer.input().update = function(delta) {
        spaceshipControl.update(delta);
        turntableControl.update(delta);
        if (baseControl.isActive()) renderer.markDirty();
      };

      if (currentMode === 'turntable') {
        spaceshipControl.setEnabled(false);
        turntableControl.setEnabled(true, cam, true);
      } else {
        turntableControl.setEnabled(false);
        spaceshipControl.setEnabled(true);
      }

      mobileControl = createMobileControl(renderer, turntableControl, spaceshipControl);
      mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode); // sync UI button on load
    }

    renderer.particles(positions);

    // Apply uniform node size
    var view = renderer.getParticleView();
    var sizes = view.sizes();
    sizes.fill(NODE_SIZE);
    view.sizes(sizes);
    renderer.markDirty();
  }

  function setTracerRanges(ranges) {
    if (!renderer) return;
    tracerRanges = ranges;

    // Initialize visibility from URL config (null = all visible)
    var configVisible = appConfig.getVisibleTracers();
    ranges.forEach(function(tracer) {
      tracerVisibility[tracer.id] = configVisible
        ? configVisible.indexOf(tracer.id) >= 0
        : true;
    });

    var view = renderer.getParticleView();
    var colors = view.colors();

    applyTracerColors(colors);

    // Snapshot as base colors
    baseColors = new Uint8Array(colors.length);
    baseColors.set(colors);

    view.colors(colors);
    applyTracerSizes();
    renderer.markDirty();
  }

  function applyTracerColors(colors) {
    if (!tracerRanges) return;
    tracerRanges.forEach(function(tracer) {
      var visible = tracerVisibility[tracer.id] !== false;
      var color = visible ? tracer.color : (tracer.color & 0xFFFFFF00);
      for (var n = 0; n < tracer.nodeCount; ++n) {
        colorNode((tracer.startNode + n) * 3, colors, color);
      }
    });
  }

  function applyTracerSizes() {
    if (!tracerRanges || !renderer) return;
    var view = renderer.getParticleView();
    var sizes = view.sizes();
    tracerRanges.forEach(function(tracer) {
      var sz = tracerVisibility[tracer.id] !== false ? NODE_SIZE : 0;
      for (var n = 0; n < tracer.nodeCount; ++n) {
        sizes[tracer.startNode + n] = sz;
      }
    });
    view.sizes(sizes);
  }

  function handleSetTracerVisibility(tracerId, visible) {
    if (!tracerRanges || !renderer) return;

    var tracer = null;
    for (var i = 0; i < tracerRanges.length; ++i) {
      if (tracerRanges[i].id === tracerId) {
        tracer = tracerRanges[i];
        break;
      }
    }
    if (!tracer) return;

    tracerVisibility[tracerId] = visible;
    var color = visible ? tracer.color : (tracer.color & 0xFFFFFF00);

    var view = renderer.getParticleView();
    var colors = view.colors();

    for (var n = 0; n < tracer.nodeCount; ++n) {
      var nativeIdx = (tracer.startNode + n) * 3;
      colorNode(nativeIdx, colors, color);
      if (baseColors) {
        colorNode(nativeIdx, baseColors, color);
      }
    }
    view.colors(colors);

    // Fix black dots: set size=0 for hidden nodes, NODE_SIZE for visible
    var sizes = view.sizes();
    var sz = visible ? NODE_SIZE : 0;
    for (var m = 0; m < tracer.nodeCount; ++m) {
      sizes[tracer.startNode + m] = sz;
    }
    view.sizes(sizes);
    renderer.markDirty();
  }

  function colorNode(nodeId, colors, color) {
    var colorOffset = (nodeId / 3) * 4;
    colors[colorOffset + 0] = (color >> 24) & 0xff;
    colors[colorOffset + 1] = (color >> 16) & 0xff;
    colors[colorOffset + 2] = (color >> 8) & 0xff;
    colors[colorOffset + 3] = (color & 0xff);
  }

  function moveCamera() {
    moveCameraInternal();
  }

  function moveCameraInternal() {
    if (!renderer) return;
    var camera = renderer.camera();
    var pos = appConfig.getCameraPosition();
    if (pos) {
      camera.position.set(pos.x, pos.y, pos.z);
    }
    var lookAt = appConfig.getCameraLookAt();
    if (lookAt) {
      camera.quaternion.set(lookAt.x, lookAt.y, lookAt.z, lookAt.w);
    }
    renderer.markDirty();
  }

  function destroy() {
    if (baseControl)      { baseControl.destroy();      baseControl      = null; }
    if (spaceshipControl) { spaceshipControl.destroy(); spaceshipControl = null; }
    if (turntableControl) { turntableControl.destroy(); turntableControl = null; }
    if (mobileControl)    { mobileControl.destroy();    mobileControl    = null; }
    renderer.destroy();
    appEvents.positionsDownloaded.off(setPositions);
    appEvents.tracerRangesReady.off(setTracerRanges);
    appEvents.setTracerVisibility.off(handleSetTracerVisibility);
    appEvents.toggleControlMode.off(toggleControlMode);
    appEvents.accelerateNavigation.off(accelarate);
    appEvents.focusScene.off(focusScene);
    renderer = null;

    clearInterval(queryUpdateId);
    appConfig.off('camera', moveCamera);
  }
}
