import * as THREE from 'three';
import config from '../../config.js';

var KM_TO_MPC  = 1 / 3.085677581e19; // 1 km in Mpc
var AU_TO_MPC  = 1 / 2.06264806e11;  // 1 AU in Mpc
var SOLAR_CAM_NEAR = 1e-17; // Mpc — well inside Earth
var SOLAR_CAM_FAR  = 1e-6;  // Mpc — comfortably past the Sun
var GLOW_SCALE = 22; // glow sprite diameter = sun radius × this

var VERT = [
  'varying vec3 vLocalPos;',
  'varying vec3 vWorldNormal;',
  'void main() {',
  '  vLocalPos    = position;',
  '  vWorldNormal = normalize(mat3(modelMatrix) * position);',
  '  gl_Position  = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

// Sun: emissive, no lighting.
// u = 0.5 + ra/(2π): surface viewed from outside → East is right.
var FRAG_SUN = [
  'uniform sampler2D tEquirect;',
  'varying vec3 vLocalPos;',
  'void main() {',
  '  vec3  dir = normalize(vLocalPos);',
  '  float ra  = atan(dir.y, dir.x);',
  '  float dec = asin(clamp(dir.z, -1.0, 1.0));',
  '  float u   = 0.5 + ra  / (2.0 * 3.14159265358979);',
  '  float v   = 0.5 + dec /       3.14159265358979;',
  '  gl_FragColor = vec4(min(texture2D(tEquirect, vec2(u, v)).rgb * 6.0, vec3(1.0)), 1.0);',
  '}'
].join('\n');

// Planets: Lambertian + ambient, soft terminator.
// u = 0.5 + ra/(2π): surface viewed from outside → East is right.
var FRAG_PLANET = [
  'uniform sampler2D tEquirect;',
  'uniform vec3  uSunDir;',
  'uniform float uAmbient;',
  'varying vec3 vLocalPos;',
  'varying vec3 vWorldNormal;',
  'void main() {',
  '  vec3  dir   = normalize(vLocalPos);',
  '  float ra    = atan(dir.y, dir.x);',
  '  float dec   = asin(clamp(dir.z, -1.0, 1.0));',
  '  float u     = 0.5 + ra  / (2.0 * 3.14159265358979);',
  '  float v     = 0.5 + dec /       3.14159265358979;',
  '  vec3  tex   = texture2D(tEquirect, vec2(u, v)).rgb;',
  '  float NdotL = dot(normalize(vWorldNormal), uSunDir);',
  '  float diff  = smoothstep(-0.08, 0.15, NdotL);',
  '  float light = uAmbient + (1.0 - uAmbient) * diff;',
  '  gl_FragColor = vec4(tex * light, 1.0);',
  '}'
].join('\n');

// Earth: same as FRAG_PLANET with an additional cloud layer.
var FRAG_EARTH = [
  'uniform sampler2D tEquirect;',
  'uniform sampler2D tClouds;',
  'uniform vec3  uSunDir;',
  'uniform float uAmbient;',
  'varying vec3 vLocalPos;',
  'varying vec3 vWorldNormal;',
  'void main() {',
  '  vec3  dir   = normalize(vLocalPos);',
  '  float ra    = atan(dir.y, dir.x);',
  '  float dec   = asin(clamp(dir.z, -1.0, 1.0));',
  '  float u     = 0.5 + ra  / (2.0 * 3.14159265358979);',
  '  float v     = 0.5 + dec /       3.14159265358979;',
  '  vec2  uv    = vec2(u, v);',
  '  vec3  tex   = texture2D(tEquirect, uv).rgb;',
  '  float cloud = texture2D(tClouds, uv).r;',
  '  vec3  color = mix(tex, vec3(1.0), cloud * 0.85);',
  '  float NdotL = dot(normalize(vWorldNormal), uSunDir);',
  '  float diff  = smoothstep(-0.08, 0.15, NdotL);',
  '  float light = uAmbient + (1.0 - uAmbient) * diff;',
  '  gl_FragColor = vec4(color * light, 1.0);',
  '}'
].join('\n');

function makeGlowTexture() {
  var sz = 256, c = sz / 2;
  var canvas = document.createElement('canvas');
  canvas.width = sz; canvas.height = sz;
  var ctx  = canvas.getContext('2d');
  var grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0,    'rgba(255,245,210,1)');
//   grad.addColorStop(0.15, 'rgba(255,220,140,0.85)');
//   grad.addColorStop(0.35, 'rgba(255,180,60,0.35)');
  grad.addColorStop(1,    'rgba(255,120,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, sz, sz);
  return new THREE.CanvasTexture(canvas);
}

export default function createSolarRenderer(unrenderObj, markDirty) {
  var container   = unrenderObj.getContainer();
  var aspect      = container.clientWidth / container.clientHeight;
  var solarScene  = new THREE.Scene();
  var solarCamera = new THREE.PerspectiveCamera(70, aspect, SOLAR_CAM_NEAR, SOLAR_CAM_FAR);
  var meshes      = [];
  var sunMesh     = null;
  var _visible    = true;

  var maxAniso = unrenderObj.renderer().capabilities.getMaxAnisotropy();

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
      var earth     = manifest.bodies.find(function(b) { return b.id === 'earth'; });
      var earthAnom = (earth ? earth.anom : 0) * Math.PI / 180;
      var earthSma  = earth ? earth.sma : 1;
      var earthHX   = earthSma * Math.cos(earthAnom);
      var earthHY   = earthSma * Math.sin(earthAnom);
      manifest.bodies.forEach(function(body) { loadBody(body, earthHX, earthHY); });
    })
    .catch(function(err) { console.warn('[solarRenderer] manifest load failed:', err); });

  function loadTex(url) {
    var tex = new THREE.TextureLoader().load(url, function() { markDirty(); });
    tex.colorSpace      = THREE.SRGBColorSpace;
    tex.wrapS           = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter       = THREE.LinearFilter;
    tex.anisotropy      = maxAniso;
    return tex;
  }

  function loadBody(body, earthHX, earthHY) {
    var isSun   = body.id === 'sun';
    var isEarth = body.id === 'earth';
    var tex     = loadTex(config.dataUrl + 'aux/solar/' + body.id + '.jpg');
    var radius  = (body.diam / 2) * KM_TO_MPC;
    var geo     = new THREE.IcosahedronGeometry(radius, 5);

    var anom = body.anom * Math.PI / 180;
    var px   = (body.sma * Math.cos(anom) - earthHX) * AU_TO_MPC;
    var py   = (body.sma * Math.sin(anom) - earthHY) * AU_TO_MPC;

    var uniforms, frag;
    if (isSun) {
      uniforms = { tEquirect: { value: tex } };
      frag     = FRAG_SUN;
    } else if (isEarth) {
      uniforms = {
        tEquirect: { value: tex },
        tClouds:   { value: loadTex(config.dataUrl + 'aux/solar/earth_clouds.jpg') },
        uSunDir:   { value: new THREE.Vector3() },
        uAmbient:  { value: 0.2 }
      };
      frag = FRAG_EARTH;
    } else {
      uniforms = {
        tEquirect: { value: tex },
        uSunDir:   { value: new THREE.Vector3() },
        uAmbient:  { value: 0.2 }
      };
      frag = FRAG_PLANET;
    }

    var mat = new THREE.ShaderMaterial({
      uniforms:       uniforms,
      vertexShader:   VERT,
      fragmentShader: frag,
      side:       THREE.FrontSide,
      depthTest:  true,
      // Sun must not write depth: the glow (renderOrder 2) depth-tests against
      // planet depths only, so it can render over the sun surface.
      depthWrite:  !isSun,
      // Sun goes into the transparent pass so mesh.renderOrder takes effect.
      transparent: isSun
    });

    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(px, py, 0);
    mesh.renderOrder     = isSun ? 1 : 0;
    mesh.userData.isSun  = isSun;
    solarScene.add(mesh);
    meshes.push(mesh);

    if (isSun) {
      sunMesh = mesh;

      // Glow: depthTest against planets only (sun wrote no depth).
      // renderOrder 2 → renders after sun (renderOrder 1).
      var glowMat = new THREE.SpriteMaterial({
        map:         makeGlowTexture(),
        blending:    THREE.AdditiveBlending,
        depthTest:   true,
        depthWrite:  false,
        transparent: true
      });
      var glow = new THREE.Sprite(glowMat);
      glow.renderOrder = 2;
      var gs = radius * GLOW_SCALE;
      glow.scale.set(gs, gs, 1);
      glow.position.set(px, py, 0);
      glow.userData.isGlow = true;
      solarScene.add(glow);
      meshes.push(glow);
    }

    markDirty();
    updateSunDirs();
  }

  function updateSunDirs() {
    if (!sunMesh) return;
    meshes.forEach(function(m) {
      if (m.userData.isSun || m.userData.isGlow) return;
      var u = m.material.uniforms.uSunDir;
      if (u) u.value.subVectors(sunMesh.position, m.position).normalize();
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
    setVisible: function(v) { _visible = v; markDirty(); },
    dispose: function() {
      unrenderObj.offAfterToneMap(solarPass);
      meshes.forEach(function(m) {
        solarScene.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) {
          var u = m.material.uniforms;
          if (u) {
            if (u.tEquirect) u.tEquirect.value.dispose();
            if (u.tClouds)   u.tClouds.value.dispose();
          } else if (m.material.map) {
            m.material.map.dispose();
          }
          m.material.dispose();
        }
      });
      meshes = [];
      sunMesh = null;
    }
  };
}
