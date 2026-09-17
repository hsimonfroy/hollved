/**
 * Satellite (orbit) controls.
 *
 * The camera orbits a pivot point using a custom spherical coordinate system
 * whose north pole (upAxis) is derived from the camera's screen-up direction
 * at the time of initialization. This means:
 *   - Whatever is "up" on screen when you enter satellite mode stays up.
 *   - Left-drag rotates around that axis (horizontal) or tilts (vertical).
 *
 *   theta — azimuth around upAxis
 *   phi   — polar angle from upAxis (0 = north pole, π = south pole)
 *   radius — distance from pivot
 *   upAxis — orbit north pole (camera's up direction at init)
 *   fwdRef — theta=0 reference direction in the equatorial plane
 *
 * Desktop:
 *   Left-drag  → orbit (theta / phi)
 *   Right-drag → pan pivot in camera's right/up plane
 *   Scroll     → zoom (change radius)
 *
 * Keyboard (via shared keyState from baseControl, always active):
 *   W/A/S/D/Space/Shift → drive the parked spaceship in the ORBIT PLANE: heading
 *                         from the azimuth, sideways across it, up along upAxis.
 *                         Rate is a fraction of the orbit radius per second, so it
 *                         scales with zoom exactly as a mouse drag does.
 *   Arrow keys         → orbit (theta / phi), same as left-drag
 *   Q/E               → tilt orbit frame (rotate upAxis around camera forward)
 *
 * Mobile (called externally by mobileControl.js):
 *   onTouchRotate(dx, dy)
 *   onTouchZoom(scale)    — scale = newPinchDist / prevPinchDist
 *   onTouchPan(dx, dy)
 */
import { getLocalFrame } from './coordUtils.js';

export default createSatelliteControl;

// The easing law, shared with spaceshipControl so the two modes feel alike: a gap
// closes 63% of the way in EASE_TAU, 95% in three times that, and snaps once what
// is left is under EASE_SETTLE. Both modes ease a RELATIVE quantity -- an angle, a
// log radius, a pivot measured against the orbit radius, a velocity in units of the
// throttle -- so one threshold serves them all. An absolute one would be meaningless
// in a scene spanning 25 orders of magnitude. Lower EASE_TAU toward 0 for the old
// instant response.
export var EASE_TAU    = 0.08; // seconds
export var EASE_SETTLE = 1e-3;

