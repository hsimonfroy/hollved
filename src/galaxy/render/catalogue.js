/**
 * The redshift catalogue: one point cloud, one material and one draw call per
 * tracer.
 *
 * The colour is a per-tracer uniform rather than a per-point attribute -- every
 * point of a tracer shares it -- and a hidden tracer is not drawn at all. Points
 * behind the camera or far below a pixel are culled in the vertex shader, before
 * they cost any fill.
 */
import * as THREE from 'three';
import sprite from './sprite.js';
import slice from './slice.js';

var VERTEX_SHADER = [
  slice.GLSL,
  'uniform vec4 uColor;',
  'uniform float uSize;',
  'uniform float uViewportHeight;',
  // The point's alpha, already dimmed for its sub-pixel size: the one value the
  // fragment shader needs. A single varying keeps the per-vertex output small,
  // which is what a tile-based (mobile) GPU writes to memory and reads back.
  'varying float vFlux;',
  'void main() {',
  // The catalogue's model matrix is the identity, so `position` is already the
  // world position the slice is tested in.
  '  float alpha = uColor.a * sliceAlpha(position);',
  '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
  '  float size = uSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / length(mvPosition.xyz);',
  // Invisible, behind the camera (view-space z > 0), or far below a pixel.
  '  if (alpha < 0.004 || mvPosition.z > 0.0 || size < 0.0003) {',
  '    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
  '    gl_PointSize = 0.0;',
  '    return;',
  '  }',
  // Never below a pixel; a sub-pixel point is dimmed instead, so its flux falls
  // with its size.
  '  vFlux = alpha * min(size, 1.0);',
  '  gl_PointSize = max(size, 1.0);',
  '  gl_Position = projectionMatrix * mvPosition;',
  '}'
].join('\n');

var FRAGMENT_SHADER = [
  'uniform vec4 uColor;',
  'uniform sampler2D pointTexture;',
  'varying float vFlux;',
  'void main() {',
  '  vec4 tColor = texture2D(pointTexture, gl_PointCoord);',
  '  if (tColor.a < 0.01) discard;',
  '  gl_FragColor = vec4(uColor.rgb, tColor.a * vFlux);',
  '}'
].join('\n');

export default function createCatalogue(scene) {
  // Shared by every tracer's material, by reference.
  var shared = {
    pointTexture:    { value: new THREE.TextureLoader().load(sprite) },
    uSize:           { value: 0.05 },
    uViewportHeight: { value: 600.0 }
  };
  var clouds = [];   // one THREE.Points per tracer, named by tracer id

  return {
    setTracers: setTracers,
    setTracerVisible: function(id, visible) {
      clouds.forEach(function(points) { if (points.name === id) points.visible = visible; });
    },
    setViewportHeight: function(h) { shared.uViewportHeight.value = h; }
  };

  /** @param {Array} list one { id, color, positions } per tracer, as graphLoader publishes them */
  function setTracers(list) {
    clouds.forEach(function(points) {
      scene.remove(points);
      points.geometry.dispose();
      points.material.dispose();
    });
    clouds = list.map(function(t) {
      // Float16Array wraps the downloaded buffer as it is; Float16BufferAttribute,
      // the fallback for browsers without it, makes a copy.
      var attribute = typeof Float16Array !== 'undefined'
        ? new THREE.BufferAttribute(new Float16Array(t.positions.buffer, t.positions.byteOffset, t.positions.length), 3)
        : new THREE.Float16BufferAttribute(t.positions, 3);
      // Never read back once on the GPU, so the CPU copy is dropped there:
      // 6 bytes a point, 180 MB for a 30M-point catalogue.
      attribute.onUpload(function() { this.array = null; });

      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', attribute);
      // Given, not computed: three would read it from the array, which is about
      // to be released, for culling and for sorting. A survey surrounds the
      // observer and is nearly always in view, so it is simply unbounded.
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
      var points = new THREE.Points(geometry, createMaterial(t.color));
      points.name = t.id;
      points.matrixAutoUpdate = false;   // never moves
      scene.add(points);
      return points;
    });
  }

  function createMaterial(color) {
    return new THREE.ShaderMaterial({
      uniforms: slice.withSlice(Object.assign({}, shared, {
        uColor: { value: new THREE.Vector4(
          ((color >>> 24) & 0xff) / 255, ((color >>> 16) & 0xff) / 255,
          ((color >>> 8)  & 0xff) / 255, (color & 0xff) / 255) }
      })),
      vertexShader:   VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending:    THREE.AdditiveBlending,
      // Nothing in the HDR pass uses depth, and its target has no depth buffer.
      depthTest:   false,
      depthWrite:  false
    });
  }
}
