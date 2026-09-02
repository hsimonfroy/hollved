var THREE = require('three');

/**
 * The slice: a thin wedge of sky, kept bright while everything outside it is
 * dimmed, so a survey reads as the classic redshift slice plot rather than a
 * solid ball of points.
 *
 * ONE set of uniform OBJECTS, shared by reference across every material that
 * honours the slice — the redshift catalogue, the local-group clouds, the star
 * field, and the constellation and orbit lines. That is the whole design: the
 * renderer sets the plane once and the entire scene follows, with no registry of
 * materials, no per-material plumbing and no way for two layers to disagree
 * about where the slice is. `starField` already shares its uCamHi/uCamLo the same
 * way, for the same reason.
 *
 * Geometry: keep points within SLICE_ANGLE/2 of the plane through uSlicePivot
 * whose normal is uSliceNormal (the camera's forward direction flattened into the
 * orbit plane), so you look at the slice face-on. uSliceCosHalf2 is
 * cos²((π − SLICE_ANGLE)/2), which is the threshold on cos² of the angle from the
 * normal — the complement of a double cone, i.e. an equatorial slab.
 */
// ---------------------------------------------------------------------------
// THE THREE KNOBS. Tune them here and nowhere else: renderer.js used to declare
// its own copies and write them over these at startup, so editing this file did
// nothing and the real values were somewhere you would not think to look.
//
// What they do NOT reach: the LABELS. Those take the slice as eligibility rather
// than as a factor -- shown or not shown -- so uOutSliceAlpha cannot make an
// out-of-slice name faintly visible, and uInSliceAlpha cannot brighten an
// in-slice one. See `inside` at the bottom of this file.
var SLICE_ANGLE     = Math.PI / 20;  // thickness of the wedge, in radians
var IN_SLICE_ALPHA  = 4.0;           // multiplies the alpha of what is inside it
var OUT_SLICE_ALPHA = 0.04;          // ...and of everything outside

// cos^2 of the angle from the plane normal at which the wedge ends. Derived, so
// SLICE_ANGLE stays the thing you edit.
var _cosHalf = Math.cos((Math.PI - SLICE_ANGLE) / 2);

var uniforms = {
  uSliceEnabled:  { value: 0.0 },
  uSliceNormal:   { value: new THREE.Vector3(0, 0, 1) },
  uSlicePivot:    { value: new THREE.Vector3(0, 0, 0) },
  uSliceCosHalf2: { value: _cosHalf * _cosHalf },
  uInSliceAlpha:  { value: IN_SLICE_ALPHA },
  uOutSliceAlpha: { value: OUT_SLICE_ALPHA }
};

// Prepend to any vertex shader that wants sliceAlpha(). Declarations and the test
// travel together so a caller cannot include one without the other.
//
// There is deliberately NO minimum-distance guard. The original carried
// `dLen2 > 0.0001`, i.e. "always inside within 0.01 Mpc of the pivot", which is
// harmless for a catalogue measured in Mpc and completely wrong for a scene that
// also holds a star field 8 kpc across: every star sat inside that radius and the
// slice did nothing to them. The degenerate case needs no guard anyway — at
// rel = 0 the test reads 0.0 > 0.0, which is false, so the pivot itself is inside.
var GLSL = [
  'uniform float uSliceEnabled;',
  'uniform vec3  uSliceNormal;',
  'uniform vec3  uSlicePivot;',
  'uniform float uSliceCosHalf2;',
  'uniform float uInSliceAlpha;',
  'uniform float uOutSliceAlpha;',
  '',
  'float sliceAlpha(vec3 worldPos) {',
  '  if (uSliceEnabled < 0.5) return 1.0;',
  '  vec3  rel    = worldPos - uSlicePivot;',
  '  float dAlong = dot(rel, uSliceNormal);',
  '  return (dAlong * dAlong > uSliceCosHalf2 * dot(rel, rel))',
  '       ? uOutSliceAlpha : uInSliceAlpha;',
  '}'
].join('\n');

/**
 * The same test as sliceAlpha above, on the CPU, for the one layer that cannot
 * call a shader: the labels are troika meshes placed in JS. Kept here, next to the
 * GLSL it mirrors, so the two cannot drift apart.
 *
 * Labels take it as ELIGIBILITY rather than a dimming factor. An out-of-slice name
 * faded to uOutSliceAlpha would still be invisible, but it would go on occupying a
 * declutter box and suppressing the in-slice name behind it — the same trap as a
 * zero group alpha in labelLayer.
 */
function inside(p) {
  if (uniforms.uSliceEnabled.value < 0.5) return true;
  var n = uniforms.uSliceNormal.value, o = uniforms.uSlicePivot.value;
  var x = p.x - o.x, y = p.y - o.y, z = p.z - o.z;
  var d = x * n.x + y * n.y + z * n.z;
  return d * d <= uniforms.uSliceCosHalf2.value * (x * x + y * y + z * z);
}

/** Merge a material's own uniforms with the shared slice ones, by reference. */
function withSlice(own) {
  return Object.assign({}, own, uniforms);
}

module.exports = { uniforms: uniforms, GLSL: GLSL, withSlice: withSlice,
                   inside: inside };
