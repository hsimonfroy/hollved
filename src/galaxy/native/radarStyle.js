/**
 * Shared visual style for radar overlays.
 *
 * Two callers, same look, different geometry and scale regimes:
 *   renderer.js      — cosmological ruler rings. Circular, and their radii (Mpc)
 *                      are comparable to the camera distances used to view them,
 *                      so a world-space tube works. Drawn into the HDR buffer
 *                      *before* tone-mapping, hence intensity 2.0.
 *   solarRenderer.js — solar orbit paths. Elliptical, and viewed across five
 *                      orders of magnitude of camera distance (Earth's surface
 *                      to ~200 AU), so the tube radius must be screen-space or
 *                      it either aliases when far or swallows the camera when
 *                      near. Drawn *after* tone-mapping onto LDR pixels.
 *
 * The fragment shader — the actual "radar" look — is shared verbatim.
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
    vertexShader: [
      'varying vec3 vViewPosition;',
      'varying vec3 vViewNormal;',
      'void main() {',
      '  vec4 mvPos    = modelViewMatrix * vec4(position, 1.0);',
      '  vViewPosition = mvPos.xyz;',
      '  vViewNormal   = normalize(normalMatrix * normal);',
      '  gl_Position   = projectionMatrix * mvPos;',
      '}'
    ].join('\n'),
    fragmentShader: GLOW_FRAG
  }, GLOW_COMMON));
}

/**
 * Orbit path line for the solar overlay.
 *
 * A GL line rather than a tube: solar orbits are viewed across five orders of
 * magnitude of camera distance (Earth's surface out to ~200 AU), so any fixed
 * world thickness either aliases at the far end or engulfs the camera at the
 * near end. A line is 1px at every distance and — unlike a screen-space-
 * expanded tube — the GPU clips it correctly where the path crosses the near
 * plane, which it does constantly: Earth sits *on* Earth's orbit, which is the
 * scene origin.
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
 */
export function createOrbitLineMaterial(opacity) {
  return new THREE.LineBasicMaterial(Object.assign({}, GLOW_COMMON, {
    color:        0xffffff,
    opacity:      opacity,
    vertexColors: true,
    depthTest:    true
  }));
}

/**
 * White SDF text with a proportional black outline, always drawn on top.
 * @param {string}   text
 * @param {number}   fontSize in world units of the caller's scene
 * @param {function} onSync   called when troika finishes building the glyph
 *                            geometry (wake the RAF loop so it appears at once)
 */
export function makeRadarLabel(text, fontSize, onSync) {
  var label = new Text();
  label.text           = text;
  label.fontSize       = fontSize;
  label.color          = '#ffffff';
  label.fillOpacity    = 0.8;
  label.outlineWidth   = '10%';
  label.outlineColor   = '#000000';
  label.outlineOpacity = 0.8;
  label.anchorX        = 'center';
  label.anchorY        = 'middle';
  label.depthTest      = false;
  label.renderOrder    = 999;
  label.sync(onSync);
  return label;
}
