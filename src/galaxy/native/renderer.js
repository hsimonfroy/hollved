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
 *   Satellite — left-drag orbit, scroll zoom, right-drag pan
 *   Spaceship — hold left button to look (pitch/yaw, absolute screen-centre)
 */
import unrender from '../../unrender';
window.THREE = unrender.THREE;

import eventify from 'ngraph.events';
import appEvents from '../service/appEvents.js';
import appConfig from './appConfig.js';
import config from '../../config.js';
import createBaseControl     from './baseControl.js';
import createSpaceshipControl from './spaceshipControl.js';
import createSatelliteControl from './satelliteControl.js';
import createMobileControl   from './mobileControl.js';
import createDetailedGalaxies from './detailedGxyRenderer.js';
import createSolarRenderer    from './solarRenderer.js';
import { cartToRaDecR, dirToAzAlt, getLocalFrame } from './coordUtils.js';
import { createGlowMaterial, makeRadarLabel } from './radarStyle.js';

var DEG2RAD = Math.PI / 180;

export default sceneRenderer;

function sceneRenderer(container) {
  var renderer, positions, mobileControl, satelliteControl, spaceshipControl, baseControl;
  var cameraAnim = null; // active camera animation, or null
  var cmbSphere = null;
  var cmbVisible = true;
  var detailedGalaxies = null;
  var solarRenderer    = null;
  var radarEnabled = false;
  var rulerObjects  = [];   // [{ ring, label, radius }, ...]
  var labelScene        = null; // separate scene rendered post-tone-map for crisp SDF text
  var DEFAULT_HIDDEN_TRACERS = ['cmb', 'radar'];
  var _zUp = null;  // THREE.Vector3(0,0,1), allocated once for setFromUnitVectors
  var _sliceFwd = null; // pre-allocated for per-frame slice normal computation
  var _rulerDir = null, _rulerQuat = null; // per-frame ruler scratch
  var RING_ALPHA         = 0.01; // peak ring alpha, once fully faded in
  var RULER_LABEL_ALPHA  = 0.8;
  var RING_FADE_DECADES  = 1;    // fade in over one decade of camera distance
  var sliceEnabled = false;
  var SLICE_ANGLE     = Math.PI / 20; // angle between the two cones
  var IN_SLICE_ALPHA  = 2.0;
  var OUT_SLICE_ALPHA = 0.02;
  var currentMode = appConfig.getControlMode();
  var queryUpdateId = setInterval(updateQuery, 200);
  var rulerDefs = [];
  var cmbRadius = 14000;   // fallback; overwritten by radarReady before setPositions

  // Tracer state
  var tracerRanges = null;   // [{ id, name, color, startNode, nodeCount }]
  var baseColors = null;     // Uint8Array: per-node resting colors
  var tracerVisibility = {}; // { tracerId: boolean }

  appEvents.positionsDownloaded.on(setPositions);
  appEvents.tracerRangesReady.on(setTracerRanges);
  appEvents.setTracerVisibility.on(handleSetTracerVisibility);
  appEvents.toggleControlMode.on(toggleControlMode);

  appEvents.focusScene.on(focusScene);
  appEvents.radarReady.on(onRadarReady);
  appEvents.setMovementSpeed.on(onSetMovementSpeed);
  appEvents.resetToOrigin.on(resetToOrigin);

  appConfig.on('camera', moveCamera);
  appConfig.on('tracersChanged', handleTracersChangedFromURL);

  var api = {
    destroy: destroy
  };

  eventify(api);

  return api;

  function onSetMovementSpeed(v) {
    if (spaceshipControl) spaceshipControl.movementSpeed = v;
  }

  function resetToOrigin() {
    if (!renderer) return;
    if (cameraAnim) return;

    var cam = renderer.camera();
    var startPos  = cam.position.clone();
    var startQuat = cam.quaternion.clone();

    if (currentMode === 'satellite' && satelliteControl) {
      satelliteControl.setPivot(0, 0, 0); // repositions cam internally
      var endPos  = cam.position.clone();
      var endQuat = cam.quaternion.clone();
      satelliteControl.setEnabled(false);
      startCameraAnim(startPos, endPos, startQuat, endQuat, 500, function() {
        satelliteControl.setEnabled(true);
      });
    } else {
      startCameraAnim(startPos, new THREE.Vector3(), startQuat, startQuat, 500, function() {});
    }
  }

  function updateQuery() {
    if (!renderer) return;
    var camera = renderer.camera();
    var cp = camera.position;
    // HUD always shows camera position (not pivot), even in satellite mode
    appEvents.cameraHUDUpdate.fire(cartToRaDecR(cp.x, cp.y, cp.z));

    if (currentMode === 'satellite' && satelliteControl) {
      var pivot  = satelliteControl.getPivot();
      var up     = satelliteControl.getUpAxis();
      var bwd    = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
      var azAlt  = dirToAzAlt({ x: bwd.x, y: bwd.y, z: bwd.z }, { x: up.x, y: up.y, z: up.z });
      appConfig.setSatelliteState(pivot, satelliteControl.getRadius(), up, azAlt.az, azAlt.alt);
    } else if (currentMode === 'spaceship' && spaceshipControl) {
      appConfig.setSpaceshipState(camera.position, camera.quaternion, spaceshipControl.movementSpeed);
    }
  }

  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  function animFrame(time) {
    if (!cameraAnim) return;
    if (cameraAnim.startTime === null) cameraAnim.startTime = time;
    var t  = Math.min((time - cameraAnim.startTime) / cameraAnim.duration, 1.0);
    var te = easeInOutQuad(t);
    var cam = renderer.camera();
    cam.position.lerpVectors(cameraAnim.startPos, cameraAnim.endPos, te);
    cam.quaternion.slerpQuaternions(cameraAnim.startQuat, cameraAnim.endQuat, te);
    renderer.markDirty();
    if (t >= 1.0) {
      renderer.offFrame(animFrame);
      cameraAnim.onDone();
      cameraAnim = null;
    }
  }

  function startCameraAnim(startPos, endPos, startQuat, endQuat, duration, onDone) {
    cameraAnim = {
      startPos: startPos, endPos: endPos,
      startQuat: startQuat, endQuat: endQuat,
      duration: duration || 500,
      startTime: null,
      onDone: onDone
    };
    renderer.onFrame(animFrame);
    renderer.markDirty();
  }

  function toggleControlMode() {
    if (!renderer) return;
    if (cameraAnim) return; // ignore while animation is running

    var cam = renderer.camera();

    if (currentMode === 'satellite') {
      // Satellite → Spaceship: zoom camera in from orbit to pivot
      var startPos  = cam.position.clone();
      var startQuat = cam.quaternion.clone();

      var pivot   = satelliteControl.getPivot().clone();
      var flatFwd = satelliteControl.getFlatForward();
      var upAxis  = satelliteControl.getUpAxis().clone();

      // Compute the target orientation at the pivot (same logic as the old instant teleport).
      // Must use a Camera (not Object3D): THREE.Camera.lookAt points -Z toward the target,
      // while THREE.Object3D.lookAt points +Z toward it — opposite conventions.
      var scratchCam = new THREE.PerspectiveCamera();
      scratchCam.position.copy(pivot);
      scratchCam.up.copy(upAxis);
      scratchCam.lookAt(new THREE.Vector3(
        pivot.x + flatFwd.x,
        pivot.y + flatFwd.y,
        pivot.z + flatFwd.z
      ));
      var endPos  = pivot;
      var endQuat = scratchCam.quaternion.clone();

      satelliteControl.setEnabled(false);
      spaceshipControl.setEnabled(false); // disabled during animation

      // Fly on at the speed the orbit was already moving at. Without this you
      // leave a planet-scale orbit at whatever the last free-fly speed was and
      // cross the galaxy in a second.
      spaceshipControl.movementSpeed = satelliteControl.getMoveSpeed();

      currentMode = 'spaceship';
      if (sliceEnabled) renderer.getParticleView().getPointCloud().material.uniforms.uSliceEnabled.value = 0.0;
      if (mobileControl) mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode);
      appConfig.setControlMode(currentMode);

      startCameraAnim(startPos, endPos, startQuat, endQuat, 500, function() {
        cam.position.copy(endPos);
        cam.up.copy(upAxis);
        cam.quaternion.copy(endQuat);
        spaceshipControl.setEnabled(true);
      });

    } else {
      // Spaceship → Satellite: zoom camera out from spaceship to orbit
      var startPos  = cam.position.clone();
      var startQuat = cam.quaternion.clone();

      // Initialize satellite state from current camera position/orientation.
      // setEnabled(true, cam, zoom) calls initFromCamera which computes pivot/radius/upAxis/theta/phi
      // and immediately moves the camera to the orbit position via updateCamera().
      //
      // The orbit radius is the inverse of the rule above, so the round trip
      // F -> F is the identity. Restoring appConfig.getRadius() instead, as this
      // used to, threw away the zoom you had just flown to: leave a 4000 Mpc
      // orbit, fly down to a planet, press F, and you got a 4000 Mpc orbit again.
      satelliteControl.setEnabled(true, cam,
        satelliteControl.radiusForSpeed(spaceshipControl.movementSpeed));
      var endPos  = cam.position.clone();
      var endQuat = cam.quaternion.clone();

      // Disable inputs during animation; internal state (pivot, radius, etc.) is preserved.
      satelliteControl.setEnabled(false);

      // Restore camera to spaceship start for animation
      cam.position.copy(startPos);
      cam.quaternion.copy(startQuat);

      spaceshipControl.setEnabled(false); // disabled during animation

      currentMode = 'satellite';
      if (mobileControl) mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode);
      appConfig.setControlMode(currentMode);

      startCameraAnim(startPos, endPos, startQuat, endQuat, 500, function() {
        cam.position.copy(endPos);
        cam.quaternion.copy(endQuat);
        satelliteControl.setEnabled(true); // no cam arg → preserves computed state
        if (sliceEnabled) {
          var mat = renderer.getParticleView().getPointCloud().material;
          mat.uniforms.uSliceEnabled.value = 1.0;
          updateSliceUniforms(mat);
          renderer.markDirty();
        }
      });
    }
  }

  function focusScene() {
    setTimeout(function() {
      container.focus();
    }, 30);
  }

  function onRadarReady(data) {
    rulerDefs = (data && Array.isArray(data.ring)) ? data.ring : [];
    cmbRadius = (data && data.sphere && data.sphere[0]) ? data.sphere[0].radius : 14000;
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
      labelScene = renderer.postScene();

      // Intercept setExposure/setPower so CMB sphere stays compensated
      var _setExposure = renderer.setExposure;
      renderer.setExposure = function(v) {
        _setExposure(v);
        if (cmbSphere) cmbSphere.material.uniforms.uExposure.value = v;
      };
      var _setPower = renderer.setPower;
      renderer.setPower = function(v) {
        _setPower(v);
        if (cmbSphere) cmbSphere.material.uniforms.uPower.value = v;
      };
      var camera = renderer.camera();
      camera.updateProjectionMatrix();
      moveCameraInternal();

      var cam = renderer.camera();
      baseControl      = createBaseControl(renderer.markDirty);
      satelliteControl = createSatelliteControl(cam, container, renderer.markDirty, baseControl.keyState);
      spaceshipControl = createSpaceshipControl(cam, container, baseControl.keyState, renderer.markDirty);

      // Wire both controls into the per-frame update slot exposed by unrender.
      // baseControl.isActive() keeps the loop alive while keys are held
      // (camera may not have moved yet on the very first key-down frame).
      renderer.input().update = function(delta) {
        spaceshipControl.update(delta);
        satelliteControl.update(delta);
        if (currentMode === 'spaceship') {
          appEvents.cameraSpeedUpdate.fire(spaceshipControl.currentSpeed, spaceshipControl.movementSpeed);
        }
        if (baseControl.isActive()) renderer.markDirty();
        if (sliceEnabled && currentMode === 'satellite') {
          updateSliceUniforms(renderer.getParticleView().getPointCloud().material);
        }
        if (rulerObjects.length) updateRulers();
      };

      if (currentMode === 'satellite') {
        spaceshipControl.setEnabled(false);
        satelliteControl.setEnabled(true);
        moveCameraInternal();
      } else {
        satelliteControl.setEnabled(false);
        spaceshipControl.setEnabled(true);
        spaceshipControl.movementSpeed = appConfig.getSpeed();
      }

      _zUp = new THREE.Vector3(0, 0, 1);
      _sliceFwd = new THREE.Vector3();
      _rulerDir  = new THREE.Vector3();
      _rulerQuat = new THREE.Quaternion();

      var configVisible = appConfig.getVisibleTracers();
      cmbVisible = configVisible ? configVisible.indexOf('cmb') >= 0 : false;
      cmbSphere = createCMBSphere(renderer.scene(), cmbRadius, renderer.getExposure(), renderer.getPower());
      cmbSphere.visible = cmbVisible;

      detailedGalaxies = createDetailedGalaxies(renderer, renderer.markDirty);
      solarRenderer    = createSolarRenderer(renderer, renderer.markDirty);
      if (configVisible && configVisible.indexOf('local') < 0) {
        detailedGalaxies.setVisible(false);
      }

      radarEnabled = configVisible ? configVisible.indexOf('radar') >= 0 : false;
      rulerObjects = createRadar(renderer.scene(), labelScene);
      updateRadarVisibility();

      mobileControl = createMobileControl(renderer, satelliteControl, spaceshipControl);
      mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode); // sync UI button on load
    }

    renderer.particles(positions);

    // Sync slice constants and URL state to material (pointCloud exists after particles() call)
    if (_sliceFwd) {
      var mat = renderer.getParticleView().getPointCloud().material;
      var _halfAngle = (Math.PI - SLICE_ANGLE) / 2;
      var _cosHalf   = Math.cos(_halfAngle);
      mat.uniforms.uSliceCosHalf2.value = _cosHalf * _cosHalf;
      mat.uniforms.uInSliceAlpha.value  = IN_SLICE_ALPHA;
      mat.uniforms.uOutSliceAlpha.value = OUT_SLICE_ALPHA;
      var _cv = appConfig.getVisibleTracers();
      sliceEnabled = _cv ? _cv.indexOf('slice') >= 0 : false;
      mat.uniforms.uSliceEnabled.value = (sliceEnabled && currentMode === 'satellite') ? 1.0 : 0.0;
      if (sliceEnabled && currentMode === 'satellite' && satelliteControl) updateSliceUniforms(mat);
    }

    renderer.markDirty();
  }

  function setTracerRanges(ranges) {
    if (!renderer) return;
    tracerRanges = ranges;

    var configVisible = appConfig.getVisibleTracers();
    ranges.forEach(function(tracer) {
      tracerVisibility[tracer.id] = configVisible
        ? configVisible.indexOf(tracer.id) >= 0
        : DEFAULT_HIDDEN_TRACERS.indexOf(tracer.id) < 0;
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
    if (tracerId === 'local') {
      if (detailedGalaxies) detailedGalaxies.setVisible(visible);
      return;
    }
    if (tracerId === 'slice') {
      sliceEnabled = visible;
      var pc = renderer && renderer.getParticleView() && renderer.getParticleView().getPointCloud();
      if (pc) {
        pc.material.uniforms.uSliceEnabled.value = (visible && currentMode === 'satellite') ? 1.0 : 0.0;
        if (visible && currentMode === 'satellite' && satelliteControl) updateSliceUniforms(pc.material);
      }
      renderer.markDirty();
      return;
    }
    if (tracerId === 'radar') {
      radarEnabled = visible;
      updateRadarVisibility();
      return;
    }
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

  function updateSliceUniforms(mat) {
    var cam    = renderer.camera();
    var upAxis = satelliteControl.getUpAxis();
    var pivot  = satelliteControl.getPivot();
    _sliceFwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _sliceFwd.addScaledVector(upAxis, -_sliceFwd.dot(upAxis));
    var len = _sliceFwd.length();
    if (len < 0.001) return;
    _sliceFwd.divideScalar(len);
    mat.uniforms.uSliceNormal.value.copy(_sliceFwd);
    mat.uniforms.uSlicePivot.value.copy(pivot);
  }

  function handleTracersChangedFromURL() {
    if (!tracerRanges || !renderer) return;
    var configVisible = appConfig.getVisibleTracers();
    radarEnabled = configVisible ? configVisible.indexOf('radar') >= 0 : false;
    sliceEnabled  = configVisible ? configVisible.indexOf('slice') >= 0 : false;
    var _pc = renderer.getParticleView().getPointCloud();
    if (_pc) {
      _pc.material.uniforms.uSliceEnabled.value = (sliceEnabled && currentMode === 'satellite') ? 1.0 : 0.0;
      if (sliceEnabled && currentMode === 'satellite' && satelliteControl) updateSliceUniforms(_pc.material);
    }
    tracerRanges.forEach(function(tracer) {
      tracerVisibility[tracer.id] = configVisible ? configVisible.indexOf(tracer.id) >= 0 : DEFAULT_HIDDEN_TRACERS.indexOf(tracer.id) < 0;
    });
    var view = renderer.getParticleView();
    var colors = view.colors();
    applyTracerColors(colors);
    baseColors = new Uint8Array(colors.length);
    baseColors.set(colors);
    view.colors(colors);

    if (cmbSphere) {
      cmbVisible = configVisible ? configVisible.indexOf('cmb') >= 0 : false;
      cmbSphere.visible = cmbVisible;
    }
    if (detailedGalaxies) {
      detailedGalaxies.setVisible(configVisible ? configVisible.indexOf('local') >= 0 : true);
    }

    updateRadarVisibility();

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
    var newMode = appConfig.getControlMode();

    if (newMode !== currentMode && satelliteControl && spaceshipControl) {
      currentMode = newMode;
      if (newMode === 'satellite') {
        spaceshipControl.setEnabled(false);
        restoreSatelliteFromConfig();
        satelliteControl.setEnabled(true);
      } else {
        satelliteControl.setEnabled(false);
        restoreSpaceshipFromConfig(camera);
        spaceshipControl.setEnabled(true);
      }
      if (mobileControl) mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode);
      appConfig.setControlMode(currentMode);
    } else if (newMode === 'satellite' && satelliteControl) {
      restoreSatelliteFromConfig();
    } else {
      restoreSpaceshipFromConfig(camera);
    }
    renderer.markDirty();
  }

  function restoreSatelliteFromConfig() {
    var pos   = appConfig.getCameraPosition();
    var up    = appConfig.getUpAxis();
    var azAlt = appConfig.getAzAlt();
    var r     = appConfig.getRadius();
    satelliteControl.restoreFromAzAlt(pos, r, up, azAlt.az * DEG2RAD, azAlt.alt * DEG2RAD);
  }

  function restoreSpaceshipFromConfig(camera) {
    var pos    = appConfig.getCameraPosition();
    var lookAt = appConfig.getCameraLookAt();
    camera.position.set(pos.x, pos.y, pos.z);
    camera.quaternion.set(lookAt.x, lookAt.y, lookAt.z, lookAt.w);
  }

  // ---------------------------------------------------------------------------
  // Cosmological distance radar
  // ---------------------------------------------------------------------------

  function createRulerRing(radius) {
    var tubeR = radius * 0.005;   // visual glow half-width
    var geo = new THREE.TorusGeometry(radius, tubeR, 16, 256);
    // intensity 2.0: ruler rings render into the HDR buffer, before tone-mapping.
    // RING_ALPHA is the peak; updateRulers scales it down as the ring fades in.
    return new THREE.Mesh(geo, createGlowMaterial(2.0, RING_ALPHA));
  }

  function makeRulerLabel(text, radius) {
    // Labels render post-tone-map (in postScene) so plain white is truly white.
    return makeRadarLabel(text, radius * 0.04, function() {
      // Text geometry is ready — wake the RAF loop so the label appears immediately.
      if (renderer) renderer.markDirty();
    });
  }

  function createRadar(scene, ls) {
    var objs = (rulerDefs || []).map(function(def) {
      var distStr = def.radius < 1000
        ? def.radius.toFixed(0) + ' Mpc'
        : (def.radius / 1000).toFixed(1) + ' Gpc';
      var ring  = createRulerRing(def.radius);
    //   var label = makeRulerLabel(def.name + ' \u00b7 ' + distStr, def.radius);
      var label = makeRulerLabel(def.name, def.radius);
      scene.add(ring); ls.add(label);
      return { ring: ring, label: label, radius: def.radius };
    });
    return objs;
  }

  // A ring is a satellite-mode instrument: it reads as a floor laid under the scene, which only means anything in the orbit frame. Each ring then fades in over the decade of camera distance below its own radius rather than appearing at full strength the instant you cross it.
  function updateRulers() {
    if (!radarEnabled || currentMode !== 'satellite') {
      rulerObjects.forEach(hideRuler);
      return;
    }
    var cam     = renderer.camera();
    var camDist = cam.position.length();
    var upAxis  = satelliteControl.getUpAxis();

    // Nearest point on a ring to the camera: drop the camera onto the ring plane, then scale out to the radius. The rings are concentric and coplanar, so one direction serves all of them.
    var camDir = _rulerDir.copy(cam.position)
      .addScaledVector(upAxis, -cam.position.dot(upAxis));
    var camLen = camDir.length();
    // Relative, not an absolute floor: an absolute one (it was 1e-4 Mpc) stops the labels updating whenever the camera is nearer than that to the up axis, so zooming in past ~100 pc stranded them all on one side. All it has to catch is normalising a vector that is pure cancellation noise, which is relative.
    if (camLen > camDist * 1e-12) {
      camDir.divideScalar(camLen);
    } else {
      // Camera on the axis: no edge is nearest, so any equatorial direction serves.
      var north = getLocalFrame(upAxis).north;
      camDir.set(north.x, north.y, north.z);
    }

    _rulerQuat.setFromUnitVectors(_zUp, upAxis);

    rulerObjects.forEach(function(r) {
      // 0 one decade inside the ring, 1 at the radius itself. Measured in log space. camDist = 0 gives -Infinity, clamped to 0.
      var t = Math.log10(camDist / r.radius) / RING_FADE_DECADES + 1;
      t = Math.min(1, Math.max(0, t));
      if (t <= 0) { hideRuler(r); return; }

      r.ring.visible = r.label.visible = true;
      r.ring.material.uniforms.uAlpha.value = RING_ALPHA * t;
      r.ring.quaternion.copy(_rulerQuat);   // rings stay at the origin; only the plane turns
      r.label.fillOpacity    = RULER_LABEL_ALPHA * t;
      r.label.outlineOpacity = RULER_LABEL_ALPHA * t;
      r.label.position.copy(camDir).multiplyScalar(r.radius * 1.05);
      r.label.quaternion.copy(cam.quaternion); // billboard: face camera
    });
  }

  function hideRuler(r) {
    r.ring.visible = r.label.visible = false;
  }

  // Master switch for everything the radar toggle drives. The rings themselves are
  // updateRulers' business, re-decided every frame before the next render.
  function updateRadarVisibility() {
    // Same toggle materialises the solar orbit paths and body name labels, and
    // the local group's galaxy names.
    if (solarRenderer)    solarRenderer.setRadarVisible(radarEnabled);
    if (detailedGalaxies) detailedGalaxies.setRadarVisible(radarEnabled);
    if (renderer) renderer.markDirty();
  }

  function createCMBSphere(scene, radius, exposure, power) {
    var base = config.dataUrl + 'aux/cmb/planck_100ghz_';
    var cubeTexture = new THREE.CubeTextureLoader().load([
      base + 'px.jpg', base + 'nx.jpg',
      base + 'py.jpg', base + 'ny.jpg',
      base + 'pz.jpg', base + 'nz.jpg'
    ], function() { if (renderer) renderer.markDirty(); });
    cubeTexture.colorSpace      = THREE.LinearSRGBColorSpace;
    cubeTexture.generateMipmaps = true;
    cubeTexture.minFilter       = THREE.LinearMipmapLinearFilter;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        tCube:     { value: cubeTexture },
        uColor:    { value: new THREE.Vector3(0.25, 0.25, 0.25) },
        uExposure: { value: exposure },
        uPower:    { value: power }
      },
      vertexShader: [
        // Pass a unit-length direction (not world-space position) so mobile mediump
        // varying interpolators don't lose precision on large magnitudes when the
        // camera is outside the sphere (where vertex w varies sharply across triangles).
        'varying vec3 vDir;',
        'void main() {',
        // RTE (Relative-To-Eye) transform: subtract cameraPosition BEFORE the rotation
        // so the mat-vec multiply runs on a small camera-relative vector. The standard
        // modelViewMatrix path adds R*position to a large -R*cameraPosition translation,
        // which loses precision on mobile clip/raster hardware and produces black/dropped
        // triangles when the camera is far from the origin.
        '  vec3 worldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        '  vec3 camRel   = worldPos - cameraPosition;',
        '  vec3 viewPos  = mat3(viewMatrix) * camRel;',
        '  vDir          = normalize(position);',
        '  gl_Position   = projectionMatrix * vec4(viewPos, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform samplerCube tCube;',
        'uniform vec3 uColor;',
        'uniform float uExposure;',
        'uniform float uPower;',
        'varying vec3 vDir;',
        'void main() {',
        // Desired LDR output after tone-mapping
        '  vec3 target = textureCube(tCube, normalize(vDir)).rgb * uColor;',
        '  float Lout = dot(target, vec3(0.2126, 0.7152, 0.0722));',
        // Inverse Generalized Reinhard: find HDR luminance Lin such that tone_map(Lin) = Lout
        // Lin = Lout / pow(1 - pow(Lout, p), 1/p)
        '  float Lout_p = pow(clamp(Lout, 0.0, 0.9999), uPower);',
        '  float Lin = Lout / pow(1.0 - Lout_p, 1.0 / uPower);',
        // Pre-divide by exposure so the tone-mapper multiplies back to Lin
        '  float scale = Lin / max(Lout * uExposure, 0.0001);',
        '  gl_FragColor = vec4(target * scale, 1.0);',
        '}'
      ].join('\n'),
      side:       THREE.BackSide,
      depthWrite: false,
      depthTest:  false
    });

    var geo  = new THREE.IcosahedronGeometry(radius, 9);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    // No rotation needed: cube faces are generated in ICRS Z-up scene coordinates,
    // and the lookup uses world-space position directly as the direction vector.
    scene.add(mesh);
    return mesh;
  }

  function destroy() {
    if (renderer) renderer.input().update = function() {};
    if (detailedGalaxies) { detailedGalaxies.dispose(); detailedGalaxies = null; }
    if (cmbSphere) {
      renderer.scene().remove(cmbSphere);
      cmbSphere.geometry.dispose();
      if (cmbSphere.material.uniforms && cmbSphere.material.uniforms.tCube)
        cmbSphere.material.uniforms.tCube.value.dispose();
      cmbSphere.material.dispose();
      cmbSphere = null;
    }
    if (renderer && rulerObjects.length) {
      var sc = renderer.scene();
      rulerObjects.forEach(function(r) {
        sc.remove(r.ring);
        r.ring.geometry.dispose();
        r.ring.material.dispose();
        if (labelScene) labelScene.remove(r.label);
        r.label.dispose();
      });
    }
    rulerObjects = [];
    if (solarRenderer)    { solarRenderer.dispose();    solarRenderer    = null; }
    if (baseControl)      { baseControl.destroy();      baseControl      = null; }
    if (spaceshipControl) { spaceshipControl.destroy(); spaceshipControl = null; }
    if (satelliteControl) { satelliteControl.destroy(); satelliteControl = null; }
    if (mobileControl)    { mobileControl.destroy();    mobileControl    = null; }
    if (renderer)         { renderer.destroy();         renderer         = null; }
    appEvents.positionsDownloaded.off(setPositions);
    appEvents.tracerRangesReady.off(setTracerRanges);
    appEvents.setTracerVisibility.off(handleSetTracerVisibility);
    appEvents.toggleControlMode.off(toggleControlMode);

    appEvents.focusScene.off(focusScene);
    appEvents.radarReady.off(onRadarReady);
    appEvents.setMovementSpeed.off(onSetMovementSpeed);
    appEvents.resetToOrigin.off(resetToOrigin);

    clearInterval(queryUpdateId);
    appConfig.off('camera', moveCamera);
    appConfig.off('tracersChanged', handleTracersChangedFromURL);
  }
}
