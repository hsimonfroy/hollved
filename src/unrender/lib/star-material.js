var THREE       = require('three');
var starTexture = require('./particle-texture.js');

/**
 * A point light source drawn at a fixed SCREEN size: star catalogues, and any body
 * whose on-screen size is set directly rather than derived from a world size --
 * which is how the solar overlay draws a planet once it is too far to resolve.
 *
 * It reuses the redshift catalogue's sprite, so one of these looks exactly like a
 * galaxy, but deliberately NOT the catalogue's shader. That shader makes choices
 * which suit millions of world-sized points and actively do not suit this:
 *   - vPointSize from a world size with perspective, where we want screen pixels;
 *   - min(vPointSize, 1.0) sub-pixel flux fading, which would land a planet at
 *     41 AU on alpha 0.007 and erase it, when the whole point is that it stays
 *     artificially visible;
 *   - the slice cone, uViewportHeight and the sub-pixel cull, all dead weight here.
 *
 * MAGNITUDE mode adds real stellar photometry: see createStarMaterial's opts.
 *
 * @param {number} size  plain mode: on-screen diameter in pixels. MAGNITUDE mode:
 *                       the object's true WORLD diameter, in scene units.
 * @param {object} [opts] { magnitude: true } to switch on the photometric path,
 *                        with `fluxScale` its single brightness constant,
 *                        `magLimit` the faintest magnitude worth a fragment, and
 *                        `minPx` the size floor.
 */
module.exports = createStarMaterial;

// Apparent brightness straight from the inverse-square law, with the magnitude
// definition folded out so no logarithm survives into the shader:
//
//   m = M + 5*log10(d) - 5   =>   flux ~ 10^(-0.4*M) * 100 / d^2
//
// and the 100 disappears into uFluxScale. Stars are point sources, so their
// SIZE is fixed -- scaling a dot by magnitude is a workaround for 8-bit range
// limits, and this material renders into the HDR buffer where the tone mapper
// covers 20 magnitudes. uFluxScale sets which magnitude lands at the visible
// threshold; nothing else about brightness is authored.
var VERT = [
  'attribute vec4 customColor;',   // `color` would collide with three's own
  'uniform   float uSize;',
  'varying   vec4  vColor;',
  '#ifdef MAGNITUDE',
  'attribute float aAbsMag;',
  'uniform   float uUnitsToPc2;',  // (pc per world unit)^2
  'uniform   float uFluxScale;',
  'uniform   float uMinFlux;',
  'uniform   float uMinPx;',
  'uniform   float uViewportHeight;',
  'uniform   vec3  uCamHi;',       // camera in THIS object's units, float32-rounded
  'uniform   vec3  uCamLo;',       // and the remainder it could not hold
  '#endif',
  'void main() {',
  // Relative-to-eye, with the camera split in two. Fly up to a star and the naive
  // transform freezes: at 1.347 pc (alpha Cen) a float32 holds 0.025 AU, so both
  // `modelViewMatrix * position` AND a single float32 camera uniform quantise the
  // result to that -- the star sits still for 2500 steps of 1e-5 AU and then
  // jumps. Splitting the camera fixes it: `position - uCamHi` is EXACT (Sterbenz:
  // two float32 within a factor of two subtract exactly), and uCamLo carries the
  // rest, which is small enough to be exact too. Measured: 0/199 frozen steps
  // against 199/199 for either single-precision form.
  //
  // Anything else drawn among these stars needs the same treatment and the same
  // uCamHi/uCamLo: radarStyle's createRteLineMaterial is this transform for the
  // constellation figures, sharing these very uniform objects.
  '#ifdef MAGNITUDE',
  '  vec4 mv = vec4(mat3(modelViewMatrix) * ((position - uCamHi) - uCamLo), 1.0);',
  '#else',
  '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
  '#endif',
  '  if (mv.z > 0.0) {                       // behind the camera',
  '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); gl_PointSize = 0.0; return;',
  '  }',
  '#ifdef MAGNITUDE',
  '  float d2 = dot(mv.xyz, mv.xyz) * uUnitsToPc2;',
  '  vColor = vec4(customColor.rgb,',
  '                uFluxScale * pow(10.0, -0.4 * aAbsMag) / max(d2, 1e-12));',
  '#else',
  '  vColor = customColor;',
  '#endif',
  // The cull threshold is not shared: in MAGNITUDE mode vColor.a is an unbounded
  // FLUX, not an opacity, and 0.004 there would mean "brighter than magnitude 2"
  // -- about fifty stars in the whole sky.
  '#ifdef MAGNITUDE',
  '  if (vColor.a < uMinFlux) {',
  '#else',
  '  if (vColor.a < 0.004) {                 // faded out',
  '#endif',
  '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); gl_PointSize = 0.0; return;',
  '  }',
  // Size comes from the WORLD size with a floor, the same law the redshift
  // catalogue uses -- not from the magnitude. A star is a point source, so at any
  // real distance this is the floor (1 R_sun is 1.3e-5 px at 1 pc); it only
  // exceeds it within a few AU, where a star resolves into a disc as a planet
  // does. Unlike the catalogue there is NO paired alpha fade: the flux above is
  // already the real one, and dimming it again would double-count.
  '#ifdef MAGNITUDE',
  '  gl_PointSize = max(uSize * projectionMatrix[1][1] * uViewportHeight * 0.5',
  '                     / length(mv.xyz), uMinPx);',
  '#else',
  '  gl_PointSize = uSize;',
  '#endif',
  '  gl_Position  = projectionMatrix * mv;',
  '}'
].join('\n');

