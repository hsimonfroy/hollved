/**
 * Shared visual style for the additive overlays: radar instruments, and the
 * heliosphere shell.
 *
 * Callers, same look, different geometry and scale regimes:
 *   renderer.js      — cosmological ruler rings. Circular, and their radii (Mpc)
 *                      are comparable to the camera distances used to view them,
 *                      so a world-space tube works. Drawn into the HDR buffer
 *                      *before* tone-mapping, hence intensity 2.0.
 *   solarRenderer.js — solar orbit paths. Elliptical, and viewed across five
 *                      orders of magnitude of camera distance (Earth's surface
 *                      to ~200 AU), so the tube radius must be screen-space or
 *                      it either aliases when far or swallows the camera when
 *                      near. Drawn *after* tone-mapping onto LDR pixels.
 *   heliosphere.js   — the heliopause shell, via createShellMaterial. Same
 *                      vertex shader and blend state; only the view-dependent
 *                      alpha differs, a slab law rather than a tube's.
 *
 * The blend state and the vertex shader are shared verbatim.
 */
import * as THREE from 'three';
import { Text } from 'troika-three-text';

// facing = |dot(N, V)| → 0 at the silhouette, 1 where the tube faces the camera.
// pow(2) gives a Gaussian-like radial falloff that reaches 0 at the silhouette,
// so a tube thinner than a pixel fades out instead of aliasing.
var GLOW_FRAG = [
  'uniform float uIntensity;',
  'uniform float uAlpha;',
  'varying vec3 vViewPosition;',
  'varying vec3 vViewNormal;',
  'void main() {',
  '  vec3  viewDir = normalize(-vViewPosition);',
  '  float facing  = abs(dot(vViewNormal, viewDir));',
  '  float alpha   = pow(facing, 2.0) * uAlpha;',
  '  gl_FragColor  = vec4(vec3(uIntensity), min(alpha, 1.0));',
  '}'
].join('\n');

// A shell is the same statement -- brightness follows the path length through the
// emitting material -- applied to the opposite geometry. Across a tube you look
// along the facing direction; through a thin shell of thickness t you look along
// 1/|N.V|, which is t head-on and diverges at the silhouette. The cap stands in
// for the finite thickness that stops the real divergence. Note this is a slab
// law, NOT GLOW_FRAG's inverted: a falloff that reaches zero at normal incidence
// leaves the shell visible only as a rim.
//
// vUv.y carries a per-vertex emission weight the CALLER bakes into the geometry,
// not a raw coordinate: the heliopause writes an exponential decay in AU down the
// tail there. Keeping the law on the CPU means it is expressed in the units it is
// argued about, needs no uniform, and can be retuned without touching a shader.
//
// The discard matters here specifically. A faded tail still rasterises, and this
// surface is fullscreen-sized; skipping the blend and the framebuffer write on
// fragments that would add nothing is most of the tail's cost.
var SHELL_FRAG = [
  'uniform vec3  uColor;',
  'uniform float uAlpha;',
  'uniform float uLimbCap;',
  'varying vec3 vViewPosition;',
  'varying vec3 vViewNormal;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3  viewDir = normalize(-vViewPosition);',
  '  float facing  = abs(dot(normalize(vViewNormal), viewDir));',
  '  float slab    = min(1.0 / max(facing, 1e-3), uLimbCap);',
  '  float a       = uAlpha * slab * vUv.y;',
  '  if (a < 0.002) discard;',
  '  gl_FragColor  = vec4(uColor, min(a, 1.0));',
  '}'
].join('\n');

// Both materials need the view-space position and normal, and nothing else. vUv
// costs one varying and is unused by GLOW_FRAG; a second near-identical vertex
// shader to save it would be the more expensive kind of duplication.
var GLOW_VERT = [
  'varying vec3 vViewPosition;',
  'varying vec3 vViewNormal;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec4 mvPos    = modelViewMatrix * vec4(position, 1.0);',
  '  vViewPosition = mvPos.xyz;',
  '  vViewNormal   = normalize(normalMatrix * normal);',
  '  vUv           = uv;',
  '  gl_Position   = projectionMatrix * mvPos;',
  '}'
].join('\n');

var GLOW_COMMON = {
  blending:    THREE.AdditiveBlending,
  transparent: true,
  depthTest:   false,
  depthWrite:  false,
  side:        THREE.DoubleSide
};

/**
 * World-space glow material: the tube thickness comes from the geometry.
 * @param {number} intensity RGB level. 2.0 pre-tone-map (HDR), ~1.0 post (LDR).
 * @param {number} alpha     peak alpha at full facing.
 */
export function createGlowMaterial(intensity, alpha) {
  return new THREE.ShaderMaterial(Object.assign({
    uniforms: {
      uIntensity: { value: intensity },
      uAlpha:     { value: alpha }
    },
    vertexShader:   GLOW_VERT,
    fragmentShader: GLOW_FRAG
  }, GLOW_COMMON));
}

