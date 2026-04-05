/**
 * Spaceship (free-fly) controls.
 *
 * Desktop mouse:
 *   Hold left button  → look (pitch / yaw) based on absolute cursor position
 *                       relative to screen center (tethered-while-held).
 *   Hold right button → accelerate (calls onAccelerate callback)
 *
 * Keyboard (via shared keyState from baseControl):
 *   W/S/A/D/Space/Shift → translate camera in local space
 *   Q/E                 → roll camera
 *   Arrow keys          → pitch / yaw (same action as mouse in this mode)
 *
 * Mobile (mobileControl writes into mobileState directly):
 *   mobileState.forward/back/left/right → movement
 *   mobileState.yawLeft / pitchDown     → look (continuous, -1..1)
 *
 * update(delta) must be called every RAF frame (wired via renderer.js).
 */
export default createSpaceshipControl;

function createSpaceshipControl(camera, container, keyState, markDirty, onAccelerate) {
  var THREE = window.THREE;
  var enabled = false;

  // Mobile joystick state (written by mobileControl, read here in update)
  var mobileState = {
    forward: 0, back: 0,
    left: 0,    right: 0,
    yawLeft: 0, pitchDown: 0
  };

  // Mouse look / accelerate state
  var isMouseLooking = false;
  var isRightDown    = false;
  var mouseYawLeft   = 0;  // -1..1: positive = cursor left of center  → yaw left
  var mousePitchDown = 0;  // -1..1: positive = cursor below center    → pitch down

  var MOVE_SPEED = 10; // translate speed
  var ROT_SPEED = 0.1; // Q/E upAxis tilt speed (rad/s)

  var tmpQ = new THREE.Quaternion();

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  function readMouse(e) {
    var rect = container.getBoundingClientRect();
    mouseYawLeft   = -((e.clientX - rect.left)  - rect.width  / 2) / (rect.width  / 2);
    mousePitchDown =  ((e.clientY - rect.top)   - rect.height / 2) / (rect.height / 2);
  }

  function onMouseDown(e) {
    if (!enabled) return;
    if (e.button === 0) {
      isMouseLooking = true;
      readMouse(e);
      markDirty();
      e.preventDefault();
    }
    if (e.button === 2 && onAccelerate) {
      isRightDown = true;
      onAccelerate(true);
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
    if (e.button === 2 && isRightDown) {
      isRightDown = false;
      if (onAccelerate) onAccelerate(false);
    }
  }

  function onContextMenu(e) {
    if (enabled) e.preventDefault();
  }

  // ── Per-frame update ───────────────────────────────────────────────────────

  function update(delta) {
    if (!enabled) return;

    var moveMult = delta * MOVE_SPEED;
    var rotMult  = delta * ROT_SPEED / 2; // quaternion rotation is angle divided by 2

    // Translation in camera-local space
    var fwd   = (keyState.forward + mobileState.forward) - (keyState.back  + mobileState.back);
    var right = (keyState.right   + mobileState.right  ) - (keyState.left  + mobileState.left);
    var up    =  keyState.up - keyState.down;

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
  }

  // ── Enable / disable ───────────────────────────────────────────────────────

  function setEnabled(val) {
    enabled = val;
    if (!val) {
      isMouseLooking = false;
      mouseYawLeft = mousePitchDown = 0;
      if (isRightDown && onAccelerate) { isRightDown = false; onAccelerate(false); }
      for (var k in mobileState) mobileState[k] = 0;
    }
  }

  // ── Event registration ─────────────────────────────────────────────────────

  container.addEventListener('mousedown',   onMouseDown,   false);
  container.addEventListener('mousemove',   onMouseMove,   false);
  container.addEventListener('contextmenu', onContextMenu, false);
  document.addEventListener ('mouseup',     onMouseUp,     false);

  return {
    update:      update,
    setEnabled:  setEnabled,
    mobileState: mobileState,

    get movementSpeed() { return MOVE_SPEED; },
    set movementSpeed(v) { MOVE_SPEED = v; },
    get rollSpeed()      { return ROT_SPEED; },
    set rollSpeed(v)     { ROT_SPEED = v; },

    destroy: function() {
      setEnabled(false);
      container.removeEventListener('mousedown',   onMouseDown,   false);
      container.removeEventListener('mousemove',   onMouseMove,   false);
      container.removeEventListener('contextmenu', onContextMenu, false);
      document.removeEventListener ('mouseup',     onMouseUp,     false);
    }
  };
}
