var THREE = require('three');
var defaultTexture = require('./particle-texture.js');
var vertexShader = require('./particle-vertex-shader.js');
var fragmentShader = require('./particle-fragment-shader.js');
var slice = require('./slice.js');

module.exports = createParticleMaterial;

function createParticleMaterial() {
    // The slice uniforms are shared with every other layer that honours it, so
    // they are merged in by reference rather than declared here — see slice.js.
    var uniforms = slice.withSlice({
        color:        { value: new THREE.Color(0xffffff) },
        pointTexture: { value: new THREE.TextureLoader().load(defaultTexture) },
        uSize:           { value: 0.05 },
        uViewportHeight: { value: 600.0 }
    });

  var material = new THREE.ShaderMaterial({
    uniforms: uniforms,
    vertexShader: vertexShader,
    fragmentShader: fragmentShader,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false
  });

  return material;
}
