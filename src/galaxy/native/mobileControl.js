export default createMobileControl;

var JOYSTICK_RADIUS = 60;   // px — half of 120px base diameter
var DEAD_ZONE       = 0.15; // fraction of joystick radius, no input below this

function createMobileControl(renderer) {
  var input     = renderer.input();
  var container = renderer.getContainer();

  // DOM — appended to body so it floats above the WebGL canvas
  var joystickBase = createElement('div', 'joystick-base');
  var joystickKnob = createElement('div', 'joystick-knob');
  joystickBase.appendChild(joystickKnob);
  document.body.appendChild(joystickBase);

  // Touch tracking (by identifier, for simultaneous multi-touch)
  var joystickTouchId = null;
  var lookTouchId     = null;
  var joystickOrigin  = null; // { x, y } center in client coords at touch start
  var lookLast        = null; // { x, y } last position of the look touch
  var lookStartQuat   = null; // camera quaternion snapshot at look touch start
  var lookOriginX     = null; // touch x at look touch start
  var lookOriginY     = null; // touch y at look touch start

  // { passive: false } is required to call e.preventDefault() in modern browsers
  container.addEventListener('touchstart',  onTouchStart, { passive: false });
  container.addEventListener('touchmove',   onTouchMove,  { passive: false });
  container.addEventListener('touchend',    onTouchEnd,   false);
  container.addEventListener('touchcancel', onTouchEnd,   false);

  return { destroy: destroy };

  // ── Event handlers ────────────────────────────────────────────────────────

  function onTouchStart(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if (joystickTouchId === null && isOverJoystick(t)) {
        joystickTouchId = t.identifier;
        joystickOrigin  = joystickCenter();
        updateJoystick(t);
      } else if (lookTouchId === null) {
        lookTouchId   = t.identifier;
        lookLast      = { x: t.clientX, y: t.clientY };
        lookOriginX   = t.clientX;
        lookOriginY   = t.clientY;
        lookStartQuat = renderer.camera().quaternion.clone();
      }
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if      (t.identifier === joystickTouchId) updateJoystick(t);
      else if (t.identifier === lookTouchId)     updateLook(t);
    }
  }

  function onTouchEnd(e) {
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if (t.identifier === joystickTouchId) {
        joystickTouchId = null;
        joystickOrigin  = null;
        joystickKnob.style.transform = 'translate(0px,0px)';
        input.moveState.forward = input.moveState.back  = 0;
        input.moveState.left    = input.moveState.right = 0;
        input.updateMovementVector();
      }
      if (t.identifier === lookTouchId) {
        lookTouchId   = null;
        lookLast      = null;
        lookStartQuat = null;
        lookOriginX   = null;
        lookOriginY   = null;
        input.moveState.yawLeft   = 0;
        input.moveState.pitchDown = 0;
        input.updateRotationVector();
      }
    }
  }

  // ── Joystick ──────────────────────────────────────────────────────────────

  function updateJoystick(touch) {
    var dx = touch.clientX - joystickOrigin.x;
    var dy = touch.clientY - joystickOrigin.y;
    var d  = Math.sqrt(dx * dx + dy * dy);

    // Clamp to base radius
    if (d > JOYSTICK_RADIUS) {
      dx = dx / d * JOYSTICK_RADIUS;
      dy = dy / d * JOYSTICK_RADIUS;
    }

    // Move knob visually
    joystickKnob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';

    // Normalize to [-1, 1] with dead zone
    var nx = applyDeadZone(dx / JOYSTICK_RADIUS);
    var ny = applyDeadZone(dy / JOYSTICK_RADIUS);

    // Y axis: up (ny < 0) = forward, down (ny > 0) = back
    // X axis: right (nx > 0) = strafe right, left (nx < 0) = strafe left
    input.moveState.forward = Math.max(0, -ny);
    input.moveState.back    = Math.max(0,  ny);
    input.moveState.right   = Math.max(0,  nx);
    input.moveState.left    = Math.max(0, -nx);
    input.updateMovementVector();
  }

  function isOverJoystick(touch) {
    var c  = joystickCenter();
    var dx = touch.clientX - c.x;
    var dy = touch.clientY - c.y;
    // +20px tolerance around the base circle
    var r = JOYSTICK_RADIUS + 20;
    return (dx * dx + dy * dy) <= r * r;
  }

  function joystickCenter() {
    var rect = joystickBase.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  // ── Look (drag-to-rotate) ─────────────────────────────────────────────────

  function updateLook(touch) {
    if (!lookStartQuat) return;
    var camera = renderer.camera();

    var totalDx = touch.clientX - lookOriginX;
    var totalDy = touch.clientY - lookOriginY;

    // Full screen width drag = one camera FOV of rotation
    var fovRad     = camera.fov * Math.PI / 180;
    var yawAngle   = -(totalDx / container.clientWidth)  * fovRad;
    var pitchAngle =  (totalDy / container.clientHeight) * fovRad;

    // Apply rotations in camera-local space (same convention as FlyControls)
    var yawQ   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);
    var pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchAngle);
    camera.quaternion.copy(lookStartQuat).multiply(yawQ).multiply(pitchQ);

    // Keep FlyControls rotation quiet so it doesn't fight our quaternion
    input.moveState.yawLeft   = 0;
    input.moveState.pitchDown = 0;
    input.updateRotationVector();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function applyDeadZone(v) {
    if (Math.abs(v) < DEAD_ZONE) return 0;
    // Re-map [deadZone, 1] → [0, 1] so output starts from 0 at the edge of the dead zone
    return (v - Math.sign(v) * DEAD_ZONE) / (1 - DEAD_ZONE);
  }

  function createElement(tag, cls) {
    var el = document.createElement(tag);
    el.className = cls;
    return el;
  }

  function destroy() {
    container.removeEventListener('touchstart',  onTouchStart, false);
    container.removeEventListener('touchmove',   onTouchMove,  false);
    container.removeEventListener('touchend',    onTouchEnd,   false);
    container.removeEventListener('touchcancel', onTouchEnd,   false);
    if (joystickBase.parentNode) joystickBase.parentNode.removeChild(joystickBase);
  }
}
