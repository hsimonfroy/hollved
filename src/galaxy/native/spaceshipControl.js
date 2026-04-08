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
 * update(delta) must be called every RAF frame (wired via renderer.js).
 */
export default createSpaceshipControl;

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

  var MAX_MOVE_SPEED = 60;
  var ROT_SPEED      = 0.5;  // Q/E roll speed (rad/s)
  var _currentSpeed  = 0;    // actual speed magnitude this frame (Mpc/s)
  var WHEEL_SPEED    = 0.002; // log-scale sensitivity (matches satelliteControl ZOOM_SPEED)

  var tmpQ = new THREE.Quaternion();

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
    MAX_MOVE_SPEED = Math.max(0.01, Math.min(1000,
      MAX_MOVE_SPEED * Math.exp(-e.deltaY * WHEEL_SPEED)));
    markDirty();
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  function update(delta) {
    if (!enabled) return;

    var moveMult = delta * MAX_MOVE_SPEED;
    var rotMult  = delta * ROT_SPEED / 2; // quaternion rotation is angle/2

    // Translation in camera-local space
    var fwd   = (keyState.forward + mobileState.forward) - (keyState.back  + mobileState.back);
    var right = (keyState.right   + mobileState.right  ) - (keyState.left  + mobileState.left);
    var up    =  keyState.up - keyState.down;

    _currentSpeed = Math.sqrt(fwd*fwd + right*right + up*up) * MAX_MOVE_SPEED;

    if (fwd || right || up) {
      camera.translateZ(-fwd   * moveMult);
      camera.translateX( right * moveMult);
      camera.translateY( up    * moveMult);
    }

    // Rotation: arrow keys + mouse + mobile joystick
    var yaw   = (-keyState.yawRight  + keyState.yawLeft ) + mouseYawLeft   + mobileState.yawLeft;
    var pitch = (-keyState.pitchDown + keyState.pitchUp ) - mousePitchDown  - mobileState.pitchDown;
    var roll  =  -keyState.rollRight + keyState.rollLeft;

    if (yaw || pitch || roll) {
      tmpQ.set(pitch * 2 * rotMult, yaw * 2 * rotMult, roll * rotMult, 1).normalize();
      camera.quaternion.multiply(tmpQ);
    }

    // Keep RAF alive one extra frame after stopping so _currentSpeed is
    // computed as 0 before the loop idles (otherwise stale value lingers in HUD)
    if (_currentSpeed > 0) markDirty();
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  function setEnabled(val) {
    enabled = val;
    if (!val) {
      isMouseLooking = false;
      mouseYawLeft = mousePitchDown = 0;
      _currentSpeed = 0;
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

    get movementSpeed() { return MAX_MOVE_SPEED; },
    set movementSpeed(v) { MAX_MOVE_SPEED = v; },
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
