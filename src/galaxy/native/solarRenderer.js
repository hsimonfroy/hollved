/**
 * Solar system overlay: Sun, eight planets, the Moon, Saturn's rings.
 *
 * Rendered in its own pass after tone-mapping (`onAfterToneMap`) with its own
 * camera, because the system spans ~1e-16 to 1e-10 Mpc — entirely inside the
 * main camera's 3e-3 Mpc near plane.
 *
 * Frame: ICRS (RA/Dec), Z-up, shared with the galaxy catalogues. Earth sits
 * exactly at the origin; see `sunGroup` below.
 *
 * Everything astronomical is evaluated ONCE, at manifest load. Per frame the
 * pass only places ~10 labels, sizes the Sun's corona, sets the planet dots'
 * alpha and updates the near plane.
 */
import * as THREE from 'three';
import config from '../../config.js';
import { raDec2UnitVec } from './coordUtils.js';
import { createOrbitLineMaterial } from './radarStyle.js';
import { magnitudeRank } from './labelLayer.js';
import createHeliosphere from './heliosphere.js';
import createStarMaterial from '../../unrender/lib/star-material.js';

var KM_TO_MPC = 1 / 3.085677581e19; // 1 km in Mpc
var AU_TO_MPC = 1 / 2.06264806e11;  // 1 AU in Mpc
var DEG2RAD   = Math.PI / 180;
var J2000_JD  = 2451545.0;

var SOLAR_CAM_NEAR = 1e-17; // Mpc — floor for the dynamic near plane
// 10 pc, where the Sun's apparent magnitude equals its absolute one. Past this
// the Sun is dimmer than 4.8 and belongs to the star catalogue -- which now
// carries it, so nothing is cut off here any more. Bounded from both sides: too
// small clips the heliosphere instead of letting its own MIN_PX rule hide it
// (~2.5e-6), too large and the near plane below has nowhere safe to sit.
var SOLAR_CAM_FAR  = 1e-5;
var SOLAR_CAM_FOV  = 70;

// Earth's centre relative to the Earth-Moon barycentre, which is what JPL's
// "EM Bary" elements actually describe: m_moon / (m_earth + m_moon).
var EMB_FACTOR = 0.012150585;

// Rendering constants, not physical data, so they live here and not
// in the manifest.
var SUN_BRIGHTNESS  = 6.0; // brightness of texture, not glow
var BODY_BRIGHTNESS = 1.5;
var BODY_AMBIENT    = 0.03;
// A ring's "ambient" is Saturnshine and multiple scattering between particles,
// nothing like a planet's night side, so it gets its own pair.
var RING_BRIGHTNESS = 2.5;
var RING_AMBIENT    = 0.1;

// Bodies stay true-to-scale, so a distant one is sub-pixel and rasterises to
// nothing. The Sun answers that with a corona; every other body with a plain dot,
// deliberately NOT a glow -- a glow would make a planet read as a star, and stars
// are coming later as their own particles.
var SUN_GLOW_SCALE  = 14;   // corona physical radius in sun radius, while resolved
var SUN_GLOW_MIN_PX = 5;  // ...but never smaller on screen; it dims instead, see below
// Screen RADIUS of the stand-in dot, and how bright it is. DOT_PX is the fade
// width too
// The Sun's absolute visual magnitude -- row 0 of the HYG catalogue, which also
// carries it as a star. Used only to rank its LABEL on the same scale as every
// other star's; nothing about the Sun's rendering reads it.
var SUN_ABSMAG      = 4.831;

var DOT_PX          = 1.0;
var DOT_ALPHA       = 0.5;

// Orbit trails: sampled backward in time over one period, fading to nothing.
var TRAIL_SEGMENTS  = 512;
// An escaping spacecraft has no period, so its trail needs a span of its own.
// A decade covers ~36 AU, which reads as a direction of travel from outside the
// planets; a single year is a tick mark at any zoom that fits the Voyagers in.
var ESCAPE_TRAIL_DAYS = 15 * 365.25;
var ORBIT_MAX_ALPHA = 0.5; // alpha at the body.

// Inside a body you see its inner surface, faintly, so the sky still reads through
// it. The texture is shown unlit there (uAmbient driven to 1) -- a terminator on a
// surface you are standing inside is meaningless, and half the map would be black.
var INSIDE_ALPHA = 0.3;

var RING_SEGMENTS = 256;
var RING_PENUMBRA = 0.03; // shadow edge softness, in planet radii
var RING_UNLIT_FACE = 0.35; // dimming when viewed from the shaded face

// -----------------------------------------------------------------------------
// Shaders
// -----------------------------------------------------------------------------

