export default createMobileControl;

var JOYSTICK_RADIUS = 60;   // px — half of 120px base diameter
var DEAD_ZONE       = 0.15; // fraction of joystick radius, no input below this

function createMobileControl(renderer, turntableControl, spaceshipControl) {
  var container = renderer.getContainer();

  // ── DOM — left joystick (spaceship movement) ─────────────────────────────
  var joystickBase = createElement('div', 'joystick-base');
  var joystickKnob = createElement('div', 'joystick-knob');
  joystickBase.appendChild(joystickKnob);
  document.body.appendChild(joystickBase);

  // ── DOM — right joystick (spaceship look) ────────────────────────────────
  var joystickRightBase = createElement('div', 'joystick-right-base');
  var joystickRightKnob = createElement('div', 'joystick-right-knob');
  joystickRightBase.appendChild(joystickRightKnob);
  document.body.appendChild(joystickRightBase);

  // Start in turntable mode — joysticks hidden
  var mode = 'turntable';
  joystickBase.style.display      = 'none';
  joystickRightBase.style.display = 'none';

  // ── Touch state ───────────────────────────────────────────────────────────

  // Spaceship touch tracking
  var joystickTouchId      = null;
  var joystickRightTouchId = null;
  var joystickOrigin       = null;
  var joystickRightOrigin  = null;

  // Turntable touch tracking (up to 3 simultaneous fingers)
  var turntableTouches = {}; // { identifier: { x, y } }

  // { passive: false } is required to call e.preventDefault() in modern browsers
  container.addEventListener('touchstart',  onTouchStart, { passive: false });
  container.addEventListener('touchmove',   onTouchMove,  { passive: false });
  container.addEventListener('touchend',    onTouchEnd,   false);
  container.addEventListener('touchcancel', onTouchEnd,   false);

  return { setMode: setMode, destroy: destroy };

  // ── Mode switching ────────────────────────────────────────────────────────

  function setMode(m) {
    mode = m;
    var showJoysticks = (m === 'spaceship');
    joystickBase.style.display      = showJoysticks ? '' : 'none';
    joystickRightBase.style.display = showJoysticks ? '' : 'none';
    resetAll();
  }

  function resetAll() {
    // Clear spaceship state
    joystickTouchId      = null;
    joystickRightTouchId = null;
    joystickOrigin       = null;
    joystickRightOrigin  = null;
    joystickKnob.style.transform      = 'translate(0px,0px)';
    joystickRightKnob.style.transform = 'translate(0px,0px)';
    var ms = spaceshipControl.mobileState;
    ms.forward = ms.back = ms.left = ms.right = ms.yawLeft = ms.pitchDown = 0;
    // Clear turntable state
    turntableTouches = {};
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  function onTouchStart(e) {
    e.preventDefault();
    if (mode === 'spaceship') {
      onSpaceshipTouchStart(e);
    } else {
      onTurntableTouchStart(e);
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (mode === 'spaceship') {
      onSpaceshipTouchMove(e);
    } else {
      onTurntableTouchMove(e);
    }
  }

  function onTouchEnd(e) {
    if (mode === 'spaceship') {
      onSpaceshipTouchEnd(e);
    } else {
      onTurntableTouchEnd(e);
    }
  }

  // ── Spaceship touch ───────────────────────────────────────────────────────

  function onSpaceshipTouchStart(e) {
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if (joystickTouchId === null && isOverJoystick(t, joystickBase)) {
        joystickTouchId = t.identifier;
        joystickOrigin  = joystickCenter(joystickBase);
        updateLeftJoystick(t);
      } else if (joystickRightTouchId === null && isOverJoystick(t, joystickRightBase)) {
        joystickRightTouchId = t.identifier;
        joystickRightOrigin  = joystickCenter(joystickRightBase);
        updateRightJoystick(t);
      }
      // Touches outside both joysticks are ignored in spaceship mode
    }
  }

  function onSpaceshipTouchMove(e) {
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if      (t.identifier === joystickTouchId)      updateLeftJoystick(t);
      else if (t.identifier === joystickRightTouchId) updateRightJoystick(t);
    }
  }

  function onSpaceshipTouchEnd(e) {
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if (t.identifier === joystickTouchId) {
        joystickTouchId = null;
        joystickOrigin  = null;
        joystickKnob.style.transform = 'translate(0px,0px)';
        var ms = spaceshipControl.mobileState;
        ms.forward = ms.back = ms.left = ms.right = 0;
      }
      if (t.identifier === joystickRightTouchId) {
        joystickRightTouchId = null;
        joystickRightOrigin  = null;
        joystickRightKnob.style.transform = 'translate(0px,0px)';
        spaceshipControl.mobileState.yawLeft   = 0;
        spaceshipControl.mobileState.pitchDown = 0;
      }
    }
  }

  // ── Left joystick (movement) ──────────────────────────────────────────────

  function updateLeftJoystick(touch) {
    var dx = touch.clientX - joystickOrigin.x;
    var dy = touch.clientY - joystickOrigin.y;
    var d  = Math.sqrt(dx * dx + dy * dy);

    if (d > JOYSTICK_RADIUS) {
      dx = dx / d * JOYSTICK_RADIUS;
      dy = dy / d * JOYSTICK_RADIUS;
    }

    joystickKnob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';

    var nx = applyDeadZone(dx / JOYSTICK_RADIUS);
    var ny = applyDeadZone(dy / JOYSTICK_RADIUS);

    // Y up (ny < 0) = forward, Y down (ny > 0) = back
    var ms = spaceshipControl.mobileState;
    ms.forward = Math.max(0, -ny);
    ms.back    = Math.max(0,  ny);
    ms.right   = Math.max(0,  nx);
    ms.left    = Math.max(0, -nx);
    renderer.markDirty();
  }

  // ── Right joystick (look: pitch / yaw) ───────────────────────────────────

  function updateRightJoystick(touch) {
    var dx = touch.clientX - joystickRightOrigin.x;
    var dy = touch.clientY - joystickRightOrigin.y;
    var d  = Math.sqrt(dx * dx + dy * dy);

    if (d > JOYSTICK_RADIUS) {
      dx = dx / d * JOYSTICK_RADIUS;
      dy = dy / d * JOYSTICK_RADIUS;
    }

    joystickRightKnob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';

    var nx = applyDeadZone(dx / JOYSTICK_RADIUS);
    var ny = applyDeadZone(dy / JOYSTICK_RADIUS);

    // nx > 0 = look right (yawLeft negative), ny > 0 = look down (pitchDown positive)
    spaceshipControl.mobileState.yawLeft   = -nx;
    spaceshipControl.mobileState.pitchDown =  ny;
    renderer.markDirty();
  }

  // ── Turntable touch ───────────────────────────────────────────────────────
  //
  // 1 finger  → orbit (rotate theta/phi)
  // 2 fingers → pinch-to-zoom (scale radius)
  // 3 fingers → pan pivot

  function onTurntableTouchStart(e) {
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      turntableTouches[t.identifier] = { x: t.clientX, y: t.clientY };
    }
  }

  function onTurntableTouchMove(e) {
    var n = Object.keys(turntableTouches).length;

    // Snapshot previous positions before updating
    var prev = {};
    var ids  = Object.keys(turntableTouches);
    ids.forEach(function(id) {
      prev[id] = { x: turntableTouches[id].x, y: turntableTouches[id].y };
    });

    // Update current positions
    for (var i = 0; i < e.changedTouches.length; ++i) {
      var t = e.changedTouches[i];
      if (turntableTouches[t.identifier]) {
        turntableTouches[t.identifier] = { x: t.clientX, y: t.clientY };
      }
    }

    if (n === 1) {
      // Single finger: orbit
      var id0 = ids[0];
      if (prev[id0] && turntableTouches[id0]) {
        var dx = turntableTouches[id0].x - prev[id0].x;
        var dy = turntableTouches[id0].y - prev[id0].y;
        turntableControl.onTouchRotate(dx, dy);
      }
    } else if (n === 2) {
      // Two fingers: pinch zoom + centroid pan simultaneously
      var id1 = ids[0], id2 = ids[1];
      if (prev[id1] && prev[id2] && turntableTouches[id1] && turntableTouches[id2]) {
        // Zoom: distance ratio
        var prevDist = dist(prev[id1], prev[id2]);
        var currDist = dist(turntableTouches[id1], turntableTouches[id2]);
        if (prevDist > 0) {
          turntableControl.onTouchZoom(currDist / prevDist);
        }
        // Pan: centroid delta
        var prevCx = (prev[id1].x + prev[id2].x) / 2;
        var prevCy = (prev[id1].y + prev[id2].y) / 2;
        var currCx = (turntableTouches[id1].x + turntableTouches[id2].x) / 2;
        var currCy = (turntableTouches[id1].y + turntableTouches[id2].y) / 2;
        turntableControl.onTouchPan(currCx - prevCx, currCy - prevCy);
      }
    }
  }

  function onTurntableTouchEnd(e) {
    for (var i = 0; i < e.changedTouches.length; ++i) {
      delete turntableTouches[e.changedTouches[i].identifier];
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function isOverJoystick(touch, base) {
    var c  = joystickCenter(base);
    var dx = touch.clientX - c.x;
    var dy = touch.clientY - c.y;
    var r = JOYSTICK_RADIUS + 20; // +20px tolerance
    return (dx * dx + dy * dy) <= r * r;
  }

  function joystickCenter(base) {
    var rect = base.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function applyDeadZone(v) {
    if (Math.abs(v) < DEAD_ZONE) return 0;
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
    if (joystickBase.parentNode)      joystickBase.parentNode.removeChild(joystickBase);
    if (joystickRightBase.parentNode) joystickRightBase.parentNode.removeChild(joystickRightBase);
  }
}
