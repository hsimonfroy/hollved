/**
 * Shared keyboard state for both Spaceship and Satellite modes.
 *
 * Always registered on document (not gated by mode). Both controls read keyState
 * in their update(delta) calls. Also handles global shortcuts (F = mode switch).
 *
 * Uses e.code (physical key position) so the layout is the same on AZERTY,
 * QWERTZ, Dvorak, etc. — keys are bound by position, not by character.
 *
 * Keyboard map:
 *   KeyW/KeyS        forward / back
 *   KeyA/KeyD        left / right (strafe)
 *   Space/ShiftLeft+ShiftRight  up / down
 *   KeyQ/KeyE        rollLeft / rollRight
 *   ArrowUp/Down/Left/Right  pitchUp/pitchDown/yawLeft/yawRight
 *   KeyF             mode switch (spaceship ↔ satellite)
 *   KeyR             reset to origin
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

  // Keyed by e.code — physical position, layout-independent
  var KEY = {
    'KeyW': 'forward',   'KeyS': 'back',
    'KeyA': 'left',      'KeyD': 'right',
    'Space': 'up',       'ShiftLeft': 'down', 'ShiftRight': 'down',
    'KeyQ': 'rollLeft',  'KeyE': 'rollRight',
    'ArrowUp': 'pitchUp',   'ArrowDown': 'pitchDown',
    'ArrowLeft': 'yawLeft', 'ArrowRight': 'yawRight'
  };

  function onKeyDown(e) {
    if (e.code === 'KeyF') { appEvents.toggleControlMode.fire(); e.preventDefault(); return; }
    if (e.code === 'KeyR') { appEvents.resetToOrigin.fire(); e.preventDefault(); return; }
    var k = KEY[e.code];
    if (k) { e.preventDefault(); keyState[k] = 1; markDirty(); }
  }

  function onKeyUp(e) {
    var k = KEY[e.code];
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
