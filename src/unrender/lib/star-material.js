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
 * @param {number} sizePx on-screen diameter, in pixels.
 */
module.exports = createStarMaterial;

function createStarMaterial(sizePx) {
  var map = new THREE.TextureLoader().load(starTexture);
  // Only .a is sampled, so colour space is irrelevant. Mips are not: at a few
  // pixels across, a mip level averages the sprite's alpha plateau away -- measured
  // at 15/255 where the centre should give ~137.
  map.generateMipmaps = false;
  map.minFilter       = THREE.LinearFilter;

  return new THREE.ShaderMaterial({
    uniforms: {
      tStar: { value: map },
      uSize: { value: sizePx }
    },
    vertexShader: [
      'attribute vec4 customColor;',   // `color` would collide with three's own
      'uniform   float uSize;',
      'varying   vec4  vColor;',
      'void main() {',
      '  vColor = customColor;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  if (vColor.a < 0.004 || mv.z > 0.0) {   // faded out, or behind the camera',
      '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); gl_PointSize = 0.0; return;',
      '  }',
      '  gl_PointSize = uSize;',
      '  gl_Position  = projectionMatrix * mv;',
      '}'
    ].join('\n'),
    // Alpha channel only, as the catalogue does. The sprite's alpha is a flat disc
    // with a soft rim; its RGB is a linear ramp, and multiplying that in -- which
    // is what stock PointsMaterial does -- turns the dot into a glow.
    fragmentShader: [
      'uniform sampler2D tStar;',
      'varying vec4 vColor;',
      'void main() {',
      '  float a = texture2D(tStar, gl_PointCoord).a * vColor.a;',
      '  if (a < 0.01) discard;',
      '  gl_FragColor = vec4(vColor.rgb, a);',
      '}'
    ].join('\n'),
    // Non-premultiplied output against premultipliedAlpha:false, so AdditiveBlending
    // resolves to blendFunc(SRC_ALPHA, ONE) and the contribution is rgb * a. This is
    // the catalogue's pairing; detailedGxyRenderer deliberately premultiplies for
    // rgb * a^2, which steepens its rim falloff, and is not what we want here.
    blending:    THREE.AdditiveBlending,
    transparent: true,
    depthTest:   false,  // else a sub-pixel body mesh punches a hole in its own point
    depthWrite:  false
  });
}