// Alpha channel only, as the catalogue does. The sprite's alpha is a flat disc
// with a soft rim; its RGB is a linear ramp, and multiplying that in -- which is
// what stock PointsMaterial does -- turns the dot into a glow.
//
// MAGNITUDE premultiplies instead, because its alpha is an unbounded flux rather
// than an opacity: see the blend note below.
var FRAG = [
  'uniform sampler2D tStar;',
  'varying vec4 vColor;',
  '#ifdef MAGNITUDE',
  'uniform float uMinFlux;',
  '#endif',
  'void main() {',
  '  float a = texture2D(tStar, gl_PointCoord).a * vColor.a;',
  '#ifdef MAGNITUDE',
  '  if (a < uMinFlux) discard;',
  '  gl_FragColor = vec4(vColor.rgb * a, 1.0);',
  '#else',
  '  if (a < 0.01) discard;',
  '  gl_FragColor = vec4(vColor.rgb, a);',
  '#endif',
  '}'
].join('\n');

function createStarMaterial(size, opts) {
  opts = opts || {};
  var magnitude = !!opts.magnitude;

  var map = new THREE.TextureLoader().load(starTexture);
  // Only .a is sampled, so colour space is irrelevant. Mips are not: at a few
  // pixels across, a mip level averages the sprite's alpha plateau away.
  map.generateMipmaps = false;
  map.minFilter       = THREE.LinearFilter;

  var uniforms = {
    tStar: { value: map },
    uSize: { value: size }
  };
  if (magnitude) {
    uniforms.uUnitsToPc2 = { value: opts.unitsToPc2 };
    uniforms.uFluxScale  = { value: opts.fluxScale };
    // Cull in the unit the caller thinks in. flux = fluxScale * 10^(-0.4*m) / 100
    // follows from folding the distance modulus, so a magnitude limit converts
    // straight across and stays right if fluxScale is retuned.
    uniforms.uMinFlux = {
      value: opts.fluxScale * Math.pow(10, -0.4 * opts.magLimit) / 100
    };
    uniforms.uMinPx          = { value: opts.minPx };
    uniforms.uViewportHeight = { value: 600 };   // owner updates it on resize
    uniforms.uCamHi          = { value: new THREE.Vector3() };
    uniforms.uCamLo          = { value: new THREE.Vector3() };
  }

  var params = {
    uniforms:       uniforms,
    defines:        magnitude ? { MAGNITUDE: '' } : {},
    vertexShader:   VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthTest:   false,  // else a sub-pixel body mesh punches a hole in its own point
    depthWrite:  false
  };

  if (magnitude) {
    // Plain ONE/ONE, not AdditiveBlending. Additive resolves to
    // blendFunc(SRC_ALPHA, ONE) and GL clamps a blend FACTOR to [0,1], which
    // would cap every star at magnitude 0 and flatten the whole sky. The
    // fragment shader premultiplies so the flux rides in the colour instead,
    // unbounded, which is the point of rendering into a float target.
    params.blending      = THREE.CustomBlending;
    params.blendSrc      = THREE.OneFactor;
    params.blendDst      = THREE.OneFactor;
    params.blendEquation = THREE.AddEquation;
  } else {
    // Non-premultiplied against premultipliedAlpha:false, so AdditiveBlending
    // resolves to blendFunc(SRC_ALPHA, ONE) and the contribution is rgb * a.
    // This is the catalogue's pairing; detailedGxyRenderer deliberately
    // premultiplies for rgb * a^2, which steepens its rim falloff.
    params.blending = THREE.AdditiveBlending;
  }

  return new THREE.ShaderMaterial(params);
}