/**
 * Optically thin shell: a faint veil head-on, brightening toward the silhouette
 * as the line of sight lengthens through it, and dimming along vUv.y.
 *
 * Additive, so it can only ever brighten what is behind it — a shell drawn this
 * way never occludes the Sun, and needs no sorting despite being DoubleSide.
 *
 * @param {THREE.Vector3} color     RGB, post-tone-map LDR levels.
 * @param {number}        alpha     alpha at NORMAL incidence. Set per frame.
 * @param {number}        limbCap   how much brighter the limb may get, at most.
 *
 * The caller must bake a per-vertex emission weight into the geometry's uv.y.
 */
export function createShellMaterial(color, alpha, limbCap) {
  return new THREE.ShaderMaterial(Object.assign({
    uniforms: {
      uColor:   { value: color },
      uAlpha:   { value: alpha },
      uLimbCap: { value: limbCap }
    },
    vertexShader:   GLOW_VERT,
    fragmentShader: SHELL_FRAG
  }, GLOW_COMMON));
}

// -----------------------------------------------------------------------------
// Three line variants, one look. All three are GL lines rather than tubes: the
// callers view them across five to twenty-five orders of magnitude of camera
// distance, so any fixed world thickness either aliases at the far end or
// engulfs the camera at the near end. A line is 1px at every distance and --
// unlike a screen-space-expanded tube -- the GPU clips it correctly where the
// path crosses the near plane, which solar orbits do constantly: Earth sits *on*
// Earth's orbit, which is the scene origin.
//
//   createLineMaterial      the base: one colour, no depth test, drawn on top.
//   createOrbitLineMaterial + the trail fade and depth testing.
//   createRteLineMaterial   + the star field's relative-to-eye transform.
//
// The two flags the orbit variant adds are worth separating rather than
// switching off afterwards, because each silently destroys the other caller:
// `vertexColors` with no `color` attribute reads black, so an additive line
// vanishes; and `depthTest` samples a buffer the solar overlay just filled from
// a DIFFERENT camera's clip space, which erases the line outright.
//
// All three override GLOW_COMMON's `side`, which is there for the MESHES. A mesh
// wants DoubleSide -- a closed shell has to show both its walls -- and three
// delivers that by rendering a `transparent && DoubleSide` object TWICE, back
// faces then front faces (WebGLRenderer, `forceSinglePass`). Culling never
// applies to a line, so both passes draw the same pixels and additive blending
// lands on exactly 2x the authored alpha: measured 6.0005e-3 for an authored
// 3e-3, against 3.0003e-3 with FrontSide. Every line in the scene was being
// drawn twice for a doubled opacity nobody asked for; LINE_ALPHA and
// ORBIT_MAX_ALPHA were doubled when this was fixed, so the look did not change.

/**
 * @param {number} opacity
 * @param {number} [color] 0xrrggbb, default white.
 */
export function createLineMaterial(opacity, color) {
  return new THREE.LineBasicMaterial(Object.assign({}, GLOW_COMMON, {
    color:   color === undefined ? 0xffffff : color,
    opacity: opacity,
    side:    THREE.FrontSide   // one pass; see the note above
  }));
}

/**
 * Orbit path for the solar overlay.
 *
 * Unlike the ruler rings this depth-tests, so the planets occlude the parts of
 * an orbit that pass behind them. The Sun deliberately writes no depth (its
 * glow sprite has to draw over its own surface), so orbits still show through
 * the Sun's disc — barely a pixel or two at the zooms where it is visible.
 *
 * `vertexColors` carries the trail fade. three.js defines USE_COLOR_ALPHA — and
 * so does `diffuseColor *= vColor` with the alpha included — only when the
 * geometry's `color` attribute has **itemSize 4**; with 3 components it applies
 * `diffuseColor.rgb *= vColor` and the fade is silently dropped. Final alpha is
 * `opacity * vColor.a`, interpolated along each segment.
 *
 * @param {number} opacity peak alpha, at the body end of the trail.
 * @param {number} [color]  0xrrggbb, default white.
 */
export function createOrbitLineMaterial(opacity, color) {
  var mat = createLineMaterial(opacity, color);
  mat.vertexColors = true;   // the trail fade, per the note above
  mat.depthTest    = true;   // so a planet occludes the far side of its orbit
  return mat;
}

// Relative-to-eye, the star field's transform verbatim -- star-material.js
// carries the argument in full. Short version: `modelViewMatrix * position`
// cancels catastrophically once the camera closes on a vertex whose coordinates
// are large, and the constellation figures join stars whose coordinates are
// parsecs. What matters is the NEAR endpoint's distance to the camera, not the
// segment's length: measured at 1 AU from alpha Cen the endpoint freezes for
// 130 steps out of 199 and then jumps 7.5 px, which is the flicker. Under this
// transform every step is the ideal one and none are frozen.
//
// mat3() drops the translation on purpose: (position - camera) already carries
// it, and the 3x3 still holds the object's pc -> Mpc scale.
var RTE_LINE_VERT = [
  'uniform vec3 uCamHi;',   // camera in the object's own units, float32-rounded
  'uniform vec3 uCamLo;',   // and the remainder it could not hold
  '#ifdef VERTEX_ALPHA',
  'attribute float aAlpha;',
  'varying   float vAlpha;',
  '#endif',
  'void main() {',
  '#ifdef VERTEX_ALPHA',
  '  vAlpha = aAlpha;',
  '#endif',
  '  vec3 rel = (position - uCamHi) - uCamLo;',
  '  gl_Position = projectionMatrix * vec4(mat3(modelViewMatrix) * rel, 1.0);',
  '}'
].join('\n');

