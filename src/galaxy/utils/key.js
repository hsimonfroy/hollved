var CONTROL_KEYS = new Set([
  87, 83, 65, 68,       // W S A D
  32, 16,               // Space Shift
  81, 69,               // Q E
  38, 40, 37, 39,       // ↑ ↓ ← →
  70                    // F
]);

export function isControlKey(e) { return CONTROL_KEYS.has(e.keyCode); }

export default {
  isModifier,
  isControlKey,

  H: 72,
  L: 76,
  Space: 32,
  '/': 191
};

function isModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}
