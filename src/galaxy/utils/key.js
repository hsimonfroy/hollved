var CONTROL_CODES = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'Space', 'ShiftLeft', 'ShiftRight',
  'KeyQ', 'KeyE',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyF', 'KeyR', 'KeyI'
]);

export function isControlKey(e) { return CONTROL_CODES.has(e.code); }

export default {
  isModifier,
  isControlKey,

  H: 72,
  I: 73,
  L: 76,
  Space: 32,
  '/': 191
};

function isModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}