// Additive resolves to blendFunc(SRC_ALPHA, ONE), so the contribution is
// uColor * uOpacity -- identical to what LineBasicMaterial produces.
//
// VERTEX_ALPHA is a trail fade, the same ramp the solar orbits carry in a
// vertexColors attribute. It is a define rather than an always-on attribute
// because GLSL cannot default one: a shader that reads `aAlpha` gets zero, not
// one, from geometry that does not supply it -- and an additive line at alpha
// zero is simply absent. Same reason star-material.js gates MAGNITUDE.
var RTE_LINE_FRAG = [
  'uniform vec3  uColor;',
  'uniform float uOpacity;',
  '#ifdef VERTEX_ALPHA',
  'varying float vAlpha;',
  '#endif',
  'void main() {',
  '#ifdef VERTEX_ALPHA',
  '  gl_FragColor = vec4(uColor, uOpacity * vAlpha);',
  '#else',
  '  gl_FragColor = vec4(uColor, uOpacity);',
  '#endif',
  '}'
].join('\n');

/**
 * The base line, drawn through the star field's split-camera transform.
 *
 * @param {number} opacity  read and written as `mat.uniforms.uOpacity.value`.
 * @param {number} [color]  0xrrggbb, default white.
 * @param {object} camHi    the star material's OWN uCamHi uniform object, and
 * @param {object} camLo    its uCamLo — passed by reference, so whatever syncs
 *                          the star field's camera feeds this material too and
 *                          there is only ever one sync path.
 * @param {boolean} [vertexAlpha] read a per-vertex `aAlpha` attribute and
 *                          multiply it into the opacity — a trail fade. The
 *                          geometry MUST then supply the attribute.
 */
export function createRteLineMaterial(opacity, color, camHi, camLo, vertexAlpha) {
  return new THREE.ShaderMaterial(Object.assign({}, GLOW_COMMON, {
    uniforms: {
      uColor:   { value: new THREE.Color(color === undefined ? 0xffffff : color) },
      uOpacity: { value: opacity },
      uCamHi:   camHi,
      uCamLo:   camLo
    },
    defines:        vertexAlpha ? { VERTEX_ALPHA: '' } : {},
    vertexShader:   RTE_LINE_VERT,
    fragmentShader: RTE_LINE_FRAG,
    side:           THREE.FrontSide   // one pass; see the note above
  }));
}

// Two label voices, because the scene names two different kinds of thing.
//
// NAME is a thing at a place -- a planet, a star, a galaxy. It is crisp, and its
// hard black outline is what keeps it readable over a bright cloud.
//
// REGION is a constellation: not an object at all, but a direction, a patch of
// sky, and an Earth-bound convention on top of stars that are nowhere near each
// other. It gets the star-atlas treatment instead -- light weight, wide tracking,
// upper case, and a soft halo rather than an outline -- so it reads as a label
// ON the sky rather than a label OF something. The two also declutter in separate
// groups (see labelLayer), which only makes sense because they look different
// enough to overlap without confusion.
//
// troika 0.52 resolves fontWeight/fontStyle through its own font CDN, so a second
// voice costs no shipped asset.
export var LABEL_STYLE_NAME = {
  color:          '#ffffff',
  fillOpacity:    0.9,
  fontWeight:     400,
  letterSpacing:  0,
  outlineWidth:   '10%',
  outlineColor:   '#000000',
  outlineOpacity: 0.9,
  outlineBlur:    0
};

export var LABEL_STYLE_REGION = {
  color:          '#dce6f5',   // faintly cool, so it sits behind white names
  fillOpacity:    0.6,
  fontWeight:     300,
  letterSpacing:  0.30,
  outlineWidth:   0,
  outlineColor:   '#000c6a',
  outlineOpacity: 0.6,
  outlineBlur:    '25%'        // a halo, not an edge
};

/**
 * SDF text, always drawn on top, in one of the two voices above.
 * @param {string}   text
 * @param {number}   fontSize in world units of the caller's scene
 * @param {function} onSync   called when troika finishes building the glyph
 *                            geometry (wake the RAF loop so it appears at once)
 * @param {object}   [style]  one of LABEL_STYLE_*; defaults to NAME.
 */
export function makeRadarLabel(text, fontSize, onSync, style) {
  var label = new Text();
  Object.assign(label, style || LABEL_STYLE_NAME);
  label.text        = text;
  label.fontSize    = fontSize;
  label.anchorX     = 'center';
  label.anchorY     = 'middle';
  label.depthTest   = false;
  label.renderOrder = 999;
  label.sync(onSync);
  return label;
}
