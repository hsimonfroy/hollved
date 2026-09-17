/**
 * Spaceship (free-fly) controls.
 *
 * Mouse: hold left → look (absolute pitch/yaw from screen center)
 *        scroll    → set max speed (log scale, 0.01–1000 Mpc/s)
 *
 * Keyboard (via shared keyState from baseControl):
 *   W/S/A/D/Space/Shift → translate; Q/E → roll; arrows → pitch/yaw
 *
 * Mobile (mobileControl writes mobileState):
 *   mobileState.forward/back/left/right → movement
 *   mobileState.yawLeft / pitchDown     → look
 *
 * BOTH thrust and view ease: every input sets a target RATE and update() rides onto
 * it exponentially, under the law and constants satelliteControl exports, so the two
 * modes feel alike.
 *
 * update(delta) must be called every RAF frame (wired via renderer.js) and returns
 * whether the ship is still in motion, which is what keeps the RAF loop running.
 */
import { EASE_TAU, EASE_SETTLE } from './satelliteControl.js';

export default createSpaceshipControl;
export var MIN_MOVE_SPEED = 1e-16; // Mpc/s — exported so cameraHUD can derive its log scale
// export var MIN_MOVE_SPEED = 1e-5; // Mpc/s — exported so cameraHUD can derive its log scale
export var MAX_MOVE_SPEED = 1e3;  // Mpc/s — exported so cameraHUD can derive its log scale
// Only the speed before anything sets one: entering spaceship mode inherits the
// rate the satellite zoom implies, and a URL carries its own.
export var DEFAULT_MOVE_SPEED = 1;  // Mpc/s

