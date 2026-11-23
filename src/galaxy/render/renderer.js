/**
 * Bridge between the app's events and the three.js scene.
 *
 * Creates the engine and every layer drawn in it -- the redshift catalogue, the
 * local group, the stars, the solar system, the CMB and the radar -- and wires
 * them to the loading events, the tracer toggles and the URL state.
 *
 * Control modes (F key or on-screen button to toggle)
 * ----------------------------------------------------
 * Both modes share keyboard controls (W/A/S/D, Q/E, Space/Ctrl, arrows).
 * The mode only changes mouse behaviour:
 *   Satellite — left-drag orbit, scroll zoom, right-drag pan
 *   Spaceship — hold left button to look (pitch/yaw, absolute screen-centre)
 */
import * as THREE from 'three';
import appEvents from '../service/appEvents.js';
import appConfig from '../service/appConfig.js';
import config from '../../config.js';
import createEngine          from './engine.js';
import createCatalogue       from './catalogue.js';
import createBaseControl     from './controls/baseControl.js';
import createSpaceshipControl from './controls/spaceshipControl.js';
import createSatelliteControl from './controls/satelliteControl.js';
import createMobileControl   from './controls/mobileControl.js';
import createDetailedGalaxies from './detailedGxyRenderer.js';
import createSolarRenderer    from './solarRenderer.js';
import createStarField       from './starField.js';
import createLabelLayer      from './labelLayer.js';
import { cartToRaDecR, dirToAzAlt, getLocalFrame, raDec2UnitVec } from './coordUtils.js';
import { createGlowMaterial, makeRadarLabel } from './radarStyle.js';
import slice from './slice.js';

var DEG2RAD = Math.PI / 180;

export default sceneRenderer;

