import * as THREE from 'three';
import config from '../../config.js';

// Scale factor for testing (100 million × real dimensions)
var KM_TO_MPC  = 1 / 3.085677581e19; // 1 km in Mpc
var AU_TO_MPC  = 1 / 2.06264806e11;  // 1 AU in Mpc
var SOLAR_CAM_NEAR = 1e-17; // Mpc — well inside Earth
var SOLAR_CAM_FAR  = 1e-6; // Mpc — comfortably past the Sun

var VERT = [
  'varying vec3 vLocalPos;',
  'varying vec3 vWorldNormal;',
  'void main() {',
  '  vLocalPos    = position;',
  '  vWorldNormal = normalize(mat3(modelMatrix) * position);',
  '  gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

// Sun: emissive, no lighting
var FRAG_SUN = [
  'uniform sampler2D tEquirect;',
  'varying vec3 vLocalPos;',
  'void main() {',
  '  vec3  dir = normalize(vLocalPos);',
  '  float ra  = atan(dir.y, dir.x);',
  '  float dec = asin(clamp(dir.z, -1.0, 1.0));',
  '  float u   = 0.5 - ra  / (2.0 * 3.14159265358979);',
  '  float v   = 0.5 + dec /       3.14159265358979;',
  '  gl_FragColor = vec4(min(texture2D(tEquirect, vec2(u, v)).rgb * 3.0, vec3(1.0)), 1.0);',
  '}'
].join('\n');

// Planets: Lambert diffuse from sun + ambient fill
var FRAG_PLANET = [
  'uniform sampler2D tEquirect;',
  'uniform vec3  uSunDir;',
  'uniform float uAmbient;',
  'varying vec3 vLocalPos;',
  'varying vec3 vWorldNormal;',
  'void main() {',
  '  vec3  dir  = normalize(vLocalPos);',
  '  float ra   = atan(dir.y, dir.x);',
  '  float dec  = asin(clamp(dir.z, -1.0, 1.0));',
  '  float u    = 0.5 - ra  / (2.0 * 3.14159265358979);',
  '  float v    = 0.5 + dec /       3.14159265358979;',
  '  vec3  tex  = texture2D(tEquirect, vec2(u, v)).rgb;',
  '  float diff = max(0.0, dot(normalize(vWorldNormal), uSunDir));',
  '  gl_FragColor = vec4(min(tex * (uAmbient + diff), vec3(1.0)), 1.0);',
  '}'
].join('\n');

export default function createSolarRenderer(unrenderObj, markDirty) {
  var container   = unrenderObj.getContainer();
  var aspect      = container.clientWidth / container.clientHeight;
  var solarScene  = new THREE.Scene();
  var solarCamera = new THREE.PerspectiveCamera(70, aspect, SOLAR_CAM_NEAR, SOLAR_CAM_FAR);
  var meshes      = [];
  var sunMesh     = null;
  var _visible    = true;

  var maxAniso = unrenderObj.renderer().capabilities.getMaxAnisotropy();

  // Update camera aspect on window resize
  unrenderObj.onResize(function() {
    solarCamera.aspect = container.clientWidth / container.clientHeight;
    solarCamera.updateProjectionMatrix();
  });

  fetch(config.dataUrl + 'aux/solar/manifest.json')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(manifest) {
      var earth = manifest.bodies.find(function(b) { return b.id === 'earth'; });
      var earthAnom = (earth ? earth.anom : 0) * Math.PI / 180;
      var earthSma  = earth ? earth.sma : 1;
      var earthHX   = earthSma * Math.cos(earthAnom); // AU
      var earthHY   = earthSma * Math.sin(earthAnom); // AU

      manifest.bodies.forEach(function(body) {
        loadBody(body, earthHX, earthHY);
      });
    })
    .catch(function(err) { console.warn('[solarRenderer] manifest load failed:', err); });

  function loadBody(body, earthHX, earthHY) {
    var tex = new THREE.TextureLoader().load(
      config.dataUrl + 'aux/solar/' + body.id + '.jpg',
      function() { markDirty(); }
    );
    tex.colorSpace      = THREE.SRGBColorSpace;
    tex.wrapS           = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter       = THREE.LinearFilter;
    tex.anisotropy      = maxAniso;

    var radius = (body.diam / 2) * KM_TO_MPC;
    var geo    = new THREE.IcosahedronGeometry(radius, 5);

    // Geocentric position (heliocentric minus Earth heliocentric)
    var anom = body.anom * Math.PI / 180;
    var px   = (body.sma * Math.cos(anom) - earthHX) * AU_TO_MPC;
    var py   = (body.sma * Math.sin(anom) - earthHY) * AU_TO_MPC;

    var isSun = body.id === 'sun';
    var mat = new THREE.ShaderMaterial({
      uniforms: isSun
        ? { tEquirect: { value: tex } }
        : { tEquirect: { value: tex }, uSunDir: { value: new THREE.Vector3() }, uAmbient: { value: 0.5 } },
      vertexShader:   VERT,
      fragmentShader: isSun ? FRAG_SUN : FRAG_PLANET,
      side:       THREE.FrontSide,
      depthTest:  true,
      depthWrite: true
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, 0);
    mesh.userData.isSun = isSun;
    solarScene.add(mesh);
    meshes.push(mesh);

    if (isSun) sunMesh = mesh;
    markDirty();

    // Once all bodies are loaded, wire up sun direction uniforms for planets
    updateSunDirs();
  }

  function updateSunDirs() {
    if (!sunMesh) return;
    meshes.forEach(function(m) {
      if (m.userData.isSun) return;
      var u = m.material.uniforms.uSunDir;
      if (!u) return;
      u.value.subVectors(sunMesh.position, m.position).normalize();
    });
  }

  function solarPass(threeRenderer, mainCamera) {
    if (!_visible) return;
    solarCamera.quaternion.copy(mainCamera.quaternion);
    solarCamera.position.copy(mainCamera.position);
    solarCamera.updateMatrixWorld();
    threeRenderer.clearDepth();
    threeRenderer.render(solarScene, solarCamera);
  }

  unrenderObj.onAfterToneMap(solarPass);

  return {
    setVisible: function(v) {
      _visible = v;
      markDirty();
    },
    dispose: function() {
      unrenderObj.offAfterToneMap(solarPass);
      meshes.forEach(function(m) {
        solarScene.remove(m);
        m.geometry.dispose();
        if (m.material.uniforms.tEquirect) m.material.uniforms.tEquirect.value.dispose();
        m.material.dispose();
      });
      meshes = [];
      sunMesh = null;
    }
  };
}
