var THREE = require('three');
var defaultTexture = require('./particle-texture.js');
var vertexShader = require('./particle-vertex-shader.js');
var fragmentShader = require('./particle-fragment-shader.js');

module.exports = createParticleMaterial;

function createParticleMaterial() {
  var uniforms = {
    color:   { value: new THREE.Color(0xffffff) },
    pointTexture: { value: new THREE.TextureLoader().load(defaultTexture) },
    uSize:   { value: 0.1 }
  };

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
