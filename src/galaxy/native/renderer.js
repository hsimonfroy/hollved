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
import { Text } from 'troika-three-text';

export default sceneRenderer;

function sceneRenderer(container) {
  var renderer, positions, mobileControl, satelliteControl, spaceshipControl, baseControl;
  var cmbSphere = null;
  var cmbVisible = true;
  var rulersEnabled = false;
  var rulerObjects  = [];   // [{ ring, label, radius }, ...]
  var labelScene        = null; // separate scene rendered post-tone-map for crisp SDF text
  var DEFAULT_HIDDEN_TRACERS = ['cmb', 'rulers', 'mw'];
  var _zUp = null;  // THREE.Vector3(0,0,1), allocated once for setFromUnitVectors
  var currentMode = appConfig.getControlMode();
  var queryUpdateId = setInterval(updateQuery, 200);
  var rulerDefs = [];
  var cmbRadius = 14000;   // fallback; overwritten by rulersReady before setPositions

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
  appEvents.rulersReady.on(onRulersReady);

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
    var pos  = (currentMode === 'satellite' && satelliteControl) ? satelliteControl.getPivot() : camera.position;
    var zoom = satelliteControl ? satelliteControl.getRadius() : appConfig.getZoom();
    appConfig.setCameraConfig(pos, camera.quaternion, zoom);
    appEvents.cameraHUDUpdate.fire({ x: camera.position.x, y: camera.position.y, z: camera.position.z });
  }

  function toggleControlMode() {
    if (!renderer) return;

    if (currentMode === 'satellite') {
      // Back to spaceship: teleport to pivot, orient flat in the satellite plane
      var cam = renderer.camera();
      var flatFwd = satelliteControl.getFlatForward();
      cam.position.copy(satelliteControl.getPivot());
      cam.up.copy(satelliteControl.getUpAxis());
      cam.lookAt(new THREE.Vector3(
        cam.position.x + flatFwd.x,
        cam.position.y + flatFwd.y,
        cam.position.z + flatFwd.z
      ));
      currentMode = 'spaceship';
      satelliteControl.setEnabled(false);
      spaceshipControl.setEnabled(true);
      updateRulersVisibility();
    } else {
      currentMode = 'satellite';
      spaceshipControl.setEnabled(false);
      satelliteControl.setEnabled(true, renderer.camera(), appConfig.getZoom());
      updateRulersVisibility();
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

  function onRulersReady(data) {
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
      spaceshipControl = createSpaceshipControl(cam, container, baseControl.keyState, renderer.markDirty,
        function(v) { appEvents.accelerateNavigation.fire(v); });

      // Wire both controls into the per-frame update slot exposed by unrender.
      // baseControl.isActive() keeps the loop alive while keys are held
      // (camera may not have moved yet on the very first key-down frame).
      renderer.input().update = function(delta) {
        spaceshipControl.update(delta);
        satelliteControl.update(delta);
        if (baseControl.isActive()) renderer.markDirty();
        if (rulersEnabled && currentMode === 'satellite' && rulerObjects.length) {
          var upAxis = satelliteControl.getUpAxis();
          var cam    = renderer.camera();
          // Project camera position onto the equatorial plane to find the label direction
          var camDir = cam.position.clone();
          camDir.addScaledVector(upAxis, -camDir.dot(upAxis));
          var hasCamDir = camDir.length() > 0.0001;
          if (hasCamDir) camDir.normalize();
          rulerObjects.forEach(function(r) {
            // Rings stay fixed at origin; only orientation tracks upAxis (roll)
            r.ring.quaternion.setFromUnitVectors(_zUp, upAxis);
            // Label sits at the ring edge closest to the camera in the equatorial plane
            if (hasCamDir) {
              r.label.position.copy(camDir).multiplyScalar(r.radius * 1.05);
            }
            r.label.quaternion.copy(cam.quaternion); // billboard: face camera
          });
        }
      };

      if (currentMode === 'satellite') {
        spaceshipControl.setEnabled(false);
        satelliteControl.setEnabled(true);  // just set enabled flag, no initFromCamera
        moveCameraInternal();               // restoreFromURL with URL state
      } else {
        satelliteControl.setEnabled(false);
        spaceshipControl.setEnabled(true);
      }

      _zUp = new THREE.Vector3(0, 0, 1);

      var configVisible = appConfig.getVisibleTracers();
      cmbVisible = configVisible ? configVisible.indexOf('cmb') >= 0 : false;
      cmbSphere = createCMBSphere(renderer.scene(), cmbRadius, renderer.getExposure(), renderer.getPower());
      cmbSphere.visible = cmbVisible;

      rulersEnabled = configVisible ? configVisible.indexOf('rulers') >= 0 : false;
      rulerObjects = createRulers(renderer.scene(), labelScene);
      updateRulersVisibility();

      mobileControl = createMobileControl(renderer, satelliteControl, spaceshipControl);
      mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode); // sync UI button on load
    }

    renderer.particles(positions);
    renderer.markDirty();
  }

  function setTracerRanges(ranges) {
    if (!renderer) return;
    tracerRanges = ranges;

    // Initialize visibility from URL config (null = use defaults)
    // 'mw' is tied to rulers, not independently configurable
    var configVisible = appConfig.getVisibleTracers();
    ranges.forEach(function(tracer) {
      if (tracer.id === 'mw') {
        tracerVisibility['mw'] = rulersEnabled;
      } else {
        tracerVisibility[tracer.id] = configVisible
          ? configVisible.indexOf(tracer.id) >= 0
          : DEFAULT_HIDDEN_TRACERS.indexOf(tracer.id) < 0;
      }
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
    if (tracerId === 'rulers') {
      rulersEnabled = visible;
      updateRulersVisibility();
      handleSetTracerVisibility('mw', visible);
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

  function handleTracersChangedFromURL() {
    if (!tracerRanges || !renderer) return;
    var configVisible = appConfig.getVisibleTracers();
    rulersEnabled = configVisible ? configVisible.indexOf('rulers') >= 0 : false;
    tracerRanges.forEach(function(tracer) {
      if (tracer.id === 'mw') {
        tracerVisibility['mw'] = rulersEnabled;
      } else {
        tracerVisibility[tracer.id] = configVisible ? configVisible.indexOf(tracer.id) >= 0 : DEFAULT_HIDDEN_TRACERS.indexOf(tracer.id) < 0;
      }
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

    updateRulersVisibility();

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

    if (newMode !== currentMode && satelliteControl && spaceshipControl) {
      // Mode changed via URL — perform full mode switch
      currentMode = newMode;
      if (newMode === 'satellite') {
        spaceshipControl.setEnabled(false);
        satelliteControl.restoreFromURL(pos, zoom, lookAt);
        satelliteControl.setEnabled(true);
        updateRulersVisibility();
      } else {
        satelliteControl.setEnabled(false);
        camera.position.set(pos.x, pos.y, pos.z);
        camera.quaternion.set(lookAt.x, lookAt.y, lookAt.z, lookAt.w);
        spaceshipControl.setEnabled(true);
        updateRulersVisibility();
      }
      if (mobileControl) mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode);
      appConfig.setControlMode(currentMode);
    } else if (newMode === 'satellite' && satelliteControl) {
      satelliteControl.restoreFromURL(pos, zoom, lookAt);
    } else {
      if (pos) camera.position.set(pos.x, pos.y, pos.z);
      if (lookAt) camera.quaternion.set(lookAt.x, lookAt.y, lookAt.z, lookAt.w);
    }
    renderer.markDirty();
  }

  // ---------------------------------------------------------------------------
  // Cosmological distance rulers
  // ---------------------------------------------------------------------------

  function createRulerRing(radius) {
    var tubeR = radius * 0.005;   // visual glow half-width
    // facing = |dot(N, V)| → 0 at silhouette, 1 at surface facing camera
    var geo = new THREE.TorusGeometry(radius, tubeR, 16, 256);
    var mat = new THREE.ShaderMaterial({
      vertexShader: [
        'varying vec3 vViewPosition;',
        'varying vec3 vViewNormal;',
        'void main() {',
        '  vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);',
        '  vViewPosition = mvPos.xyz;',
        '  vViewNormal   = normalize(normalMatrix * normal);',
        '  gl_Position   = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vViewPosition;',
        'varying vec3 vViewNormal;',
        'void main() {',
        '  vec3  viewDir = normalize(-vViewPosition);',
        '  float facing  = abs(dot(vViewNormal, viewDir));',
        // pow(2): Gaussian-like radial falloff, 0 at silhouette → no aliasing
        '  float alpha   = pow(facing, 2.0) * 0.5;',
        '  gl_FragColor  = vec4(2.0, 2.0, 2.0, min(alpha, 1.0));',
        '}'
      ].join('\n'),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    return new THREE.Mesh(geo, mat);
  }

  function makeRulerLabel(text, radius) {
    var label = new Text();
    label.text         = text;
    label.fontSize     = radius * 0.04;
    // Labels render post-tone-map (in postScene) so plain white is truly white.
    label.color        = 0xffffff;
    label.outlineWidth = '10%';        // proportional black stroke
    label.outlineColor = '#000000';
    label.anchorX      = 'center';
    label.anchorY      = 'middle';
    label.depthTest    = false;
    label.renderOrder  = 999;
    label.sync(function() {
      // Text geometry is ready — wake the RAF loop so the label appears immediately.
      if (renderer) renderer.markDirty();
    });
    return label;
  }

  function createRulers(scene, ls) {
    var objs = (rulerDefs || []).map(function(def) {
      var distStr = def.radius < 1000
        ? def.radius.toFixed(0) + ' Mpc'
        : (def.radius / 1000).toFixed(1) + ' Gpc';
      var ring  = createRulerRing(def.radius);
      var label = makeRulerLabel(def.name + ' \u00b7 ' + distStr, def.radius);
      scene.add(ring); ls.add(label);
      return { ring: ring, label: label, radius: def.radius };
    });
    return objs;
  }

  function updateRulersVisibility() {
    var show = rulersEnabled && currentMode === 'satellite';
    rulerObjects.forEach(function(r) {
      r.ring.visible  = show;
      r.label.visible = show;
    });
    if (renderer) renderer.markDirty();
  }

  function createCMBSphere(scene, radius, exposure, power) {
    var base = config.dataUrl + 'aux/cmb/planck_100ghz_';
    var cubeTexture = new THREE.CubeTextureLoader().load([
      base + 'px.jpg', base + 'nx.jpg',
      base + 'py.jpg', base + 'ny.jpg',
      base + 'pz.jpg', base + 'nz.jpg'
    ], function() { if (renderer) renderer.markDirty(); });
    cubeTexture.colorSpace = THREE.LinearSRGBColorSpace;

    var mat = new THREE.ShaderMaterial({
      uniforms: {
        tCube:    { value: cubeTexture },
        uColor:   { value: new THREE.Vector3(0.2, 0.2, 0.2) },
        uExposure: { value: exposure },
        uPower:   { value: power }
      },
      vertexShader: [
        'varying vec3 vWorldPos;',
        'void main() {',
        '  vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform samplerCube tCube;',
        'uniform vec3 uColor;',
        'uniform float uExposure;',
        'uniform float uPower;',
        'varying vec3 vWorldPos;',
        'void main() {',
        // Desired LDR output after tone-mapping
        '  vec3 target = textureCube(tCube, normalize(vWorldPos)).rgb * uColor;',
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
      side: THREE.BackSide,
      depthWrite: false
    });

    var geo  = new THREE.IcosahedronGeometry(radius, 10);
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1;
    // No rotation needed: cube faces are generated in ICRS Z-up scene coordinates,
    // and the lookup uses world-space position directly as the direction vector.
    scene.add(mesh);
    return mesh;
  }

  function destroy() {
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
    if (baseControl)      { baseControl.destroy();      baseControl      = null; }
    if (spaceshipControl) { spaceshipControl.destroy(); spaceshipControl = null; }
    if (satelliteControl) { satelliteControl.destroy(); satelliteControl = null; }
    if (mobileControl)    { mobileControl.destroy();    mobileControl    = null; }
    renderer.destroy();
    appEvents.positionsDownloaded.off(setPositions);
    appEvents.tracerRangesReady.off(setTracerRanges);
    appEvents.setTracerVisibility.off(handleSetTracerVisibility);
    appEvents.toggleControlMode.off(toggleControlMode);
    appEvents.accelerateNavigation.off(accelarate);
    appEvents.focusScene.off(focusScene);
    appEvents.rulersReady.off(onRulersReady);
    renderer = null;

    clearInterval(queryUpdateId);
    appConfig.off('camera', moveCamera);
    appConfig.off('tracersChanged', handleTracersChangedFromURL);
  }
}
