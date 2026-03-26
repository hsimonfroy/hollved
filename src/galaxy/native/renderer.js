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
import config from '../../config.js';
import sceneStore from '../store/scene.js';
import createBaseControl     from './baseControl.js';
import createSpaceshipControl from './spaceshipControl.js';
import createTurntableControl from './turntableControl.js';
import createMobileControl   from './mobileControl.js';

export default sceneRenderer;


function sceneRenderer(container) {
  var renderer, positions, mobileControl, turntableControl, spaceshipControl, baseControl;
  var milkyWayCircle = null;
  var cmbSphere = null;
  var cmbVisible = true;
  var _zUp = null;  // THREE.Vector3(0,0,1), allocated once for setFromUnitVectors
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
  appConfig.on('tracersChanged', handleTracersChangedFromURL);

  var api = {
    destroy: destroy
  };

  eventify(api);

  return api;

  function accelarate(isPrecise) {
    if (!spaceshipControl) return;
    var factor = isPrecise ? 5 : 0.2;
    spaceshipControl.movementSpeed *= factor;
    spaceshipControl.rollSpeed     *= factor;
  }

  function updateQuery() {
    if (!renderer) return;
    var camera = renderer.camera();
    var pos  = (currentMode === 'turntable' && turntableControl) ? turntableControl.getPivot() : camera.position;
    var zoom = turntableControl ? turntableControl.getRadius() : appConfig.getZoom();
    appConfig.setCameraConfig(pos, camera.quaternion, zoom);
  }

  function toggleControlMode() {
    if (!renderer) return;

    if (currentMode === 'turntable') {
      // Back to spaceship: teleport to pivot, orient flat in the turntable plane
      var cam = renderer.camera();
      var flatFwd = turntableControl.getFlatForward();
      cam.position.copy(turntableControl.getPivot());
      cam.up.copy(turntableControl.getUpAxis());
      cam.lookAt(new THREE.Vector3(
        cam.position.x + flatFwd.x,
        cam.position.y + flatFwd.y,
        cam.position.z + flatFwd.z
      ));
      currentMode = 'spaceship';
      turntableControl.setEnabled(false);
      spaceshipControl.setEnabled(true);
      if (milkyWayCircle) milkyWayCircle.visible = false;
    } else {
      currentMode = 'turntable';
      spaceshipControl.setEnabled(false);
      turntableControl.setEnabled(true, renderer.camera(), appConfig.getZoom());
      if (milkyWayCircle) {
        milkyWayCircle.visible = true;
        milkyWayCircle.position.copy(turntableControl.getPivot());
        milkyWayCircle.quaternion.setFromUnitVectors(_zUp, turntableControl.getUpAxis());
      }
    }

    renderer.markDirty();
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
        if (milkyWayCircle && milkyWayCircle.visible) {
          milkyWayCircle.position.copy(turntableControl.getPivot());
          milkyWayCircle.quaternion.setFromUnitVectors(_zUp, turntableControl.getUpAxis());
        }
      };

      if (currentMode === 'turntable') {
        spaceshipControl.setEnabled(false);
        turntableControl.setEnabled(true);  // just set enabled flag, no initFromCamera
        moveCameraInternal();               // restoreFromURL with URL state
      } else {
        turntableControl.setEnabled(false);
        spaceshipControl.setEnabled(true);
      }

      _zUp = new THREE.Vector3(0, 0, 1);
      milkyWayCircle = createMilkyWayCircle(renderer.scene());
      milkyWayCircle.visible = (currentMode === 'turntable');
      if (milkyWayCircle.visible) {
        milkyWayCircle.position.copy(turntableControl.getPivot());
        milkyWayCircle.quaternion.setFromUnitVectors(_zUp, turntableControl.getUpAxis());
      }

      var configVisible = appConfig.getVisibleTracers();
      cmbVisible = configVisible ? configVisible.indexOf('cmb') >= 0 : true;
      cmbSphere = createCMBSphere(renderer.scene());
      cmbSphere.visible = cmbVisible;

      mobileControl = createMobileControl(renderer, turntableControl, spaceshipControl);
      mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode); // sync UI button on load
    }

    renderer.particles(positions);
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
    renderer.markDirty();
  }

  function applyTracerColors(colors) {
    if (!tracerRanges) return;
    tracerRanges.forEach(function(tracer) {
      var visible = tracerVisibility[tracer.id] !== false;
      var color = visible ? tracer.color : (tracer.color & 0xFFFFFF00);
      for (var n = 0; n < tracer.nodeCount; ++n) {
        colorNode(tracer.startNode + n, colors, color);
      }
    });
  }

  function handleSetTracerVisibility(tracerId, visible) {
    if (tracerId === 'cmb') {
      cmbVisible = visible;
      if (cmbSphere) { cmbSphere.visible = visible; renderer.markDirty(); }
      return;
    }
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
      colorNode(tracer.startNode + n, colors, color);
      if (baseColors) {
        colorNode(tracer.startNode + n, baseColors, color);
      }
    }
    view.colors(colors);
    renderer.markDirty();
  }

  function handleTracersChangedFromURL() {
    if (!tracerRanges || !renderer) return;
    var configVisible = appConfig.getVisibleTracers();
    tracerRanges.forEach(function(tracer) {
      tracerVisibility[tracer.id] = configVisible ? configVisible.indexOf(tracer.id) >= 0 : true;
    });
    var view = renderer.getParticleView();
    var colors = view.colors();
    applyTracerColors(colors);
    baseColors = new Uint8Array(colors.length);
    baseColors.set(colors);
    view.colors(colors);

    if (cmbSphere) {
      cmbVisible = configVisible ? configVisible.indexOf('cmb') >= 0 : true;
      cmbSphere.visible = cmbVisible;
    }

    renderer.markDirty();
  }

  function colorNode(nodeIndex, colors, color) {
    var colorOffset = nodeIndex * 4;
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
    var camera  = renderer.camera();
    var pos     = appConfig.getCameraPosition();
    var lookAt  = appConfig.getCameraLookAt();  // {x,y,z,w} quaternion
    var zoom    = appConfig.getZoom();
    var newMode = appConfig.getControlMode();

    if (newMode !== currentMode && turntableControl && spaceshipControl) {
      // Mode changed via URL — perform full mode switch
      currentMode = newMode;
      if (newMode === 'turntable') {
        spaceshipControl.setEnabled(false);
        turntableControl.restoreFromURL(pos, zoom, lookAt);
        turntableControl.setEnabled(true);
        if (milkyWayCircle) {
          milkyWayCircle.visible = true;
          milkyWayCircle.position.copy(turntableControl.getPivot());
          milkyWayCircle.quaternion.setFromUnitVectors(_zUp, turntableControl.getUpAxis());
        }
      } else {
        turntableControl.setEnabled(false);
        camera.position.set(pos.x, pos.y, pos.z);
        camera.quaternion.set(lookAt.x, lookAt.y, lookAt.z, lookAt.w);
        spaceshipControl.setEnabled(true);
        if (milkyWayCircle) milkyWayCircle.visible = false;
      }
      if (mobileControl) mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode);
      appConfig.setControlMode(currentMode);
    } else if (newMode === 'turntable' && turntableControl) {
      turntableControl.restoreFromURL(pos, zoom, lookAt);
      if (milkyWayCircle && milkyWayCircle.visible) {
        milkyWayCircle.position.copy(turntableControl.getPivot());
        milkyWayCircle.quaternion.setFromUnitVectors(_zUp, turntableControl.getUpAxis());
      }
    } else {
      if (pos) camera.position.set(pos.x, pos.y, pos.z);
      if (lookAt) camera.quaternion.set(lookAt.x, lookAt.y, lookAt.z, lookAt.w);
    }
    renderer.markDirty();
  }

  function createCMBSphere(scene) {
    var geo = new THREE.SphereGeometry(9390, 128, 64);
    var texture = new THREE.TextureLoader().load(
      config.dataUrl + sceneStore.getGraphName() + '/cmb/planck_100ghz.jpg'
    );
    var mat = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,                  // visible from inside and outside
      color: new THREE.Color(0.1, 0.1, 0.1)   // darken texture; tune to taste
    });
    var sphere = new THREE.Mesh(geo, mat);
    sphere.renderOrder = -1;           // draw before particles, writes depth first
    sphere.rotation.x = Math.PI / 2;  // SphereGeometry Y-up → Z-up (celestial north = +Z)
    sphere.rotation.y = Math.PI;      // align RA=0° with +X axis (Rx(π/2)·Ry(π) = DESI frame)
    scene.add(sphere);
    return sphere;
  }

  function createMilkyWayCircle(scene) {
    var SEGMENTS = 64, R = 0.1;
    var positions = new Float32Array((SEGMENTS + 1) * 3);
    for (var i = 0; i <= SEGMENTS; i++) {
      var a = (i / SEGMENTS) * Math.PI * 2;
      positions[i * 3 + 0] = Math.cos(a) * R;
      positions[i * 3 + 1] = Math.sin(a) * R;
      positions[i * 3 + 2] = 0;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false
    });
    var circle = new THREE.Line(geo, mat);
    scene.add(circle);
    return circle;
  }

  function destroy() {
    if (cmbSphere) {
      renderer.scene().remove(cmbSphere);
      cmbSphere.geometry.dispose();
      if (cmbSphere.material.map) cmbSphere.material.map.dispose();
      cmbSphere.material.dispose();
      cmbSphere = null;
    }
    if (milkyWayCircle) {
      renderer.scene().remove(milkyWayCircle);
      milkyWayCircle.geometry.dispose();
      milkyWayCircle.material.dispose();
      milkyWayCircle = null;
    }
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
    appConfig.off('tracersChanged', handleTracersChangedFromURL);
  }
}
