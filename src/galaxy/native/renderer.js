/**
 * This is a bridge between ultrafast particle renderer and react world.
 *
 * It listens to graph loading events. Once graph positions are loaded it calls
 * native renderer to show the positions.
 *
 * It also listens to native renderer for user interaction. When user hovers
 * over a node or clicks on it - it reports user actions back to the global
 * events bus. These events are later consumed by stores to show appropriate
 * UI feedback
 */
// TODO: This class needs to be refactored. It is doing too much, and parts
// of its code should be done from unrender itself
// TODO: Use DynamicBufferAttribute which can accelarate render
// E.g.: threejs.org/examples/webgl_buffergeometry_drawcalls.html
import unrender from 'unrender';
window.THREE = unrender.THREE;

import eventify from 'ngraph.events';
import appEvents from '../service/appEvents.js';
import scene from '../store/scene.js';
import getNearestIndex from './getNearestIndex.js';
import createTouchControl from './touchControl.js';
import createLineView from './lineView.js';
import appConfig from './appConfig.js';

export default sceneRenderer;

var defaultNodeColor = 0xffffffff;
var highlightNodeColor = 0xff0000ff;

function sceneRenderer(container) {
  var renderer, positions, graphModel, touchControl;
  var hitTest, lastHighlight, lastHighlightSize, cameraPosition;
  var lineView, links, lineViewNeedsUpdate;
  var queryUpdateId = setInterval(updateQuery, 200);

  // Tracer state
  var tracerRanges = null;      // [{ id, name, color, startNode, nodeCount }]
  var baseColors = null;        // Uint8Array: per-node "resting" colors (source of truth)
  var tracerVisibility = {};    // { tracerId: boolean }

  appEvents.positionsDownloaded.on(setPositions);
  appEvents.linksDownloaded.on(setLinks);
  appEvents.tracerRangesReady.on(setTracerRanges);
  appEvents.setTracerVisibility.on(handleSetTracerVisibility);
  appEvents.toggleSteering.on(toggleSteering);
  appEvents.focusOnNode.on(focusOnNode);
  appEvents.around.on(around);
  appEvents.highlightQuery.on(highlightQuery);
  appEvents.highlightLinks.on(highlightLinks);
  appEvents.accelerateNavigation.on(accelarate);
  appEvents.focusScene.on(focusScene);
  appEvents.cls.on(cls);

  appConfig.on('camera', moveCamera);
  appConfig.on('showLinks', toggleLinks);

  var api = {
    destroy: destroy
  };

  eventify(api);

  return api;

  function accelarate(isPrecise) {
    var input = renderer.input();
    if (isPrecise) {
      input.movementSpeed *= 4;
      input.rollSpeed *= 4;
    } else {
      input.movementSpeed /= 4;
      input.rollSpeed /= 4;
    }
  }

  function updateQuery() {
    if (!renderer) return;
    var camera = renderer.camera();
    appConfig.setCameraConfig(camera.position, camera.quaternion);
  }

  function toggleSteering() {
    if (!renderer) return;
    var input = renderer.input();
    var isDragToLookEnabled = input.toggleDragToLook();
    var isSteering = !isDragToLookEnabled;
    appEvents.showSteeringMode.fire(isSteering);
  }

  function clearHover() {
    appEvents.nodeHover.fire({
      nodeIndex: undefined,
      mouseInfo: undefined
    });
  }

  function focusOnNode(nodeId) {
    if (!renderer) return;
    renderer.lookAt(nodeId * 3, highlightFocused);
    function highlightFocused() {
      appEvents.selectNode.fire(nodeId);
    }
  }

  function around(r, x, y, z) {
    renderer.around(r, x, y, z);
  }

  function setPositions(_positions) {
    destroyHitTest();

    positions = _positions;
    // Reset tracer state when new positions arrive
    tracerRanges = null;
    baseColors = null;
    tracerVisibility = {};

    focusScene();

    if (!renderer) {
      renderer = unrender(container);
      var camera = renderer.camera();
      camera.fov = 60;
      camera.updateProjectionMatrix();
      touchControl = createTouchControl(renderer);
      moveCameraInternal();
      var input = renderer.input();
      input.on('move', clearHover);
    }

    renderer.particles(positions);

    hitTest = renderer.hitTest();
    hitTest.on('over', handleOver);
    hitTest.on('click', handleClick);
    hitTest.on('dblclick', handleDblClick);
    hitTest.on('hitTestReady', adjustMovementSpeed);
  }

  function setTracerRanges(ranges) {
    if (!renderer) return;
    tracerRanges = ranges;

    // Initialize all tracers as visible, applying initial visibility from appConfig
    var configVisible = appConfig.getVisibleTracers(); // null = all visible
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

    // Update baseColors and live colors for nodes in this tracer's range
    var view = renderer.getParticleView();
    var colors = view.colors();

    for (var n = 0; n < tracer.nodeCount; ++n) {
      var nativeIdx = (tracer.startNode + n) * 3;
      colorNode(nativeIdx, colors, color);
      if (baseColors) {
        colorNode(nativeIdx, baseColors, color);
      }
    }

    // Reapply highlight if the highlighted node is in this tracer (only when visible)
    if (visible && lastHighlight !== undefined) {
      var highlightedNode = lastHighlight / 3;
      if (highlightedNode >= tracer.startNode &&
          highlightedNode < tracer.startNode + tracer.nodeCount) {
        colorNode(lastHighlight, colors, highlightNodeColor);
      }
    }

    view.colors(colors);
  }

  function adjustMovementSpeed(tree) {
    var input = renderer.input();
    if (tree) {
      var root = tree.getRoot();
      input.movementSpeed = root.bounds.half * 0.02;
    } else {
      input.movementSpeed *= 2;
    }
  }

  function focusScene() {
    setTimeout(function() {
      container.focus();
    }, 30);
  }

  function setLinks(outLinks, inLinks) {
    links = outLinks;
    lineViewNeedsUpdate = true;
    updateSizes(outLinks, inLinks);
    renderLineViewIfNeeded();
  }

  function updateSizes(outLinks, inLinks) {
    var maxInDegree = getMaxSize(inLinks);
    var view = renderer.getParticleView();
    var sizes = view.sizes();
    for (var i = 0; i < sizes.length; ++i) {
      var degree = inLinks[i];
      if (degree) {
        sizes[i] = ((200 / maxInDegree) * degree.length + 15);
      } else {
        sizes[i] = 10;
      }
    }
    view.sizes(sizes);
  }

  function getMaxSize(sparseArray) {
    var maxSize = 0;
    for (var i = 0; i < sparseArray.length; ++i) {
      var item = sparseArray[i];
      if (item && item.length > maxSize) maxSize = item.length;
    }
    return maxSize;
  }

  function renderLineViewIfNeeded() {
    if (!appConfig.getShowLinks()) return;
    if (!lineView) {
      lineView = createLineView(renderer.scene(), unrender.THREE);
    }
    lineView.render(links, positions);
    lineViewNeedsUpdate = false;
  }

  function toggleLinks() {
    if (lineView) {
      if (lineViewNeedsUpdate) renderLineViewIfNeeded();
      lineView.toggleLinks();
    } else {
      renderLineViewIfNeeded();
    }
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
  }

  function destroyHitTest() {
    if (!hitTest) return;
    hitTest.off('over', handleOver);
    hitTest.off('click', handleClick);
    hitTest.off('dblclick', handleDblClick);
    hitTest.off('hitTestReady', adjustMovementSpeed);
  }

  function handleClick(e) {
    var nearestIndex = getNearestIndex(positions, e.indexes, e.ray, 30);
    appEvents.selectNode.fire(getModelIndex(nearestIndex));
  }

  function handleDblClick(e) {
    var nearestIndex = getNearestIndex(positions, e.indexes, e.ray, 30);
    if (nearestIndex !== undefined) {
      focusOnNode(nearestIndex/3);
    }
  }

  function handleOver(e) {
    var nearestIndex = getNearestIndex(positions, e.indexes, e.ray, 30);
    highlightNode(nearestIndex);
    appEvents.nodeHover.fire({
      nodeIndex: getModelIndex(nearestIndex),
      mouseInfo: e
    });
  }

  function highlightNode(nodeIndex) {
    var view = renderer.getParticleView();
    var colors = view.colors();
    var sizes = view.sizes();

    if (lastHighlight !== undefined) {
      // Restore from baseColors if available, else use default
      var restoreColor = getBaseColor(lastHighlight);
      colorNode(lastHighlight, colors, restoreColor);
      sizes[lastHighlight/3] = lastHighlightSize;
    }

    lastHighlight = nodeIndex;

    if (lastHighlight !== undefined) {
      colorNode(lastHighlight, colors, highlightNodeColor);
      lastHighlightSize = sizes[lastHighlight/3];
      sizes[lastHighlight/3] *= 1.5;
    }

    view.colors(colors);
    view.sizes(sizes);
  }

  function getBaseColor(nativeIdx) {
    if (baseColors) {
      var offset = (nativeIdx / 3) * 4;
      return ((baseColors[offset] << 24) |
              (baseColors[offset + 1] << 16) |
              (baseColors[offset + 2] << 8) |
               baseColors[offset + 3]) >>> 0;
    }
    return defaultNodeColor;
  }

  function highlightQuery(query, color, scale) {
    if (!renderer) return;
    var nodeIds = query.results.map(toNativeIndex);
    var view = renderer.getParticleView();
    var colors = view.colors();
    for (var i = 0; i < nodeIds.length; ++i) {
      colorNode(nodeIds[i], colors, color);
    }
    view.colors(colors);
    appEvents.queryHighlighted.fire(query, color);
  }

  function colorNode(nodeId, colors, color) {
    var colorOffset = (nodeId/3) * 4;
    colors[colorOffset + 0] = (color >> 24) & 0xff;
    colors[colorOffset + 1] = (color >> 16) & 0xff;
    colors[colorOffset + 2] = (color >> 8) & 0xff;
    colors[colorOffset + 3] = (color & 0xff);
  }

  function highlightLinks(links, color) {
    var lines = new Float32Array(links.length * 3);
    for (var i = 0; i < links.length; ++i) {
      var i3 = links[i] * 3;
      lines[i * 3] = positions[i3];
      lines[i * 3 + 1] = positions[i3 + 1];
      lines[i * 3 + 2] = positions[i3 + 2];
    }
    renderer.lines(lines, color);
  }

  function cls() {
    var view = renderer.getParticleView();
    var colors = view.colors();

    if (baseColors) {
      // Restore tracer colors
      colors.set(baseColors);
    } else {
      // No tracer info: reset to default white
      for (var i = 0; i < colors.length/4; i++) {
        colorNode(i * 3, colors, defaultNodeColor);
      }
    }

    view.colors(colors);
  }

  function toNativeIndex(i) {
    return i.id * 3;
  }

  function getModelIndex(nearestIndex) {
    if (nearestIndex !== undefined) {
      return nearestIndex/3;
    }
  }

  function destroy() {
    var input = renderer.input();
    if (input) input.off('move', clearHover);
    renderer.destroy();
    appEvents.positionsDownloaded.off(setPositions);
    appEvents.linksDownloaded.off(setLinks);
    appEvents.tracerRangesReady.off(setTracerRanges);
    appEvents.setTracerVisibility.off(handleSetTracerVisibility);

    if (touchControl) touchControl.destroy();
    renderer = null;

    clearInterval(queryUpdateId);
    appConfig.off('camera', moveCamera);
    appConfig.off('showLinks', toggleLinks);
  }
}