function createSatelliteControl(camera, container, markDirty, keyState) {
  // window.THREE is set by renderer.js before this function is ever called
  var THREE = window.THREE;
  var enabled = false;

  // Spherical coordinates in the custom (upAxis, fwdRef) basis
  var pivot  = new THREE.Vector3(0, 0, 0);
  var radius = 1000;
  var theta  = 0;            // azimuth around upAxis
  var phi    = Math.PI / 2;  // polar from upAxis (0 = top, π = bottom)
  var upAxis = new THREE.Vector3(0, 1, 0); // orbit north pole
  var fwdRef = new THREE.Vector3(0, 0, 1); // theta=0 reference direction

  // Where input wants the orbit. update() eases the displayed orbit above toward
  // it, and every getter still returns the DISPLAYED values, so the URL, the slice
  // and a mode switch all describe what is on screen, not where it is heading.
  var thetaT = theta, phiT = phi, logRT = Math.log(radius);
  var pivotT = new THREE.Vector3();
  // Roll is the one eased quantity with no target of its own: it rotates upAxis
  // around the camera's CURRENT forward, so a total angle would mean nothing once
  // the orbit has eased somewhere else. Only the gap matters, so it IS the gap --
  // the angle still owed. That also keeps it from growing without bound over a long
  // session, which an accumulating target would.
  var rollOwed = 0;
  var easing  = false;
  var easeAge = 0;           // seconds since input last moved a target

  // Mouse drag state
  var isLeftDown  = false;
  var isRightDown = false;
  var lastX = 0;
  var lastY = 0;

  // Rotation sensitivity (radians per pixel)
  var ROT_SPEED = 0.005;
  // Pan sensitivity factor (world units per pixel, relative to radius)
  var PAN_SPEED = 0.001;
  // Zoom constants
  var MIN_RADIUS    = 3.7e-16;          // minimum orbit radius
//   var MIN_RADIUS    = 1e-5;          // minimum orbit radius
  var SWITCH_ANGLE  = Math.PI / 16; // elevation above equatorial plane on satellite entry (rad)
  var ZOOM_SPEED    = 0.002;      // exponential factor per clamped scroll pixel
  // Keyboard-driven rates (per second)
  // Translation is a mouse drag by another name, so it moves a FRACTION of the
  // orbit radius per second rather than a fixed distance -- PAN_SPEED above is
  // 0.001 radii per pixel, making this exactly a steady 500 px/s drag. An
  // absolute rate (it was 100 Mpc/s) is meaningless at a scene spanning 25 orders
  // of magnitude: one keypress crossed a 1e-15 Mpc orbit 1e17 times over.
  var PAN_RATE    = 0.5; // orbit radii per second
  var ORBIT_SPEED = 0.4; // arrow-key orbit speed (rad/s)
  var ROLL_SPEED  = 0.4; // Q/E upAxis tilt speed (rad/s)

  // Scratch for the per-frame keyboard frame; update() ran three allocations a
  // frame while a key was held.
  var _fwd   = new THREE.Vector3();
  var _right = new THREE.Vector3();
  var _step  = new THREE.Vector3();
  var _axis  = new THREE.Vector3();   // flatForward's own, so it never trades scratch
  var _rollAxis = new THREE.Vector3();  // applyRoll's own, for the same reason
  var _rollQ    = new THREE.Quaternion();
  var _seed     = new THREE.Vector3();

  container.addEventListener('mousedown',    onMouseDown,  false);
  container.addEventListener('wheel',        onWheel,      { passive: false });
  container.addEventListener('contextmenu',  onContextMenu, false);
  document.addEventListener('mousemove',     onMouseMove,  false);
  document.addEventListener('mouseup',       onMouseUp,    false);

  return {
    update:            update,
    setEnabled:        setEnabled,
    getPivot:          function() { return pivot; },
    setPivot:          function(x, y, z) { pivot.set(x, y, z); syncTargets(); updateCamera(); },
    getRadius:         function() { return radius; },
    getUpAxis:         function() { return upAxis; },
    restoreFromAzAlt:  restoreFromAzAlt,
    getFlatForward:    function() { return flatForward(new THREE.Vector3()); },
    // The keyboard pan rate, in Mpc/s -- and, on a mode switch, the speed the
    // spaceship inherits. radiusForSpeed is its inverse, for the return trip, so
    // the rule that ties zoom to speed lives here rather than in renderer.js.
    getMoveSpeed:      function() { return PAN_RATE * radius; },
    radiusForSpeed:    function(v) { return v / PAN_RATE; },
    onTouchRotate:   onTouchRotate,
    onTouchZoom:     onTouchZoom,
    onTouchPan:      onTouchPan,
    destroy:         destroy
  };

  // ── Keyboard-driven per-frame update ──────────────────────────────────────

  function update(delta) {
    if (!enabled || !keyState) return false;

    // WASD / Space / Shift → translate the pivot in the ORBIT PLANE.
    //
    // Satellite mode is a third-person view of a spaceship parked flat in that
    // plane -- which is why leaving the mode drops the camera back into it, as if
    // returning to the cockpit. So the ship drives along its own ground: heading
    // from flatForward (the only part that follows the camera), sideways across
    // it, and up along the orbit axis. Driving from camera-local axes instead, as
    // this used to, sent W diagonally out of the plane the moment the view was
    // tilted -- at 45 deg of altitude, half of "forward" was "up".
    // Each block tests the KEY, never the increment it produces. The first frame
    // after idle carries delta = 0, so every increment below is 0 on it: keying off
    // them would skip wake(), the loop would park on that frame, and the motion
    // could never start. It only ever appeared to work because renderer.js also ORs
    // in baseControl.isActive() -- the same accident that broke spaceship
    // click-to-look. This makes the control self-sufficient.
    var kFwd = keyState.forward - keyState.back;
    var kRgt = keyState.right   - keyState.left;
    var kUp  = keyState.up      - keyState.down;
    if (kFwd || kRgt || kUp) {
      var step = PAN_RATE * radius * delta;
      flatForward(_fwd);
      _right.crossVectors(_fwd, upAxis);   // right = forward x up, the camera convention
      _step.set(0, 0, 0)
        .addScaledVector(_fwd,   kFwd * step)
        .addScaledVector(_right, kRgt * step)
        .addScaledVector(upAxis, kUp  * step);
      pivotT.add(_step);
      wake();
    }

    // Arrow keys → orbit (same as left-drag)
    var kYaw   = keyState.yawLeft - keyState.yawRight;
    var kPitch = keyState.pitchUp - keyState.pitchDown;
    if (kYaw || kPitch) {
      thetaT += kYaw * ORBIT_SPEED * delta;
      phiT    = Math.max(0.01, Math.min(Math.PI - 0.01,
                                        phiT + kPitch * ORBIT_SPEED * delta));
      wake();
    }

    // Q/E → tilt the orbit horizon. The key only adds to what is OWED; the ease
    // block below pays it out, on the same law as every other input.
    var kRoll = keyState.rollRight - keyState.rollLeft;
    if (kRoll) {
      rollOwed += kRoll * ROLL_SPEED * delta;
      wake();
    }

    if (easing) {
      // Frame-rate independent: the same glide at 20 fps as at 144, which matters
      // when a frame carries millions of particles.
      var k    = 1 - Math.exp(-delta / EASE_TAU);
      var logR = Math.log(radius);
      theta += (thetaT - theta) * k;
      phi   += (phiT   - phi)   * k;
      // In LOG radius, so a zoom glide is a constant ratio per frame. Easing the
      // radius itself would spend the whole glide near the larger value and leap
      // at the end -- across 25 orders of magnitude, no easing at all.
      radius = Math.exp(logR + (logRT - logR) * k);
      pivot.lerp(pivotT, k);
      // Pay out k of the owed roll and keep the rest -- identical to the lines
      // above, since easing a value toward a target IS draining the gap between
      // them. Easing the owed ANGLE is also the same first-order response as
      // easing the RATE, which is spaceshipControl's form: with p the owed angle,
      // p' = R - p/tau, so the applied rate r = p/tau obeys r' = (R - r)/tau
      // either way. Same feel, and here it needs no second variable.
      if (rollOwed) { applyRoll(rollOwed * k); rollOwed *= 1 - k; }
      easeAge += delta;
      // Every test is relative -- angles are scale-free, the pivot is measured
      // against the radius -- because an absolute epsilon means nothing in this
      // scene. The age cap guarantees the loop idles even where float64 cannot
      // resolve the last step (a tiny orbit around a far pivot) instead of
      // rendering millions of particles forever.
      // `delta > 0` because a frame in which no time passed has converged to
      // nothing: the first frame after idle carries delta = 0, and on it a held key
      // has not moved its target yet, so every gap below reads zero and the ease
      // would declare itself finished before it began -- parking the loop and
      // swallowing the keypress.
      if (easeAge > 20 * EASE_TAU ||
          (delta > 0 &&
           Math.abs(thetaT - theta) < EASE_SETTLE && Math.abs(phiT - phi) < EASE_SETTLE &&
           Math.abs(logRT - Math.log(radius)) < EASE_SETTLE &&
           Math.abs(rollOwed) < EASE_SETTLE &&
           pivot.distanceTo(pivotT) < EASE_SETTLE * radius)) {
        theta = thetaT; phi = phiT; radius = Math.exp(logRT); pivot.copy(pivotT);
        if (rollOwed) { applyRoll(rollOwed); rollOwed = 0; }
        easing = false;
      }
      // Every input now routes through wake() and is paid out here, so this is the
      // only place the camera moves -- there is no longer a `hasMoved` flag to keep
      // in step with it. The roll was the last thing that bypassed the ease.
      updateCamera();
    }
    return easing;
  }

  function wake() { easing = true; easeAge = 0; markDirty(); }

  // Rotate the orbit frame around the camera's CURRENT forward. Was inline in
  // update() and allocated a Vector3, a Quaternion and sometimes a seed every frame
  // a key was held -- the very thing the scratch vectors above exist to avoid.
  function applyRoll(angle) {
    _rollAxis.set(0, 0, -1).applyQuaternion(camera.quaternion);
    upAxis.applyQuaternion(_rollQ.setFromAxisAngle(_rollAxis, angle)).normalize();
    // Re-orthogonalize fwdRef against the rotated upAxis
    var d = fwdRef.dot(upAxis);
    fwdRef.x -= upAxis.x * d;
    fwdRef.y -= upAxis.y * d;
    fwdRef.z -= upAxis.z * d;
    if (fwdRef.lengthSq() < 1e-6) {
      _seed.set(1, 0, 0);
      if (Math.abs(upAxis.dot(_seed)) > 0.9) _seed.set(0, 0, 1);
      fwdRef.crossVectors(_seed, upAxis).normalize();
    } else {
      fwdRef.normalize();
    }
  }

  // Programmatic moves -- URL restore, mode switch, setPivot -- JUMP; only input
  // glides. So they pin the targets to the displayed orbit, or the next update()
  // would ease the camera straight back to wherever input last left it.
  function syncTargets() {
    thetaT = theta; phiT = phi; logRT = Math.log(radius);
    pivotT.copy(pivot);
    rollOwed = 0;     // a programmatic move must not inherit a pending tilt
    easing = false;
  }

  // ── Restore from az/alt (called by renderer.js on URL load/change) ──────────

  function restoreFromAzAlt(pivot3, r3, upAxisIn, az_rad, alt_rad) {
    pivot.set(pivot3.x, pivot3.y, pivot3.z);
    radius = Math.max(MIN_RADIUS, r3);
    upAxis.set(upAxisIn.x, upAxisIn.y, upAxisIn.z).normalize();

    var frame  = getLocalFrame(upAxis);
    var cosAlt = Math.cos(alt_rad), sinAlt = Math.sin(alt_rad);
    var cosAz  = Math.cos(az_rad),  sinAz  = Math.sin(az_rad);
    var dx = cosAlt * (cosAz * frame.north.x + sinAz * frame.east.x) + sinAlt * upAxis.x;
    var dy = cosAlt * (cosAz * frame.north.y + sinAz * frame.east.y) + sinAlt * upAxis.y;
    var dz = cosAlt * (cosAz * frame.north.z + sinAz * frame.east.z) + sinAlt * upAxis.z;

    phi = Math.acos(Math.max(-1, Math.min(1, dx * upAxis.x + dy * upAxis.y + dz * upAxis.z)));
    phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi));

    var dot = dx * upAxis.x + dy * upAxis.y + dz * upAxis.z;
    var hx = dx - upAxis.x * dot, hy = dy - upAxis.y * dot, hz = dz - upAxis.z * dot;
    var hLen = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (hLen > 1e-6) {
      fwdRef.set(hx / hLen, hy / hLen, hz / hLen);
    } else {
      var seed = new THREE.Vector3(1, 0, 0);
      if (Math.abs(upAxis.dot(seed)) > 0.9) seed.set(0, 0, 1);
      fwdRef.crossVectors(seed, upAxis).normalize();
    }
    theta = 0;
    syncTargets();
    updateCamera();
  }

  // ── Enable / disable ──────────────────────────────────────────────────────

  function setEnabled(val, cam, startRadius) {
    enabled = val;
    if (val && cam) initFromCamera(cam, startRadius);
  }

  // startRadius is required: renderer.js always derives it from the flying speed
  // via radiusForSpeed(), so the orbit you arrive in matches the one you left.
  function initFromCamera(cam, startRadius) {
    // Pivot = spaceship position (where the camera was in spaceship mode).
    pivot.copy(cam.position);
    radius = startRadius;

    // North pole = camera's current screen-up direction in world space
    upAxis.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();

    // Direction from pivot to new camera position = camera backward = (0,0,1) in camera space
    var dir = new THREE.Vector3(0, 0, 1).applyQuaternion(cam.quaternion);
    phi = Math.acos(Math.max(-1, Math.min(1, dir.dot(upAxis))));
    phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi - SWITCH_ANGLE));

    // Reference direction = dir projected onto the equatorial plane.
    // With theta=0, updateCamera() will place the camera at pivot + radius * dir.
    var dot = dir.dot(upAxis);
    var projected = new THREE.Vector3(
      dir.x - upAxis.x * dot,
      dir.y - upAxis.y * dot,
      dir.z - upAxis.z * dot
    );
    if (projected.lengthSq() > 1e-6) {
      fwdRef.copy(projected).normalize();
    } else {
      // dir is parallel to upAxis — pick any perpendicular direction
      var seed = new THREE.Vector3(1, 0, 0);
      if (Math.abs(upAxis.dot(seed)) > 0.9) seed.set(0, 0, 1);
      fwdRef.crossVectors(seed, upAxis).normalize();
    }
    theta = 0;

    syncTargets();
    updateCamera();
  }

  // ── Camera update ─────────────────────────────────────────────────────────

  function updateCamera() {
    // Build the third orthonormal basis axis (theta = π/2 direction)
    var fwdAxis = new THREE.Vector3().crossVectors(upAxis, fwdRef).normalize();

    var sinPhi = Math.sin(phi);
    var cosPhi = Math.cos(phi);
    var cosT   = Math.cos(theta);
    var sinT   = Math.sin(theta);

    camera.position.set(
      pivot.x + radius * (sinPhi * cosT * fwdRef.x + sinPhi * sinT * fwdAxis.x + cosPhi * upAxis.x),
      pivot.y + radius * (sinPhi * cosT * fwdRef.y + sinPhi * sinT * fwdAxis.y + cosPhi * upAxis.y),
      pivot.z + radius * (sinPhi * cosT * fwdRef.z + sinPhi * sinT * fwdAxis.z + cosPhi * upAxis.z)
    );
    camera.up.copy(upAxis); // ensure lookAt aligns correctly
    camera.lookAt(pivot);
    markDirty();
  }

  // ── Desktop mouse ─────────────────────────────────────────────────────────

  function onMouseDown(e) {
    if (!enabled) return;
    if (e.button === 0) isLeftDown  = true;
    if (e.button === 2) isRightDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!enabled) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isLeftDown)  applyRotate(dx, dy);
    if (isRightDown) applyPan(dx, dy);
  }

  function onMouseUp(e) {
    if (e.button === 0) isLeftDown  = false;
    if (e.button === 2) isRightDown = false;
  }

  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    applyZoom(e.deltaY);
  }

  function onContextMenu(e) {
    if (!enabled) return;
    e.preventDefault(); // suppress right-click browser menu
  }

  // ── Shared math ───────────────────────────────────────────────────────────

  // Equatorial direction the parked spaceship faces: the opposite of the
  // horizontal component of the direction from pivot to camera. Used both to
  // orient the ship when returning to spaceship mode and to drive W/S/A/D here.
  function flatForward(out) {
    var fwdAxis = _axis.crossVectors(upAxis, fwdRef).normalize();
    return out.set(
      -(Math.cos(theta) * fwdRef.x + Math.sin(theta) * fwdAxis.x),
      -(Math.cos(theta) * fwdRef.y + Math.sin(theta) * fwdAxis.y),
      -(Math.cos(theta) * fwdRef.z + Math.sin(theta) * fwdAxis.z)
    ).normalize();
  }

  function applyRotate(dx, dy) {
    thetaT -= dx * ROT_SPEED;
    phiT    = Math.max(0.01, Math.min(Math.PI - 0.01, phiT - dy * ROT_SPEED));
    wake();
  }

  function applyPan(dx, dy) {
    // camera.lookAt() sets camera.quaternion but not camera.matrix, so use
    // quaternion directly to get world-space right/up vectors
    var right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    var up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    var scale = radius * PAN_SPEED;
    right.multiplyScalar(-dx * scale);
    up.multiplyScalar(dy * scale);
    pivotT.add(right);
    pivotT.add(up);
    wake();
  }

  function applyZoom(delta) {
    // Accumulated on the TARGET, so scrolling several notches during a glide adds
    // up instead of each notch compounding from wherever the glide had got to.
    logRT = Math.max(Math.log(MIN_RADIUS), logRT + delta * ZOOM_SPEED);
    wake();
  }

  // ── Touch API (called by mobileControl.js) ────────────────────────────────

  function onTouchRotate(dx, dy) {
    if (!enabled) return;
    applyRotate(dx, dy);
  }

  function onTouchZoom(scale) {
    if (!enabled) return;
    // scale = newDist / prevDist: > 1 means fingers spread (zoom in = smaller radius)
    logRT = Math.max(Math.log(MIN_RADIUS), logRT - Math.log(scale));
    wake();
  }

  function onTouchPan(dx, dy) {
    if (!enabled) return;
    applyPan(dx, dy);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function destroy() {
    container.removeEventListener('mousedown',   onMouseDown,   false);
    container.removeEventListener('wheel',       onWheel,       false);
    container.removeEventListener('contextmenu', onContextMenu, false);
    document.removeEventListener('mousemove',    onMouseMove,   false);
    document.removeEventListener('mouseup',      onMouseUp,     false);
  }
}