function createSpaceshipControl(camera, container, keyState, markDirty) {
  var THREE = window.THREE;
  var enabled = false;

  // Mobile joystick state (written by mobileControl, read here in update)
  var mobileState = {
    forward: 0, back: 0, left: 0, right: 0, yawLeft: 0, pitchDown: 0
  };

  var isMouseLooking = false;
  var mouseYawLeft   = 0;  // -1..1: positive = cursor left of center → yaw left
  var mousePitchDown = 0;  // -1..1: positive = cursor below center   → pitch down

  var MOVE_SPEED = DEFAULT_MOVE_SPEED;   // Mpc/s, set by cursor
  var ROT_SPEED      = 0.4;  // full-deflection turn rate (rad/s), all three axes
  var _currentSpeed  = 0;    // actual speed magnitude this frame (Mpc/s)
  var WHEEL_SPEED    = 0.002; // log-scale sensitivity (matches satelliteControl ZOOM_SPEED)

  var tmpQ = new THREE.Quaternion();

  // What the input asks for, and what the ship is actually doing. Translation is in
  // CAMERA-LOCAL axes (X right, Y up, -Z forward) and in units of MOVE_SPEED;
  // rotation is (pitch, yaw, roll) in units of ROT_SPEED. Both are therefore
  // THROTTLES running 0..1 per axis whatever the scene scale, which is what lets the
  // satellite's EASE_SETTLE be read here as a thousandth of full deflection.
  // Camera-local means a coast follows the nose if you turn during it, the same
  // thrust-vectoring the instantaneous version had.
  var _velT = new THREE.Vector3(), _vel = new THREE.Vector3();
  var _rotT = new THREE.Vector3(), _rot = new THREE.Vector3();
  var _step = new THREE.Vector3();   // scratch: this frame's integral

  // Ease a rate toward what the input asks for and return how far that carries us
  // this frame -- the EXACT integral of the exponential approach,
  //   S(v -> v') = vT*dt + tau*(v - v'),
  // not v'*dt. Plain v'*dt is first order in the frame time, and at 20 fps -- which
  // is what a DESI frame costs -- a step is 0.6 tau, landing a half-second burn 5%
  // further than the same burn at 144 fps. This form telescopes, so a whole coast
  // sums to exactly tau*v however the frames fall.
  //
  // One function for both thrust and view: a rate is a rate, and the two have to
  // feel alike. The result is written into _step, so there is one scratch vector.
  function easeRate(vel, velT, delta) {
    _step.copy(vel);
    if (!vel.equals(velT)) {
      vel.lerp(velT, 1 - Math.exp(-delta / EASE_TAU));
      if (vel.distanceTo(velT) < EASE_SETTLE) vel.copy(velT);
    }
    return _step.sub(vel).multiplyScalar(EASE_TAU).addScaledVector(velT, delta);
  }

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  function readMouse(e) {
    var rect = container.getBoundingClientRect();
    mouseYawLeft   = -((e.clientX - rect.left) - rect.width  / 2) / (rect.width  / 2);
    mousePitchDown =  ((e.clientY - rect.top)  - rect.height / 2) / (rect.height / 2);
  }

  function onMouseDown(e) {
    if (!enabled) return;
    if (e.button === 0) {
      isMouseLooking = true;
      readMouse(e);
      markDirty();
      e.preventDefault();
    }
  }

  function onMouseMove(e) {
    if (!enabled || !isMouseLooking) return;
    readMouse(e);
    markDirty();
  }

  function onMouseUp(e) {
    if (e.button === 0) {
      isMouseLooking = false;
      mouseYawLeft = mousePitchDown = 0;
    }
  }

  // ── Wheel handler (scroll = set max speed) ─────────────────────────────────

  function onContextMenu(e) {
    if (enabled) e.preventDefault();
  }

  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    setMoveSpeed(MOVE_SPEED * Math.exp(-e.deltaY * WHEEL_SPEED));
    markDirty();
  }

  // The one place the speed is bounded. Every source goes through here -- the
  // wheel, the HUD slider, a URL, and the satellite zoom inherited on a mode
  // switch -- so none of them can set a speed outside the slider's own range.
  function setMoveSpeed(v) {
    MOVE_SPEED = Math.max(MIN_MOVE_SPEED, Math.min(MAX_MOVE_SPEED, v));
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  function update(delta) {
    if (!enabled) return false;

    // Translation: the keys set a TARGET velocity and the ship eases onto it, so a
    // tap accelerates and a release coasts to a stop instead of both snapping.
    _velT.set(
      (keyState.right + mobileState.right  ) - (keyState.left + mobileState.left),
       keyState.up    - keyState.down,
      (keyState.back  + mobileState.back   ) - (keyState.forward + mobileState.forward)
    );
    easeRate(_vel, _velT, delta);
    // The EASED speed, so the HUD reads what the ship is doing, not what the key is
    // asking for.
    _currentSpeed = _vel.length() * MOVE_SPEED;
    if (_step.x || _step.y || _step.z) {
      camera.translateX(_step.x * MOVE_SPEED);
      camera.translateY(_step.y * MOVE_SPEED);
      camera.translateZ(_step.z * MOVE_SPEED);
    }

    // The view eases the same way, off the same law: the cursor's offset from centre
    // (or an arrow key, or the joystick) sets a target turn RATE and the camera rides
    // onto it, so a look starts and stops smoothly instead of snapping to full rate
    // on the first frame and to nothing on release.
    _rotT.set(
      (-keyState.pitchDown + keyState.pitchUp ) / 2 - mousePitchDown - mobileState.pitchDown,
      (-keyState.yawRight  + keyState.yawLeft ) / 2 + mouseYawLeft   + mobileState.yawLeft,
       -keyState.rollRight + keyState.rollLeft
    );
    easeRate(_rot, _rotT, delta);
    if (_step.x || _step.y || _step.z) {
      // Small-angle quaternion: the vector part is the half-angle per axis, which is
      // where roll's extra /2 comes from. Scaling is unchanged -- _step is simply the
      // eased integral where the frame's plain `delta` used to be.
      tmpQ.set(_step.x * ROT_SPEED, _step.y * ROT_SPEED, _step.z * ROT_SPEED / 2, 1)
          .normalize();
      camera.quaternion.multiply(tmpQ);
    }

    // What keeps the RAF loop running, and it reports the RATES rather than the
    // displacement on purpose: the first frame after idle carries delta = 0 and so
    // moves nothing, and answering "did the camera move?" there would park the loop
    // again before the motion could ever start. The targets are in the test as well
    // as the current rates, because on that very frame only the target is non-zero.
    // markDirty() cannot do this job -- this frame's own render consumes it.
    return _vel.lengthSq() > 0 || _velT.lengthSq() > 0 ||
           _rot.lengthSq() > 0 || _rotT.lengthSq() > 0;
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  function setEnabled(val) {
    enabled = val;
    if (!val) {
      isMouseLooking = false;
      mouseYawLeft = mousePitchDown = 0;
      _currentSpeed = 0;
      _vel.set(0, 0, 0);  _velT.set(0, 0, 0);
      _rot.set(0, 0, 0);  _rotT.set(0, 0, 0);
      for (var k in mobileState) mobileState[k] = 0;
    }
  }

  // ── Event registration ─────────────────────────────────────────────────────

  container.addEventListener('mousedown',   onMouseDown,   false);
  container.addEventListener('mousemove',   onMouseMove,   false);
  container.addEventListener('contextmenu', onContextMenu, false);
  container.addEventListener('wheel',       onWheel,       { passive: false });
  document.addEventListener ('mouseup',     onMouseUp,     false);

  return {
    update:      update,
    setEnabled:  setEnabled,
    mobileState: mobileState,

    get movementSpeed() { return MOVE_SPEED; },
    set movementSpeed(v) { setMoveSpeed(v); },
    get rollSpeed()      { return ROT_SPEED; },
    set rollSpeed(v)     { ROT_SPEED = v; },
    get currentSpeed()   { return _currentSpeed; },

    destroy: function() {
      setEnabled(false);
      container.removeEventListener('mousedown',   onMouseDown,   false);
      container.removeEventListener('mousemove',   onMouseMove,   false);
      container.removeEventListener('contextmenu', onContextMenu, false);
      container.removeEventListener('wheel',       onWheel,       false);
      document.removeEventListener ('mouseup',     onMouseUp,     false);
    }
  };
}