function sceneRenderer(container) {
  var engine, catalogue, mobileControl, satelliteControl, spaceshipControl, baseControl;
  var cameraAnim = null; // active camera animation, or null
  var cmbSphere = null;
  var cmbVisible = true;
  var detailedGalaxies = null;
  var solarRenderer    = null;
  var starField        = null;
  var labels           = null;   // the one label layer; see createLabelLayer
  var radarEnabled = false;
  var rulerObjects  = [];   // [{ ring, label, radius }, ...]
  var labelScene        = null; // separate scene rendered post-tone-map for crisp SDF text
  var DEFAULT_HIDDEN_TRACERS = ['cmb', 'radar'];
  // The Earth button's two stops, both centred on Earth: the opening overview,
  // and Earth close up in the equatorial frame -- the celestial pole up, looking
  // at RA = Dec = 0 -- from where Earth spans about 20 degrees of the view.
  var M_TO_MPC          = 1 / 3.085677581e22;
  var EARTH_VIEW_RADIUS = 3.8e7 * M_TO_MPC;   // 38,000 km
  var EARTH_VIEW_UP     = raDec2UnitVec(0, 90);
  var EARTH_VIEW_FROM   = raDec2UnitVec(180, 0);   // the camera, opposite RA = Dec = 0
  // Centred on Earth, an orbit wider than this flies in to Earth and a narrower
  // one flies out to the overview: about the Sun's distance to the galactic plane.
  var SWITCH_RADIUS     = 1e20 * M_TO_MPC;
  var CENTRED_FRAC      = 1e-3;  // pivot this close to Earth, in orbit radii, counts as on it
  // A flight between the two stops crosses 18.5 decades of scale, so it is timed
  // by decades and the distance is interpolated in log: linearly, Earth would be
  // gone in the first frame. 500 ms a decade makes Earth <-> overview 9 s.
  var FLIGHT_MS_PER_DECADE = 500;
  // The spaceship's return to Earth is a utility move, not a view, so it runs
  // faster: 300 ms a decade brings it home from 5 Gpc (19.8 decades of approach
  // scale, see approachScale) in 5.9 s.
  var APPROACH_MS_PER_DECADE = 300;
  // ...and turns to face Earth in its first quarter (0.5 s at least), so that it
  // looks where it is going for most of the way rather than swinging round late.
  var APPROACH_TURN_FRAC     = 0.25;
  var SHORT_FLIGHT_MS      = 1000;   // fixed-time moves, and the floor of the others
  // Below this distance a flight onto a point goes linear instead of logarithmic
  // (see approachScale). Earth's radius: the decades below it are flown inside
  // Earth, where nothing on screen moves, and in log they never end.
  var LINEAR_BELOW = 6.371e6 * M_TO_MPC;
  var homeAction = null;   // last value sent on homeActionChanged
  var _zUp = null;  // THREE.Vector3(0,0,1), allocated once for setFromUnitVectors
  var _sliceFwd = null; // pre-allocated for per-frame slice normal computation
  var _rulerDir = null, _rulerQuat = null; // per-frame ruler scratch
  // The default label zoom window, both ends an apparent DIAMETER, so one rule
  // covers ten galaxies spanning 2 to 44 kpc: below MIN_DIAM_PX the object is a
  // speck you have dezoomed past; above MAX_DIAM_FRAC of the viewport it
  // overflows the frame and you are inside it rather than looking at it. The
  // dwarfs therefore name themselves only once you are in the M31 group, and the
  // Milky Way only from outside it, with nothing authored per galaxy. Sources
  // whose sizes are floored on screen -- the solar bodies -- override it.
  var LABEL_MIN_DIAM_PX   = 1.5;
  var LABEL_MAX_DIAM_FRAC = 0.5;

  var RING_ALPHA         = 0.005; // peak ring alpha, once fully faded in
  var RULER_LABEL_ALPHA  = 0.8;
  var RING_FADE_DECADES  = 1;    // fade in over one decade of camera distance
  var sliceEnabled = false;
  var currentMode = appConfig.getControlMode();
  var queryUpdateId = setInterval(updateQuery, 200);
  var rulerDefs = [];
  var cmbRadius = 14000;   // fallback; overwritten by radarReady before setPositions

  // Tracer state
  var tracerRanges = null;   // [{ id, name, color, count }]

  appEvents.positionsDownloaded.on(setPositions);
  appEvents.tracerRangesReady.on(setTracerRanges);
  appEvents.setTracerVisibility.on(handleSetTracerVisibility);
  appEvents.toggleControlMode.on(toggleControlMode);

  appEvents.radarReady.on(onRadarReady);
  appEvents.setMovementSpeed.on(onSetMovementSpeed);
  appEvents.resetToOrigin.on(onHomePressed);

  appConfig.on('camera', moveCamera);
  appConfig.on('tracersChanged', handleTracersChangedFromURL);

  return { destroy: destroy };

  function beforeRender() {
    if (sliceEnabled && currentMode === 'satellite') applySlice();
    if (rulerObjects.length) updateRulers();
    if (detailedGalaxies) detailedGalaxies.updateVisibility();
    if (starField)        starField.updateFade();
  }

  function onSetMovementSpeed(v) {
    if (spaceshipControl) spaceshipControl.movementSpeed = v;
  }

  // The Earth button: back onto Earth if the orbit centre has moved off it;
  // otherwise between the two stops, Earth close up and the overview.
  function onHomePressed() {
    if (!engine || cameraAnim) return;
    var action = getHomeAction();
    if (action === 'toEarth') {
      var azAlt = dirToAzAlt(EARTH_VIEW_FROM, EARTH_VIEW_UP);
      flyOrbit(EARTH_VIEW_RADIUS, EARTH_VIEW_UP, azAlt.az, azAlt.alt);
    } else if (action === 'toOverview') {
      var o = appConfig.getDefaultOrbit();
      flyOrbit(o.r, o.up, o.az, o.alt);
    } else {
      resetToOrigin();
    }
  }

  function getHomeAction() {
    if (currentMode !== 'satellite' || !satelliteControl) return 'recenter';
    var r = satelliteControl.getRadius();
    if (satelliteControl.getPivot().length() > CENTRED_FRAC * r) return 'recenter';
    return r >= SWITCH_RADIUS ? 'toEarth' : 'toOverview';
  }

  function updateHomeAction() {
    var action = getHomeAction();
    if (action !== homeAction) {
      homeAction = action;
      appEvents.homeActionChanged.fire(action);
    }
  }

  // The Earth button's fly in / fly out: an orbit about the current pivot, flown
  // to rather than jumped to. The control is set to the end state first, to read
  // the end camera from it, and re-enabled there.
  function flyOrbit(r, up, az, alt) {
    var cam = engine.camera();
    var startPos  = cam.position.clone();
    var startQuat = cam.quaternion.clone();
    var pivot = satelliteControl.getPivot().clone();
    satelliteControl.restoreFromAzAlt(pivot, r, up, az * DEG2RAD, alt * DEG2RAD);
    var endPos  = cam.position.clone();
    var endQuat = cam.quaternion.clone();
    cam.position.copy(startPos);
    cam.quaternion.copy(startQuat);
    satelliteControl.setEnabled(false);

    var startR = startPos.distanceTo(pivot), endR = endPos.distanceTo(pivot);
    startCameraAnim(decadeMs(startR, endR, FLIGHT_MS_PER_DECADE),
      orbitPose(pivot, startR, endR, startQuat, endQuat),
      function() {
        satelliteControl.setEnabled(true);
        updateHomeAction();
      });
  }

  // Back to Earth. In satellite mode the orbit's centre slides onto Earth at fixed
  // time, the view's orientation kept (the radius does not change, so there is no
  // scale to cross). In spaceship mode the camera flies straight at Earth, timed by
  // the decades of distance it closes, and turns to face it on the way.
  function resetToOrigin() {
    var cam = engine.camera();
    var startPos  = cam.position.clone();
    var startQuat = cam.quaternion.clone();

    if (currentMode === 'satellite' && satelliteControl) {
      satelliteControl.setPivot(0, 0, 0); // repositions cam internally
      var endPos  = cam.position.clone();
      var endQuat = cam.quaternion.clone();
      satelliteControl.setEnabled(false);
      startCameraAnim(SHORT_FLIGHT_MS, lerpPose(startPos, endPos, startQuat, endQuat),
        function() { satelliteControl.setEnabled(true); });
    } else {
      var earth = new THREE.Vector3();
      var decades = (approachScale(startPos.length()) - approachScale(0)) / Math.LN10;
      var ms = Math.max(SHORT_FLIGHT_MS, decades * APPROACH_MS_PER_DECADE);
      var turnFrac = Math.min(1, Math.max(SHORT_FLIGHT_MS, APPROACH_TURN_FRAC * ms) / ms);
      startCameraAnim(ms,
        approachPose(earth, startPos, startQuat, facing(startQuat, startPos, earth), turnFrac),
        function() {});
    }
  }

  function updateQuery() {
    if (!engine) return;
    updateHomeAction();
    var camera = engine.camera();
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

  // ── Camera flights ─────────────────────────────────────────────────────────
  //
  // A flight is a duration and a pose: a function placing the camera at eased
  // time te in [0, 1] (and given the raw time t too, for a pose that runs part
  // of itself on a clock of its own). Three kinds of pose:
  //   lerpPose      straight line, orientation slerped. Fixed time: mode switches,
  //                 recentring the orbit on Earth.
  //   orbitPose     about a pivot, radius in log, orientation slerped. Timed by
  //                 decades: the Earth button's fly in / fly out.
  //   approachPose  straight at a point, distance in log then linear (see
  //                 approachScale), orientation slerped. Timed by decades: back
  //                 to Earth in spaceship mode.
  // The slerp is the same in all three: the shortest rotation between the two
  // orientations, at a constant rate in eased time. The approach runs it over the
  // first turnFrac of the flight only, eased on that shorter span.

  function logLerp(a, b, t) {
    return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
  }

  function decadeMs(r0, r1, msPerDecade) {
    if (!(r0 > 0 && r1 > 0)) return SHORT_FLIGHT_MS;   // already there: no scale to cross
    return Math.max(SHORT_FLIGHT_MS, Math.abs(Math.log10(r1 / r0)) * msPerDecade);
  }

  function lerpPose(startPos, endPos, startQuat, endQuat) {
    return function(cam, te) {
      cam.quaternion.slerpQuaternions(startQuat, endQuat, te);
      cam.position.lerpVectors(startPos, endPos, te);
    };
  }

  // Still looking at the pivot, at a radius eased in log.
  function orbitPose(pivot, startR, endR, startQuat, endQuat) {
    return function(cam, te) {
      cam.quaternion.slerpQuaternions(startQuat, endQuat, te);
      cam.position.set(0, 0, 1).applyQuaternion(cam.quaternion)
        .multiplyScalar(logLerp(startR, endR, te)).add(pivot);
    };
  }

  // The scale an approach is flown on, s(r) with r the distance left:
  //   r >= R:  s = ln(r / R)     equal time per decade, as in the other flights
  //   r <  R:  s = r / R - 1     equal time per metre, down to s = -1 at r = 0
  // with R = LINEAR_BELOW. Value and slope (1/R) agree at r = R, so the switch from
  // log to linear is one smooth motion, and the flight reaches the point itself,
  // where log alone would spend the same time on every decade below R, forever.
  function approachScale(r) {
    return r >= LINEAR_BELOW ? Math.log(r / LINEAR_BELOW) : r / LINEAR_BELOW - 1;
  }

  function approachDist(s) {
    return s >= 0 ? LINEAR_BELOW * Math.exp(s) : LINEAR_BELOW * (1 + s);
  }

  // The same straight line as lerpPose, travelled evenly in approachScale.
  function approachPose(target, startPos, startQuat, endQuat, turnFrac) {
    var dist = startPos.distanceTo(target);
    var dir = dist > 0 ? startPos.clone().sub(target).divideScalar(dist) : new THREE.Vector3();
    var s0 = approachScale(dist), s1 = approachScale(0);
    return function(cam, te, t) {
      cam.quaternion.slerpQuaternions(startQuat, endQuat,
        easeInOutQuad(Math.min(t / turnFrac, 1)));
      cam.position.copy(dir).multiplyScalar(approachDist(s0 + (s1 - s0) * te)).add(target);
    };
  }

  // The orientation `quat` turned, by the smallest rotation, to look from `from`
  // at `to`: the axis is normal to the plane of the line of sight and the
  // direction of `to`, so the line of sight stays in that plane as it turns, and
  // the roll about it is left as it was. Standing on `to`, nothing to face.
  function facing(quat, from, to) {
    var toDir = to.clone().sub(from);
    if (toDir.lengthSq() === 0) return quat.clone();
    var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
    return new THREE.Quaternion().setFromUnitVectors(fwd, toDir.normalize()).multiply(quat);
  }

  function animFrame(time) {
    if (!cameraAnim) return;
    if (cameraAnim.startTime === null) cameraAnim.startTime = time;
    var t = Math.min((time - cameraAnim.startTime) / cameraAnim.duration, 1.0);
    cameraAnim.pose(engine.camera(), easeInOutQuad(t), t);
    engine.markDirty();
    if (t >= 1.0) {
      engine.offFrame(animFrame);
      cameraAnim.onDone();
      cameraAnim = null;
    }
  }

  function startCameraAnim(duration, pose, onDone) {
    cameraAnim = { duration: duration, pose: pose, onDone: onDone, startTime: null };
    engine.onFrame(animFrame);
    engine.markDirty();
  }

  function toggleControlMode() {
    if (!engine) return;
    if (cameraAnim) return; // ignore while animation is running

    var cam = engine.camera();

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
      applySlice();
      if (mobileControl) mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode);
      appConfig.setControlMode(currentMode);

      startCameraAnim(SHORT_FLIGHT_MS, lerpPose(startPos, endPos, startQuat, endQuat), function() {
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

      startCameraAnim(SHORT_FLIGHT_MS, lerpPose(startPos, endPos, startQuat, endQuat), function() {
        cam.position.copy(endPos);
        cam.quaternion.copy(endQuat);
        satelliteControl.setEnabled(true); // no cam arg → preserves computed state
        applySlice();
        engine.markDirty();
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

  // One { id, color, positions } per tracer; see graphLoader.
  function setPositions(tracers) {
    // Reset tracer state when new positions arrive
    tracerRanges = null;

    focusScene();

    if (!engine) {
      engine = createEngine(container);
      labelScene = engine.postScene();
      catalogue = createCatalogue(engine.scene());
      catalogue.setViewportHeight(container.clientHeight);
      engine.onResize(catalogue.setViewportHeight);

      var camera = engine.camera();
      camera.updateProjectionMatrix();
      moveCameraInternal();

      var cam = engine.camera();
      baseControl      = createBaseControl(engine.markDirty);
      satelliteControl = createSatelliteControl(cam, container, engine.markDirty, baseControl.keyState);
      spaceshipControl = createSpaceshipControl(cam, container, baseControl.keyState, engine.markDirty);

      // Both controls step every frame; see engine.setUpdate. Neither may be
      // short-circuited: each has to settle its own motion.
      engine.setUpdate(function(delta) {
        var flying  = spaceshipControl.update(delta);
        var gliding = satelliteControl.update(delta);
        if (currentMode === 'spaceship') {
          appEvents.cameraSpeedUpdate.fire(spaceshipControl.currentSpeed, spaceshipControl.movementSpeed);
        }
        return flying || gliding || baseControl.isActive();
      });
      // Everything that depends on where the camera ENDED UP this frame -- after
      // the controls, and after a camera animation, which moves it later in the
      // same frame -- and decides what is drawn, so it must run before the draw.
      engine.onBeforeRender(beforeRender);

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
      cmbSphere = createCMBSphere(engine.scene(), cmbRadius, engine.getExposure(), engine.getPower());
      cmbSphere.visible = cmbVisible;

      // ONE label layer for the whole scene, created before its clients and so
      // registered first in the afterToneMap list -- it must run before the solar
      // pass and before postScene is drawn. Planets, stars, constellations and
      // galaxies then declutter against each other and fade against a single
      // nearest, which is what makes the names hand over cleanly from one scale
      // to the next. Its default zoom window is the galaxies'; the other sources
      // override it (see labelLayer.add).
      labels = createLabelLayer(engine, engine.markDirty, {
        minDiamPx:   LABEL_MIN_DIAM_PX,
        maxDiamFrac: LABEL_MAX_DIAM_FRAC
      });

      starField        = createStarField(engine, engine.markDirty, labels);
      detailedGalaxies = createDetailedGalaxies(engine, engine.markDirty, labels,
        function(mwFrame) {
          // The Milky Way's own frame, from the one manifest fetch, handed to the
          // layer that draws the Sun's orbit in it. Routed rather than re-derived
          // so the orbit cannot end up in a different plane from the disc.
          starField.setGalaxyFrame(mwFrame);
        });
      solarRenderer    = createSolarRenderer(engine, engine.markDirty, labels,
        function(sunPos) {
          starField.setOrigin(sunPos);
        });
      if (configVisible && configVisible.indexOf('local') < 0) {
        setLocalVisible(false);
      }

      radarEnabled = configVisible ? configVisible.indexOf('radar') >= 0 : false;
      rulerObjects = createRadar(engine.scene(), labelScene);
      updateRadarVisibility();

      mobileControl = createMobileControl(engine, satelliteControl, spaceshipControl);
      mobileControl.setMode(currentMode);
      appEvents.controlModeChanged.fire(currentMode); // sync UI button on load
    }

    catalogue.setTracers(tracers);

    var _cv = appConfig.getVisibleTracers();
    sliceEnabled = _cv ? _cv.indexOf('slice') >= 0 : false;
    applySlice();

    engine.markDirty();
  }

  function setTracerRanges(ranges) {
    if (!engine) return;
    tracerRanges = ranges;
    applyTracerVisibility();
    engine.markDirty();
  }

  // A hidden tracer is not drawn at all.
  function applyTracerVisibility() {
    var configVisible = appConfig.getVisibleTracers();
    tracerRanges.forEach(function(tracer) {
      catalogue.setTracerVisible(tracer.id, configVisible
        ? configVisible.indexOf(tracer.id) >= 0
        : DEFAULT_HIDDEN_TRACERS.indexOf(tracer.id) < 0);
    });
  }

  // The HYG stars ARE the Milky Way, so they ride the same switch as the galaxy
  // clouds; toggling one without the other was the odd thing.
  function setLocalVisible(visible) {
    if (detailedGalaxies) detailedGalaxies.setVisible(visible);
    if (starField)        starField.setVisible(visible);
  }

  function handleSetTracerVisibility(tracerId, visible) {
    if (tracerId === 'local') {
      setLocalVisible(visible);
      return;
    }
    if (tracerId === 'slice') {
      sliceEnabled = visible;
      applySlice();
      engine.markDirty();
      return;
    }
    if (tracerId === 'radar') {
      radarEnabled = visible;
      updateRadarVisibility();
      return;
    }
    if (tracerId === 'cmb') {
      cmbVisible = visible;
      if (cmbSphere) { cmbSphere.visible = visible; engine.markDirty(); }
      return;
    }
    if (!tracerRanges || !engine) return;
    catalogue.setTracerVisible(tracerId, visible);
    engine.markDirty();
  }

  // The slice uniforms are shared by reference with every material that honours
  // it -- the catalogue, the local-group clouds, the star field and the
  // constellation and orbit lines -- so this one call sets the whole scene. There
  // is no per-material plumbing and no registry to keep in step.
  //
  // Satellite-only: the wedge is defined by the orbit plane and the pivot, which
  // is a construct of that control and means nothing free-flying.
  function applySlice() {
    var u = slice.uniforms;
    var on = sliceEnabled && currentMode === 'satellite' && satelliteControl;
    u.uSliceEnabled.value = on ? 1.0 : 0.0;
    if (!on || !_sliceFwd) return;
    var upAxis = satelliteControl.getUpAxis();
    _sliceFwd.set(0, 0, -1).applyQuaternion(engine.camera().quaternion);
    _sliceFwd.addScaledVector(upAxis, -_sliceFwd.dot(upAxis));
    var len = _sliceFwd.length();
    if (len < 0.001) return;          // looking straight up the axis: keep the last plane
    u.uSliceNormal.value.copy(_sliceFwd.divideScalar(len));
    u.uSlicePivot.value.copy(satelliteControl.getPivot());
  }

  function handleTracersChangedFromURL() {
    if (!tracerRanges || !engine) return;
    var configVisible = appConfig.getVisibleTracers();
    radarEnabled = configVisible ? configVisible.indexOf('radar') >= 0 : false;
    sliceEnabled  = configVisible ? configVisible.indexOf('slice') >= 0 : false;
    applySlice();
    applyTracerVisibility();

    cmbVisible = configVisible ? configVisible.indexOf('cmb') >= 0 : false;
    if (cmbSphere) cmbSphere.visible = cmbVisible;
    setLocalVisible(configVisible ? configVisible.indexOf('local') >= 0 : true);

    updateRadarVisibility();

    engine.markDirty();
  }

  function moveCamera() {
    moveCameraInternal();
  }

  function moveCameraInternal() {
    if (!engine) return;
    var camera  = engine.camera();
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
    engine.markDirty();
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
      if (engine) engine.markDirty();
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
    var cam     = engine.camera();
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
    // ... the constellation figures and names, and the Sun's galactic orbit.
    if (solarRenderer)    solarRenderer.setRadarVisible(radarEnabled);
    if (detailedGalaxies) detailedGalaxies.setRadarVisible(radarEnabled);
    if (starField)        starField.setRadarVisible(radarEnabled);
    if (engine) engine.markDirty();
  }

  function createCMBSphere(scene, radius, exposure, power) {
    var base = config.dataUrl + 'aux/cmb/planck_100ghz_';
    // Low priority, as everything after the survey but Earth: see solarRenderer.
    var cubeTexture = new THREE.CubeTextureLoader().setPriority('low').load([
      base + 'px.jpg', base + 'nx.jpg',
      base + 'py.jpg', base + 'ny.jpg',
      base + 'pz.jpg', base + 'nz.jpg'
    ], function() { if (engine) engine.markDirty(); });
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
    if (engine) {
      engine.setUpdate(function() { return false; });
      engine.offBeforeRender(beforeRender);
    }
    if (detailedGalaxies) { detailedGalaxies.dispose(); detailedGalaxies = null; }
    if (cmbSphere) {
      engine.scene().remove(cmbSphere);
      cmbSphere.geometry.dispose();
      if (cmbSphere.material.uniforms && cmbSphere.material.uniforms.tCube)
        cmbSphere.material.uniforms.tCube.value.dispose();
      cmbSphere.material.dispose();
      cmbSphere = null;
    }
    if (engine && rulerObjects.length) {
      var sc = engine.scene();
      rulerObjects.forEach(function(r) {
        sc.remove(r.ring);
        r.ring.geometry.dispose();
        r.ring.material.dispose();
        if (labelScene) labelScene.remove(r.label);
        r.label.dispose();
      });
    }
    rulerObjects = [];
    if (catalogue)        { catalogue.setTracers([]);   catalogue        = null; }
    if (solarRenderer)    { solarRenderer.dispose();    solarRenderer    = null; }
    if (starField)        { starField.dispose();        starField        = null; }
    // Last: its clients only hold a reference, they never own it.
    if (labels)           { labels.dispose();           labels           = null; }
    if (baseControl)      { baseControl.destroy();      baseControl      = null; }
    if (spaceshipControl) { spaceshipControl.destroy(); spaceshipControl = null; }
    if (satelliteControl) { satelliteControl.destroy(); satelliteControl = null; }
    if (mobileControl)    { mobileControl.destroy();    mobileControl    = null; }
    if (engine)         { engine.destroy();         engine         = null; }
    appEvents.positionsDownloaded.off(setPositions);
    appEvents.tracerRangesReady.off(setTracerRanges);
    appEvents.setTracerVisibility.off(handleSetTracerVisibility);
    appEvents.toggleControlMode.off(toggleControlMode);

    appEvents.radarReady.off(onRadarReady);
    appEvents.setMovementSpeed.off(onSetMovementSpeed);
    appEvents.resetToOrigin.off(onHomePressed);

    clearInterval(queryUpdateId);
    appConfig.off('camera', moveCamera);
    appConfig.off('tracersChanged', handleTracersChangedFromURL);
  }
}
