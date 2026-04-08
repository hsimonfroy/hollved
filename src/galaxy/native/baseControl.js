/**
 * Shared keyboard state for both Spaceship and Satellite modes.
 *
 * Always registered on document (not gated by mode). Both controls read keyState
 * in their update(delta) calls. Also handles global shortcuts (F = mode switch).
 *
 * Keyboard map:
 *   W/S        forward / back
 *   A/D        left / right (strafe)
 *   Space/Shift up / down
 *   Q/E        rollLeft / rollRight
 *   ↑↓←→       pitchUp/pitchDown/yawLeft/yawRight  (same as mouse in each mode)
 *   F          mode switch (spaceship ↔ satellite)
 *   R          reset to origin
 */
export default createBaseControl;

import appEvents from '../service/appEvents.js';

function createBaseControl(markDirty) {
  var keyState = {
    forward: 0, back: 0,
    left: 0,    right: 0,
    up: 0,      down: 0,
    rollLeft: 0, rollRight: 0,
    pitchUp: 0,  pitchDown: 0,
    yawLeft: 0,  yawRight: 0
  };

  var KEY = {
    87: 'forward',   83: 'back', // W (87) and S (83)
    65: 'left',      68: 'right', // A (65) and D (68)
     32: 'up',        16: 'down',  // Space (32) and Shift (16)
     81: 'rollLeft',  69: 'rollRight', // Q (81) and E (69)
     38: 'pitchUp',   40: 'pitchDown', // Up (38) and Down (40)
     37: 'yawLeft',   39: 'yawRight' // Left (37) and Right (39)
  };

  function onKeyDown(e) {
    // F (70) to switch control modes
    if (e.keyCode === 70) { appEvents.toggleControlMode.fire(); e.preventDefault(); return; }
    // R (82) to reset to origin
    if (e.keyCode === 82) { appEvents.resetToOrigin.fire(); e.preventDefault(); return; }
    var k = KEY[e.keyCode];
    if (k) { e.preventDefault(); keyState[k] = 1; markDirty(); }
  }

  function onKeyUp(e) {
    var k = KEY[e.keyCode];
    if (k) keyState[k] = 0;
  }

  document.addEventListener('keydown', onKeyDown, false);
  document.addEventListener('keyup',   onKeyUp,   false);

  return {
    keyState: keyState,

    /** Returns true while any key tracked here is held down. */
    isActive: function() {
      for (var k in keyState) { if (keyState[k]) return true; }
      return false;
    },

    destroy: function() {
      document.removeEventListener('keydown', onKeyDown, false);
      document.removeEventListener('keyup',   onKeyUp,   false);
    }
  };
}