// Directions come from the `normal` attribute, never from `position`.
//
// Body radii here are 2e-16 to 2e-14 Mpc, so `normalize(position)` computes
// dot(position, position) ~ 1e-30, which underflows to zero at anything below
// full float32 and turns the whole expression into 0/0. The UV then collapses
// to NaN and every body renders as one flat colour. IcosahedronGeometry with
// detail > 0 calls normalizeNormals(), so `normal` is already the unit radial
// direction, computed on the CPU in float64 — O(1) values, no tiny-magnitude
// arithmetic anywhere in the shader.
var BODY_VERT = [
  'varying vec3 vLocalDir;',
  '#ifdef LIT',
  'varying vec3 vWorldNormal;',
  '#endif',
  'void main() {',
  '  vLocalDir = normal;',
  '#ifdef LIT',
  '  vWorldNormal = normalize(mat3(modelMatrix) * normal);',
  '#endif',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

// One shader for every body. LIT adds Lambertian shading with a soft
// terminator (omitted for the emissive Sun); CLOUDS adds Earth's cloud layer.
// u = 0.5 + ra/(2pi): surface viewed from outside, so East is to the right.
var BODY_FRAG = [
  'uniform sampler2D tEquirect;',
  'uniform float uBrightness;',
  'uniform float uAlpha;',
  '#ifdef CLOUDS',
  'uniform sampler2D tClouds;',
  '#endif',
  '#ifdef LIT',
  'uniform vec3  uSunDir;',
  'uniform float uAmbient;',
  'varying vec3  vWorldNormal;',
  '#endif',
  'varying vec3 vLocalDir;',
  'void main() {',
  '  vec3  dir = normalize(vLocalDir);',
  '  float ra  = atan(dir.y, dir.x);',
  '  float dec = asin(clamp(dir.z, -1.0, 1.0));',
  '  vec2  uv  = vec2(0.5 + ra / (2.0 * 3.14159265358979),',
  '                   0.5 + dec /       3.14159265358979);',
  '  vec3  color = texture2D(tEquirect, uv).rgb;',
  '#ifdef CLOUDS',
  '  color = mix(color, vec3(1.0), texture2D(tClouds, uv).r * 0.85);',
  '#endif',
  '#ifdef LIT',
  '  float NdotL = dot(normalize(vWorldNormal), uSunDir);',
  '  color *= uAmbient + (1.0 - uAmbient) * smoothstep(-0.08, 0.15, NdotL);',
  '#endif',
  // clamped because this pass writes straight to LDR, after tone-mapping
  '  gl_FragColor = vec4(min(color * uBrightness, vec3(1.0)), uAlpha);',
  // The texture was decoded sRGB -> linear on sampling, and the framebuffer is
  // sRGB, so it has to be encoded back. Every built-in material sharing this
  // pass -- the corona sprite, the planet dots, the trail lines, the labels --
  // does this via #include <colorspace_fragment>; a ShaderMaterial does not, and
  // without it the bodies were the only things writing linear values to an sRGB
  // target. three injects linearToOutputTexel into every non-raw ShaderMaterial.
  '  gl_FragColor = linearToOutputTexel(gl_FragColor);',
  '}'
].join('\n');

// Rings: flat annulus, texture sampled radially (see buildRing for the UVs).
//
// aDir is the unit direction in the ring plane, supplied as an attribute rather
// than derived from an azimuth angle: an angle wraps at +-pi and would sweep a
// garbage wedge across the seam quad.
var RING_VERT = [
  'attribute vec2 aDir;',
  'varying vec2 vUv;',
  'varying vec2 vDir;',
  'void main() {',
  '  vUv  = uv;',
  '  vDir = aDir;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
  '}'
].join('\n');

// Lit per fragment from uSunDirLocal, like the bodies, plus the planet's shadow
// cast across the ring -- the feature that actually makes a ring read as real,
// and the only part of ring lighting that varies across the surface (a flat
// ring has a constant normal, so its Lambert term does not).
//
// All of this works in PLANET RADII, deliberately: ring radii in Mpc are ~4e-15
// and length() squares them to ~1e-29, which underflows below full float32. As
// ratios the ring spans 1.28..2.41 and the shadow cylinder has radius exactly 1.
var RING_FRAG = [
  'uniform sampler2D tRing;',
  'uniform vec3  uSunDirLocal;',   // unit, ring-local frame: pole is +Z
  'uniform float uInnerR;',        // ring radii, in planet radii
  'uniform float uOuterR;',
  'uniform float uPenumbra;',
  'uniform float uUnlitFace;',     // <1 when the viewer sees the shaded face
  'uniform float uAmbient;',
  'uniform float uBrightness;',
  'varying vec2 vUv;',
  'varying vec2 vDir;',
  'void main() {',
  '  vec4 c = texture2D(tRing, vec2(vUv.x, 0.5));',
  '  vec3  p      = vec3(vDir * mix(uInnerR, uOuterR, vUv.x), 0.0);',
  '  float along  = dot(p, uSunDirLocal);',
  '  vec3  perp   = p - uSunDirLocal * along;',
  // in shadow when the point lies anti-sunward and inside the planet's cylinder
  '  float shadow = along < 0.0 ? smoothstep(1.0, 1.0 + uPenumbra, length(perp)) : 1.0;',
  '  float light  = uAmbient + (1.0 - uAmbient)',
  '               * abs(uSunDirLocal.z) * shadow * uUnlitFace;',
  '  gl_FragColor = vec4(min(c.rgb * light * uBrightness, vec3(1.0)), c.a);',
  '  gl_FragColor = linearToOutputTexel(gl_FragColor);',  // see BODY_FRAG
  '}'
].join('\n');

// Common settings for every map in this pass. The shaders encode to sRGB on
// output, so a map has to be decoded on the way in or it round-trips through only
// half a transfer. No mip chain: at a few pixels across a mip level averages the
// bright core away, and none of these maps carries detail one would preserve.
function solarTexture(tex) {
  tex.colorSpace      = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter       = THREE.LinearFilter;
  return tex;
}

// -----------------------------------------------------------------------------
// Astronomy
//
// Planets use the JPL/Standish approximate elements, referred to the mean
// ecliptic and equinox of J2000. Only the mean anomaly M and the prime-meridian
// angle W advance with time; a/e/i/node/peri stay at their J2000 values because
// in a *fixed* J2000 frame their secular rates are <= 0.33 deg/century. (The
// famous 574"/century of Mercury is mostly precession of the frame itself,
// which does not exist here.)
//
// The Moon cannot use that model: its node has regressed 515 deg and its
// perigee advanced 1084 deg since J2000 — whole revolutions, ~12000x faster
// than any planet. It gets a short periodic series instead.
// -----------------------------------------------------------------------------

// Days elapsed since the J2000.0 epoch. Unix epoch = JD 2440587.5.
function daysSinceJ2000() {
  return (Date.now() / 86400000) + 2440587.5 - J2000_JD;
}

// Solve M = E - e*sin(E) for the eccentric anomaly. Newton converges in a
// handful of iterations for solar-system eccentricities.
function solveKepler(M, e) {
  var E = M + e * Math.sin(M);
  for (var k = 0; k < 12; ++k) {
    var dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

// Matrix taking a point in the orbital plane (x toward perihelion) to the
// heliocentric ICRS/equatorial frame the scene uses:
//   Rx(eps) . Rz(node) . Rx(i) . Rz(peri - node)
// The leading Rx(eps) is the obliquity of the ecliptic — the rotation that
// tilts the whole solar system relative to the RA/Dec grid shared with the
// galaxy data.
function orbitalToEquatorial(orbit, obliquity) {
  return new THREE.Matrix4().makeRotationX(obliquity * DEG2RAD)
    .multiply(new THREE.Matrix4().makeRotationZ(orbit.node * DEG2RAD))
    .multiply(new THREE.Matrix4().makeRotationX(orbit.i * DEG2RAD))
    .multiply(new THREE.Matrix4().makeRotationZ((orbit.peri - orbit.node) * DEG2RAD));
}

// Heliocentric position at time d (days since J2000), in AU.
function keplerPosition(orbit, d, mat) {
  var M = (orbit.m0 + orbit.mDot * d) * DEG2RAD;
  M = Math.atan2(Math.sin(M), Math.cos(M)); // wrap to [-pi, pi] for Newton
  var E = solveKepler(M, orbit.e);
  return new THREE.Vector3(
    orbit.a * (Math.cos(E) - orbit.e),
    orbit.a * Math.sqrt(1 - orbit.e * orbit.e) * Math.sin(E),
    0
  ).applyMatrix4(mat);
}

// Sum a table of [cD, cM, cMp, cF, amplitude] terms. A term with all-zero
// coefficients contributes its amplitude directly, which is how the parallax
// series carries its constant.
function sumSeries(terms, D, M, Mp, F, useCos) {
  var sum = 0;
  for (var i = 0; i < terms.length; ++i) {
    var t = terms[i];
    var arg = (t[0] * D + t[1] * M + t[2] * Mp + t[3] * F) * DEG2RAD;
    sum += t[4] * (useCos ? Math.cos(arg) : Math.sin(arg));
  }
  return sum;
}

// Geocentric Moon position at time d, in Mpc, ICRS.
function lunarPosition(orbit, d, obliquity) {
  var T = d / 36525;
  var a = orbit.args;
  var L  = a.L[0]  + a.L[1]  * T;
  var D  = a.D[0]  + a.D[1]  * T;
  var M  = a.M[0]  + a.M[1]  * T;
  var Mp = a.Mp[0] + a.Mp[1] * T;
  var F  = a.F[0]  + a.F[1]  * T;

  var lon = L + sumSeries(orbit.lon, D, M, Mp, F, false);
  var lat =     sumSeries(orbit.lat, D, M, Mp, F, false);
  var par =     sumSeries(orbit.par, D, M, Mp, F, true);

  // The series is referred to the mean equinox OF DATE, but this scene is
  // J2000. Without this the Moon drifts 0.014 deg/yr — 0.37 deg today, 0.70 by
  // 2050 — which is worse than the series' own (bounded) truncation error.
  lon -= orbit.precession[0] * T + orbit.precession[1] * T * T;

  var r  = orbit.parRadiusKm / Math.sin(par * DEG2RAD) * KM_TO_MPC;
  var cl = Math.cos(lat * DEG2RAD), sl = Math.sin(lat * DEG2RAD);
  var x  = r * cl * Math.cos(lon * DEG2RAD);
  var y  = r * cl * Math.sin(lon * DEG2RAD);
  var z  = r * sl;
  var ce = Math.cos(obliquity * DEG2RAD), se = Math.sin(obliquity * DEG2RAD);
  return new THREE.Vector3(x, y * ce - z * se, y * se + z * ce); // Rx(eps)
}

// Orient a body from its IAU rotation model.
//
// The body shader reads local +Z as the north pole (dec = +90) and local +X as
// the prime meridian (u = 0.5), so we build that basis directly:
//   Q = ascending node of the body equator on the ICRF equator, at RA = a0 + 90
//   X = Q rotated about the pole by W (easterly): the prime meridian
//
// Q is written analytically rather than as normalize(zICRF x pole): the cross
// product is *identically zero* for Earth (dec0 = +90 exactly), where the node
// degenerates, while (-sin a0, cos a0, 0) stays exact and matches the IAU
// convention that W is then measured from RA = 0.
function applyPoleOrientation(mesh, pole, d) {
  var p  = raDec2UnitVec(pole.ra, pole.dec);
  var P  = new THREE.Vector3(p.x, p.y, p.z);
  var ar = pole.ra * DEG2RAD;
  var Q  = new THREE.Vector3(-Math.sin(ar), Math.cos(ar), 0);
  var W  = (pole.w0 + pole.wDot * d) * DEG2RAD;

  var X = Q.clone().multiplyScalar(Math.cos(W))
           .addScaledVector(new THREE.Vector3().crossVectors(P, Q), Math.sin(W));
  var Y = new THREE.Vector3().crossVectors(P, X);

  mesh.setRotationFromMatrix(new THREE.Matrix4().set(
    X.x, Y.x, P.x, 0,
    X.y, Y.y, P.y, 0,
    X.z, Y.z, P.z, 0,
    0,   0,   0,   1
  ));
}

// -----------------------------------------------------------------------------

export default function createSolarRenderer(unrenderObj, markDirty, labels, onSunPos) {
  var container   = unrenderObj.getContainer();
  var solarScene  = new THREE.Scene();
  var solarCamera = new THREE.PerspectiveCamera(
    SOLAR_CAM_FOV, container.clientWidth / container.clientHeight,
    SOLAR_CAM_NEAR, SOLAR_CAM_FAR);

  // Everything solar hangs off this group, positioned at the Sun. Its children
  // are in plain heliocentric coordinates, so Earth's mesh sits at +earthHelio
  // inside a group at -earthHelio: the two cancel *identically* (three.js
  // composes matrices in JS float64), pinning Earth to the scene origin.
  var sunGroup = new THREE.Group();
  solarScene.add(sunGroup);

  var manifest  = null;
  var bodyById  = {};
  var orbitMats = {};   // body id -> orbital-plane to ICRS matrix (Kepler bodies)
  var epochDays = 0;
  var records   = [];   // one per body: mesh, world position; glow = Sun only
  var sunRec    = null; // the Sun's record; its .dist is the heliosphere's fade input
  var helio     = null; // the heliopause shell, centred on the Sun
  var dots      = null; // THREE.Points holding every body except the Sun
  var dotColors = null; // its colour attribute; only the alpha channel varies
  var trails    = [];
  var rings     = [];
  var _visible  = true;
  var _radarVisible = false; // may be set before the manifest resolves

  var viewportHeight = container.clientHeight || 600;
  var _sunDir = new THREE.Vector3();
  var _invQuat = new THREE.Quaternion();
  var _toCam  = new THREE.Vector3();
  var maxAniso = unrenderObj.renderer().capabilities.getMaxAnisotropy();

  unrenderObj.onResize(function() {
    viewportHeight = container.clientHeight || 600;
    solarCamera.aspect = container.clientWidth / container.clientHeight;
    solarCamera.updateProjectionMatrix();
  });

  fetch(config.dataUrl + 'aux/solar/manifest.json')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(m) {
      manifest  = m;
      epochDays = daysSinceJ2000();
      m.bodies.forEach(function(b) {
        bodyById[b.id] = b;
        if (b.orbit && !b.orbit.model) {
          orbitMats[b.id] = orbitalToEquatorial(b.orbit, m.obliquity);
        }
      });
      if (!bodyById.earth) throw new Error('manifest has no earth');

      // Earth -> Sun first: the Sun's position *relative to Earth* is what
      // places the whole system on the RA/Dec sky. Then Sun -> everything else.
      sunGroup.position.copy(positionAt(bodyById.earth, epochDays)).negate();
      // The star catalogue is measured from the barycentre and the scene's origin
      // is Earth, so the star field needs this offset -- most of all for row 0,
      // which is the Sun.
      if (onSunPos) onSunPos(sunGroup.position);

      m.bodies.forEach(loadBody);
      buildDots();          // needs every record, so it runs after the loop
      updateSunDirs();
      if (m.heliosphere) helio = createHeliosphere(sunGroup, m.heliosphere);
      applyRadarVisibility();
      markDirty();
    })
    .catch(function(err) { console.warn('[solarRenderer] manifest load failed:', err); });

  // ---------------------------------------------------------------------------
  // Positions
  // ---------------------------------------------------------------------------

  // The single position entry point. Returns sunGroup-local (heliocentric) Mpc.
  // Body placement, the trails and Earth's wobble all go through here, so no
  // formula is written twice and adding a time-sampled trail costs nothing.
  function positionAt(body, d) {
    if (!body.orbit) return new THREE.Vector3();            // the Sun
    if (body.orbit.model === 'lunar-series') {              // Moon: Earth + geocentric
      return positionAt(bodyById.earth, d).add(moonGeoAt(d));
    }
    if (body.orbit.model === 'escape') return escapePosition(body.orbit, d);
    var p = keplerPosition(body.orbit, d, orbitMats[body.id]).multiplyScalar(AU_TO_MPC);
    // JPL's Earth row is the Earth-Moon BARYCENTRE, not Earth. Resolving it
    // moves Earth by up to 4671 km — 0.73 Earth radii, so without this the
    // Earth trail visibly misses Earth once you are close enough to see it.
    if (body.id === 'earth') p.addScaledVector(moonGeoAt(d), -EMB_FACTOR);
    return p;
  }

  function moonGeoAt(d) {
    var moon = bodyById.moon;
    return moon ? lunarPosition(moon.orbit, d, manifest.obliquity) : new THREE.Vector3();
  }

  // Straight-line coast out of the system, for the Voyagers: position plus
  // velocity times elapsed time, both straight from the Horizons state vector.
  //
  // The line does NOT pass through the Sun, and that is the point: both craft
  // carry angular momentum from their flybys, so Voyager 1's asymptote misses the
  // Sun by 11.3 AU and its velocity sits 4.0 deg off its radius vector. A radial
  // model cannot represent that. This form is within 2% from 2000 to 2100, the
  // residual being real solar gravity still bending the path.
  //
  // The vectors are ICRF EQUATORIAL, so this returns the frame the ecliptic
  // elements only reach after orbitalToEquatorial; no obliquity rotation applies.
  function escapePosition(orbit, d) {
    var dt = d - (orbit.epoch - J2000_JD);   // days since the state-vector epoch
    var p  = orbit.posAu, v = orbit.velAuPerDay;
    return new THREE.Vector3(p[0] + v[0] * dt, p[1] + v[1] * dt, p[2] + v[2] * dt)
      .multiplyScalar(AU_TO_MPC);
  }

  function isEscaping(body) {
    return !!(body.orbit && body.orbit.model === 'escape');
  }

  function trailPeriodDays(body) {
    if (isEscaping(body)) return ESCAPE_TRAIL_DAYS;
    if (!body.orbit) return 0;
    return body.orbit.periodDays || (body.orbit.mDot ? 360 / body.orbit.mDot : 0);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  function loadTex(file) {
    var tex = solarTexture(new THREE.TextureLoader().load(
      config.dataUrl + 'aux/solar/' + file, function() { markDirty(); }));
    tex.wrapS      = THREE.RepeatWrapping;
    tex.anisotropy = maxAniso;
    return tex;
  }

  function makeBodyMaterial(body) {
    var isSun    = body.id === 'sun';
    var uniforms = {
      tEquirect:   { value: loadTex(body.id + '.jpg') },
      uBrightness: { value: isSun ? SUN_BRIGHTNESS : BODY_BRIGHTNESS },
      uAlpha:      { value: 1.0 }
    };
    var defines = {};
    if (!isSun) {
      defines.LIT = '';
      uniforms.uSunDir  = { value: new THREE.Vector3() };
      uniforms.uAmbient = { value: BODY_AMBIENT };
    }
    if (body.id === 'earth') {
      defines.CLOUDS = '';
      uniforms.tClouds = { value: loadTex('earth_clouds.jpg') };
    }
    return new THREE.ShaderMaterial({
      uniforms:       uniforms,
      defines:        defines,
      vertexShader:   BODY_VERT,
      fragmentShader: BODY_FRAG,
      side:      THREE.FrontSide,
      depthTest: true,
      // Sun must not write depth: its corona (renderOrder 2) depth-tests against
      // planet depths only, so it can render over the sun's own surface.
      depthWrite:  !isSun,
      // Always transparent, never toggled: three derives its `opaque` program-cache
      // flag from this, so flipping it at runtime would recompile the shader. At
      // uAlpha 1 the blend is indistinguishable from opaque, and renderOrder still
      // orders the pass. Same reason `side` is only touched on an actual crossing.
      transparent: true
    });
  }

  // Flat annulus in the body's equatorial plane. applyPoleOrientation already
  // puts local +Z on the pole, so RingGeometry's default XY plane *is* the
  // equatorial plane: as a child of the mesh the ring inherits the tilt free.
  function buildRing(body, mesh) {
    var inner = body.ring.inner * KM_TO_MPC;
    var outer = body.ring.outer * KM_TO_MPC;
    var geo   = new THREE.RingGeometry(inner, outer, RING_SEGMENTS, 1);

    // RingGeometry's own UVs are a planar box map. Rewrite them so u runs
    // radially, mapping the 2048x125 strip from inner edge to outer edge, and
    // record the in-plane unit direction for the shadow maths. Both are derived
    // here in float64, so the Mpc-scale positions never reach the shader.
    var pos = geo.attributes.position, uv = geo.attributes.uv;
    var dirs = new Float32Array(pos.count * 2);
    for (var i = 0; i < pos.count; ++i) {
      var x = pos.getX(i), y = pos.getY(i);
      var r = Math.sqrt(x * x + y * y);
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
      dirs[i * 2] = x / r; dirs[i * 2 + 1] = y / r;
    }
    uv.needsUpdate = true;
    geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 2));

    // Ring radii as multiples of the planet's radius: O(1), so the shader's
    // shadow test never squares a tiny number.
    var planetR = body.diam / 2;
    var ring = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: {
        tRing:        { value: loadTex(body.ring.tex) },
        uSunDirLocal: { value: new THREE.Vector3(0, 0, 1) },
        uInnerR:      { value: body.ring.inner / planetR },
        uOuterR:      { value: body.ring.outer / planetR },
        // the true penumbra is ~0.004 planet radii (the Sun subtends 0.11 deg
        // from Saturn); widened so the edge antialiases instead of crawling
        uPenumbra:    { value: RING_PENUMBRA },
        uUnlitFace:   { value: 1.0 },
        uAmbient:     { value: RING_AMBIENT },
        uBrightness:  { value: RING_BRIGHTNESS }
      },
      vertexShader:   RING_VERT,
      fragmentShader: RING_FRAG,
      side:        THREE.DoubleSide,
      transparent: true,
      depthWrite:  false
    }));
    ring.renderOrder = 1;
    mesh.add(ring);
    return ring;
  }

  // The Sun's corona: a billboard, because it has to scale with the disc and
  // reaches ~1300 px across from close range, well past any gl_PointSize limit.
  function buildCorona(pos) {
    var sz = 128, c = sz / 2;
    var canvas = document.createElement('canvas');
    canvas.width = sz; canvas.height = sz;
    var ctx  = canvas.getContext('2d');
    var grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255, 245, 210, 0.99)');
    grad.addColorStop(1, 'rgba(255, 220, 190, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, sz, sz);

    var glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map:         solarTexture(new THREE.CanvasTexture(canvas)),
      blending:    THREE.AdditiveBlending,
      depthTest:   true,
      depthWrite:  false,
      transparent: true
    }));
    glow.renderOrder = 2;
    glow.position.copy(pos);
    sunGroup.add(glow);
    return glow;
  }

  // Every other body, in one draw call, drawn by the shared star material: a fixed
  // DOT_PX on screen carrying the redshift catalogue's own sprite, so a distant
  // planet looks like one more particle rather than a star. Only its alpha varies,
  // through the customColor attribute the material's vertex shader reads.
  //
  // Points rather than billboards because the rasteriser snaps a point to the
  // pixel grid, so every body gets identical coverage; a small quad lands on a
  // different sub-pixel offset for each one and their brightnesses diverge.
  function buildDots() {
    var bodies = records.filter(function(rec) { return !rec.isSun; });
    if (!bodies.length) return;

    var pos = new Float32Array(bodies.length * 3);
    dotColors = new Float32Array(bodies.length * 4);
    bodies.forEach(function(rec, i) {
      rec.pos.toArray(pos, i * 3);
      dotColors[i * 4] = dotColors[i * 4 + 1] = dotColors[i * 4 + 2] = 1;
      rec.dotIndex = i;
    });

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('customColor', new THREE.BufferAttribute(dotColors, 4));
    geo.computeBoundingSphere();   // nothing moves after load

    dots = new THREE.Points(geo, createStarMaterial(2 * DOT_PX));
    // Before the bodies (renderOrder 0/1), not after: the dots cannot depth-test
    // -- a body writes depth at its surface and would kill the dot at its own
    // centre -- so ordering is what occludes them. Drawing first is also right in
    // the interesting case: a far planet's dot lying in front of a near planet's
    // disc should be hidden, and now is.
    dots.renderOrder = -1;
    sunGroup.add(dots);
  }

  // Sampled backward in time over one period, fading to nothing at the tail.
  // Sampling in *time* (not eccentric anomaly) makes the fade linear in time,
  // needs no special case for the Moon's non-closing path, and gives Earth's
  // true wobbling path for free.
  //
  // A satellite's trail is drawn about its primary's *current* position. Left
  // heliocentric, the Moon's path over one sidereal month is simply Earth's
  // orbital arc — 35 million km across, with the 0.38 million km lunar loop an
  // invisible ripple on it. Anchored to Earth it becomes the real ellipse.
  //
  // Such a trail also gets its own local origin, the offset carried by
  // line.position rather than baked into every vertex. The Moon's loop spans
  // 1.25e-14 Mpc about a heliocentric coordinate of 4.2e-12, an extent just
  // 3e-3 of the magnitude it would be stored on, which quantises away to a stub
  // arc. Centred on zero it uses the full mantissa, and three composes the
  // large offset into a small camera-relative translation in float64.
  function buildTrail(body) {
    var period = trailPeriodDays(body);
    if (!period) return;
    var centre = body.orbit.center ? bodyById[body.orbit.center] : null;
    var anchor = centre ? positionAt(centre, epochDays) : null;
    var N   = TRAIL_SEGMENTS;
    var pos = new Float32Array(N * 3);
    var col = new Float32Array(N * 4);
    for (var k = 0; k < N; ++k) {
      var t = epochDays - k * period / N;
      var p = positionAt(body, t);
      if (centre) p.sub(positionAt(centre, t));   // relative to the primary
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      col[k * 4] = 1; col[k * 4 + 1] = 1; col[k * 4 + 2] = 1;
      col[k * 4 + 3] = 1 - k / N;   // 1 at the body, 0 one revolution back
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    // itemSize MUST be 4: three.js enables USE_COLOR_ALPHA (and so
    // `diffuseColor *= vColor` including alpha) only for a 4-component colour
    // attribute. With 3 components the fade is silently dropped.
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));

    var line = new THREE.Line(geo, createOrbitLineMaterial(ORBIT_MAX_ALPHA));
    if (anchor) line.position.copy(anchor);
    line.renderOrder = 3;
    line.visible     = _radarVisible;
    sunGroup.add(line);
    trails.push(line);
  }

  function loadBody(body) {
    var isSun  = body.id === 'sun';
    var radius = (body.diam / 2) * KM_TO_MPC;
    var pos    = positionAt(body, epochDays);

    // A spacecraft gets no mesh and no material: 5 m across it is sub-pixel at
    // every zoom this scene reaches, and there is no surface map to put on it. It
    // exists as a dot, a label and a trail, which is all `records` needs.
    var mesh = null;
    if (!isEscaping(body)) {
      mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 5),
                            makeBodyMaterial(body));
      mesh.position.copy(pos);
      mesh.renderOrder = isSun ? 1 : 0;
      // Real axial tilt and spin phase, for every body including Earth: local +Z
      // to the IAU north pole, local +X to the prime meridian at angle W(d).
      if (body.pole) applyPoleOrientation(mesh, body.pole, epochDays);
      sunGroup.add(mesh);
    }

    var ring = body.ring ? buildRing(body, mesh) : null;
    buildTrail(body);

    var rec = {
      name:      body.name,
      mesh:      mesh,        // null for a spacecraft
      pos:       pos,         // heliocentric; what the dot is built from
      glow:      isSun ? buildCorona(pos) : null,
      radius:    radius,
      worldPos:  sunGroup.position.clone().add(pos),
      // -pos is the direction to the Sun: sunGroup's origin IS the Sun.
      sunDir:    isSun ? new THREE.Vector3() : pos.clone().negate().normalize(),
      isSun:     isSun,
      dist:      0,
      rPx:       0
    };
    records.push(rec);
    if (isSun) sunRec = rec;
    // Nothing moves after load, so the label layer's copy of worldPos is final.
    //
    // No zoom window: these bodies are drawn at FLOORED screen sizes, so apparent
    // diameter stops describing what is on screen -- Neptune's disc is 2e-3 px
    // from Earth while its dot is DOT_PX. The whole group is switched off instead
    // by the setGroupAlpha below, one decade before the far plane.
    //
    // The Sun is ranked as the STAR it is, not by its disc, because it is the one
    // object in the scene that belongs to both classes -- the star catalogue also
    // carries it, as row 0. Ranked by size it would sort below every star the
    // moment you left the planets, and lose its name to whichever one happened to
    // overlap it. On the shared magnitude scale it instead wins out to 0.655 pc and
    // then yields to Sirius -- which is exactly what the sky does, since the Sun is
    // a tenth of Sirius's luminosity and Sirius is only 2.64 pc away.
    labels.add(body.name, rec.worldPos, radius, {
      group:       'solar',
      sliced:      false,   // a wedge cut through the planets would be nonsense
      minRank:     0,
      maxDiamFrac: Infinity,
      rank:        isSun ? magnitudeRank(SUN_ABSMAG) : undefined
    });
    // The ring never moves, so its pole is fixed; only the camera swings across
    // the ring plane. Holding the record avoids a second copy of worldPos.
    if (ring) {
      rings.push({
        ring: ring, rec: rec,
        pole: new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion)
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------

  // Nothing here moves after load, so this runs once. rec.sunDir was derived in
  // loadBody (the direction to the Sun is just -position, since sunGroup's
  // origin IS the Sun); the shaders and the phase angle both read it from there.
  function updateSunDirs() {
    records.forEach(function(rec) {
      if (!rec.mesh) return;                   // spacecraft: no surface to light
      var u = rec.mesh.material.uniforms.uSunDir;
      if (u) u.value.copy(rec.sunDir);
    });
    rings.forEach(function(r) {
      // Into the ring's own frame, where the pole is +Z, so the shader's
      // Lambert term is just abs(uSunDirLocal.z) and the shadow axis is direct.
      _sunDir.copy(r.rec.sunDir)
        .applyQuaternion(_invQuat.copy(r.rec.mesh.quaternion).invert());
      r.ring.material.uniforms.uSunDirLocal.value.copy(_sunDir);
    });
  }

  // Per *rendered* frame (the RAF loop is stop-on-idle): size the Sun's corona,
  // set each dot's alpha, place the labels, and derive the near plane.
  function updateSolarFrame() {
    if (!records.length) return;
    var halfFov  = SOLAR_CAM_FOV * DEG2RAD / 2;
    var pxPerRad = viewportHeight / (2 * Math.tan(halfFov));
    var camPos   = solarCamera.position;
    var nearest  = Infinity;

    // The overlay fades out over the last decade before its own far plane, so
    // nothing it draws is ever CLIPPED by that plane -- which is what made the
    // Sun's label vanish mid-air. Derived from SOLAR_CAM_FAR, so the two cannot
    // drift apart. The range means something: 1 pc, where the Sun is as bright as
    // Vega, to 10 pc, where it is an ordinary magnitude 4.8 star. Its own row in
    // the star catalogue has been carrying it since 20 AU.
    var fade = 1 - Math.log10(sunRec.worldPos.distanceTo(camPos)
                              / (0.01 * SOLAR_CAM_FAR));
    fade = Math.min(1, Math.max(0, fade));
    labels.setGroupAlpha('solar', fade);
    trails.forEach(function(t) { t.material.opacity = ORBIT_MAX_ALPHA * fade; });

    records.forEach(function(rec) {
      var dist = rec.worldPos.distanceTo(camPos);
      rec.dist = dist;
      rec.rPx  = rec.radius / dist * pxPerRad;
      nearest  = Math.min(nearest, dist - rec.radius);

      updateBodyFace(rec, dist < rec.radius);
      // A mesh below half a pixel covers a sample only intermittently as the
      // camera moves, which reads as blinking -- the Sun's is 0.013 px at 200 AU
      // and was still being submitted. Its dot has already faded in by then
      // (alpha goes as 1 - rPx), so the two are complementary by construction.
      if (rec.mesh) rec.mesh.visible = rec.rPx > 0.5;

      if (rec.isSun) {
        // Floor it on screen so the Sun still reads from Neptune, then dim it by
        // exactly how much that floor inflated it. This is the redshift
        // catalogue's own pairing (max size, min alpha), and linear rather than
        // squared for the same reason: strict conservation would collapse it as
        // 1/d^4, where this lingers -- 0.37 at 20 AU, 0.07 at 100 -- and hands
        // over to the Sun's own row in the star catalogue, which is a saturated
        // dot from 20 AU out. One law, no extra constant.
        var truePx = rec.rPx * SUN_GLOW_SCALE;
        var w = Math.max(truePx, SUN_GLOW_MIN_PX) / pxPerRad * dist;
        rec.glow.scale.set(2 * w, 2 * w, 1);
        rec.glow.material.opacity = Math.min(truePx / SUN_GLOW_MIN_PX, 1) * fade;
        return;
      }
      // Every other body is one point in `dots`, at a fixed DOT_PX, so only its
      // alpha changes: full while the body is too small to rasterise, fading out
      // over the last pixel before its own disc takes over. Deliberately not
      // flux-conserving (real flux falls as rPx^2 and the planet would vanish) and
      // carrying no phase term, so it stays visible from its night side. The fade
      // width is a resolution threshold, not a tunable, so DOT_PX sets the dot's
      // size without also setting how long it lingers.
      dotColors[rec.dotIndex * 4 + 3] = DOT_ALPHA * Math.max(0, 1 - rec.rPx) * fade;
    });
    if (dots) dots.geometry.attributes.customColor.needsUpdate = true;

    updateRingFacing(camPos);
    // The heliosphere is centred on the Sun, so it fades on the Sun's distance --
    // already measured above, so this costs one call and no new geometry maths.
    if (helio) helio.update(sunRec.dist, pxPerRad);

    // z-buffer precision is set by the NEAR plane, not the far one. Left at
    // 1e-17 a body a few pixels across gets only a handful of depth levels
    // (Jupiter at 0.1 AU: 3), so its trail z-fights against it. Tracking the
    // nearest body instead gives ~1e5 levels.
    //
    // The ceiling must stay at 1e-6 of the far plane. three builds
    // m10 = (far+near)/(near-far), and below about 6e-8 that rounds to exactly -1
    // in float32, which collapses the far-plane clip test to `d <= d` and DELETES
    // the far plane: the Sun then draws at any distance. 1e-8 was tried and did
    // exactly that. With SOLAR_CAM_FAR at 10 pc the ceiling is 2 AU, small enough
    // that the heliosphere's tail wall is never clipped either.
    var near = Math.min(Math.max(nearest * 0.5, SOLAR_CAM_NEAR), SOLAR_CAM_FAR * 1e-6);
    if (near !== solarCamera.near) {
      solarCamera.near = near;
      solarCamera.updateProjectionMatrix();
    }
  }

  // Fly inside a body and you should see its inner surface, not vanish into an
  // invisible shell (FrontSide culls the far hemisphere, which is the only one in
  // front of you once you are within the radius).
  //
  // `side` is the one thing here that costs anything: three puts FLIP_SIDED in the
  // program cache key, so changing it recompiles the shader. Hence the guard --
  // it is written only on an actual crossing, at most once per entry or exit, and
  // never per frame. uAlpha, uAmbient and depthWrite are plain state, free to set.
  function updateBodyFace(rec, inside) {
    if (!rec.mesh) return;                       // spacecraft have no surface
    var mat  = rec.mesh.material;
    var want = inside ? THREE.BackSide : THREE.FrontSide;
    if (mat.side !== want) { mat.side = want; mat.needsUpdate = true; }

    mat.uniforms.uAlpha.value = inside ? INSIDE_ALPHA : 1.0;
    // Unlit inside: uAmbient already scales the whole Lambert term, so driving it
    // to 1 shows the flat map with no new shader branch. The Sun has no LIT define
    // and so no uAmbient at all.
    if (mat.uniforms.uAmbient) {
      mat.uniforms.uAmbient.value = inside ? 1.0 : BODY_AMBIENT;
    }
    // A faint shell must not hide what is behind it -- including the far side of
    // its own orbit trail.
    mat.depthWrite = inside ? false : !rec.isSun;
  }

  // The viewer is on one side of the ring plane or the other -- a single sign
  // test for the whole ring, not a per-fragment quantity. Seen from the shaded
  // face a ring is much darker, since it is lit only by what gets through.
  function updateRingFacing(camPos) {
    rings.forEach(function(r) {
      // sunSide is already the local-frame z; r.pole is that same local +Z in
      // world space, fixed at build time, so dotting the world-space view
      // vector with it compares like with like.
      var sunSide  = r.ring.material.uniforms.uSunDirLocal.value.z;
      var viewSide = _toCam.subVectors(camPos, r.rec.worldPos).dot(r.pole);
      r.ring.material.uniforms.uUnlitFace.value =
        (sunSide * viewSide > 0) ? 1.0 : RING_UNLIT_FACE;
    });
  }

  function applyRadarVisibility() {
    trails.forEach(function(t) { t.visible = _radarVisible; });
    labels.setGroupVisible('solar', _radarVisible);
  }

  function solarPass(threeRenderer, mainCamera) {
    if (!_visible) return;
    solarCamera.quaternion.copy(mainCamera.quaternion);
    solarCamera.position.copy(mainCamera.position);
    solarCamera.updateMatrixWorld();
    updateSolarFrame();
    threeRenderer.clearDepth();
    threeRenderer.render(solarScene, solarCamera);
  }

  unrenderObj.onAfterToneMap(solarPass);

  // Every map has exactly one owning material, so it goes with that material.
  function disposeMaterial(mat) {
    if (!mat) return;
    var u = mat.uniforms;
    if (u) {
      ['tEquirect', 'tClouds', 'tRing'].forEach(function(k) {
        if (u[k] && u[k].value) u[k].value.dispose();
      });
    } else if (mat.map) {
      mat.map.dispose();
    }
    mat.dispose();
  }

  return {
    setVisible: function(v) { _visible = v; markDirty(); },
    // Orbit trails and name labels, driven by the same radar toggle as the
    // cosmological ruler rings. Safe to call before the manifest resolves.
    setRadarVisible: function(v) {
      _radarVisible = v;
      applyRadarVisibility();
      markDirty();
    },
    dispose: function() {
      unrenderObj.offAfterToneMap(solarPass);
      records.forEach(function(rec) {
        if (rec.mesh) {
          rec.mesh.traverse(function(o) {        // picks up Saturn's ring child
            if (o.geometry) o.geometry.dispose();
            disposeMaterial(o.material);
          });
          sunGroup.remove(rec.mesh);
        }
        if (rec.glow) {                          // the Sun's corona; the rest are `dots`
          sunGroup.remove(rec.glow);
          disposeMaterial(rec.glow.material);
        }
      });
      if (helio) { helio.dispose(); helio = null; }
      trails.forEach(function(t) {
        sunGroup.remove(t);
        t.geometry.dispose();
        t.material.dispose();
      });
      solarScene.remove(sunGroup);
      if (dots) {
        sunGroup.remove(dots);
        dots.geometry.dispose();
        disposeMaterial(dots.material);
        dots = null; dotColors = null;
      }
      records = []; sunRec = null;
      trails = []; rings = []; bodyById = {}; orbitMats = {};
    }
  };
}
