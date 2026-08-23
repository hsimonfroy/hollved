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
 * pass only billboards ~10 labels/glows and updates the near plane.
 */
import * as THREE from 'three';
import config from '../../config.js';
import { raDec2UnitVec } from './coordUtils.js';
import { createOrbitLineMaterial, makeRadarLabel } from './radarStyle.js';

var KM_TO_MPC = 1 / 3.085677581e19; // 1 km in Mpc
var AU_TO_MPC = 1 / 2.06264806e11;  // 1 AU in Mpc
var DEG2RAD   = Math.PI / 180;
var J2000_JD  = 2451545.0;

var SOLAR_CAM_NEAR = 1e-17; // Mpc — floor for the dynamic near plane
var SOLAR_CAM_FAR  = 1e-6;  // Mpc — ~206 AU, comfortably past Neptune
var SOLAR_CAM_FOV  = 70;

// Earth's centre relative to the Earth-Moon barycentre, which is what JPL's
// "EM Bary" elements actually describe: m_moon / (m_earth + m_moon).
var EMB_FACTOR = 0.012150585;

// Brightness. Rendering constants, not physical data, so they live here and not
// in the manifest. The Sun's 6.0 was previously hardcoded inside FRAG_SUN; the
// planets never had a knob at all (their lit side was pinned to the raw texture
// value, with uAmbient only lifting the dark side).
var SUN_BRIGHTNESS  = 6.0;
var BODY_BRIGHTNESS = 1.7;
var BODY_AMBIENT    = 0.2;

// Glow sprites. Bodies stay true-to-scale, so a distant planet is sub-pixel and
// produces no fragments at all; the glow is what keeps it visible, as a star
// rather than an inflated disc.
var SUN_GLOW_SCALE  = 14;  // corona: glow radius = sun radius x this
var BODY_GLOW_SCALE = 1.5;
var GLOW_MIN_PX     = 1.5; // on-screen glow radius floor
var BODY_GLOW_ALPHA = 1.0;

// Orbit trails: sampled backward in time over one period, fading to nothing.
var TRAIL_SEGMENTS  = 512;
var ORBIT_MAX_ALPHA = 0.5; // alpha at the body; renders post-tone-map onto LDR

var RING_SEGMENTS = 256;
var RING_PENUMBRA = 0.03; // shadow edge softness, in planet radii
var RING_UNLIT_FACE = 0.35; // dimming when viewed from the shaded face

// Labels. Size never encodes anything: every label is LABEL_PX on screen at any
// zoom, and overlap is resolved by hiding the loser (the standard planetarium
// approach). Shrinking distant labels instead, as this used to, is both
// undiscriminating -- at 41 AU the Sun, Jupiter and Neptune all landed within a
// pixel of each other -- and least legible exactly where names matter most.
var LABEL_PX            = 16;   // on-screen text height, in pixels
var LABEL_FILL_ALPHA    = 0.8;
var LABEL_OUTLINE_ALPHA = 0.8;
// Depth cue: fade relative to the NEAREST labelled body, not to an absolute
// distance. An absolute fade would dim everything uniformly once zoomed out,
// reproducing the very problem the size falloff had.
var LABEL_FADE_POWER    = 0.4;
var LABEL_MIN_ALPHA     = 0.35;
var LABEL_PAD_PX        = 2;    // gap required between two label boxes
var LABEL_FALLBACK_EM   = 0.55; // per-character width before troika has synced

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
  '  gl_FragColor = vec4(min(color * uBrightness, vec3(1.0)), 1.0);',
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
// All of this works in PLANET RADII, deliberately. Ring radii in Mpc are ~4e-15
// and length() squares them to ~1e-29, which underflows below full float32 --
// the same trap that turned every body into a flat NaN-UV disc. As ratios the
// ring spans 1.28..2.41 and the shadow cylinder has radius exactly 1.
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
  '}'
].join('\n');

function makeGlowTexture() {
  var sz = 128, c = sz / 2;
  var canvas = document.createElement('canvas');
  canvas.width = sz; canvas.height = sz;
  var ctx  = canvas.getContext('2d');
  var grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,245,210,0.5)');
  grad.addColorStop(1, 'rgba(255,120,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, sz, sz);
  return new THREE.CanvasTexture(canvas);
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

export default function createSolarRenderer(unrenderObj, markDirty) {
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
  var records   = [];   // one per body: mesh, glow, label, cached world position
  var trails    = [];
  var rings     = [];
  var _visible  = true;
  var _radarVisible = false; // may be set before the manifest resolves

  var viewportWidth  = container.clientWidth  || 800;
  var viewportHeight = container.clientHeight || 600;
  var _camUp  = new THREE.Vector3();
  var _sunDir = new THREE.Vector3();
  var _pole   = new THREE.Vector3();
  var _invQuat = new THREE.Quaternion();
  var _toCam  = new THREE.Vector3();
  var _ndc    = new THREE.Vector3();
  var _fwd    = new THREE.Vector3();
  var _order  = [];   // records sorted by apparent size; sorted in place, never reallocated
  var _placed = [];   // accepted label boxes this frame, with _placedCount live entries
  var _placedCount = 0;
  var maxAniso = unrenderObj.renderer().capabilities.getMaxAnisotropy();

  unrenderObj.onResize(function() {
    viewportWidth  = container.clientWidth  || 800;
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

      m.bodies.forEach(loadBody);
      updateSunDirs();
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

  function trailPeriodDays(body) {
    if (!body.orbit) return 0;
    return body.orbit.periodDays || (body.orbit.mDot ? 360 / body.orbit.mDot : 0);
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  function loadTex(file) {
    var tex = new THREE.TextureLoader().load(
      config.dataUrl + 'aux/solar/' + file, function() { markDirty(); });
    tex.colorSpace      = THREE.SRGBColorSpace;
    tex.wrapS           = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.minFilter       = THREE.LinearFilter;
    tex.anisotropy      = maxAniso;
    return tex;
  }

  function makeBodyMaterial(body) {
    var isSun    = body.id === 'sun';
    var uniforms = {
      tEquirect:   { value: loadTex(body.id + '.jpg') },
      uBrightness: { value: isSun ? SUN_BRIGHTNESS : BODY_BRIGHTNESS }
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
      // Sun must not write depth: the glow (renderOrder 2) depth-tests against
      // planet depths only, so it can render over the sun's own surface.
      depthWrite:  !isSun,
      // Sun goes into the transparent pass so mesh.renderOrder takes effect.
      transparent: isSun
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
        uAmbient:     { value: BODY_AMBIENT },
        uBrightness:  { value: BODY_BRIGHTNESS }
      },
      vertexShader:   RING_VERT,
      fragmentShader: RING_FRAG,
      side:        THREE.DoubleSide,
      transparent: true,
      depthWrite:  false
    }));
    ring.renderOrder = 1;
    mesh.add(ring);
    rings.push({
      ring: ring, mesh: mesh,
      worldPos: sunGroup.position.clone().add(mesh.position)
    });
  }

  function buildGlow(pos) {
    var glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map:         makeGlowTexture(),
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

  // Lives in solarScene rather than sunGroup: repositioned in world space each
  // frame, and worldPos is precomputed because nothing moves after load.
  function buildLabel(body) {
    var label = makeRadarLabel(body.name, 1.0, markDirty);
    label.frustumCulled = false;
    label.visible       = _radarVisible;
    solarScene.add(label);
    return label;
  }

  function loadBody(body) {
    var isSun  = body.id === 'sun';
    var radius = (body.diam / 2) * KM_TO_MPC;
    var pos    = positionAt(body, epochDays);

    var mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 5),
                              makeBodyMaterial(body));
    mesh.position.copy(pos);
    mesh.renderOrder = isSun ? 1 : 0;
    // Real axial tilt and spin phase, for every body including Earth: local +Z
    // to the IAU north pole, local +X to the prime meridian at angle W(d).
    if (body.pole) applyPoleOrientation(mesh, body.pole, epochDays);
    sunGroup.add(mesh);

    if (body.ring) buildRing(body, mesh);
    buildTrail(body);

    var rec = {
      name:      body.name,
      mesh:      mesh,
      glow:      buildGlow(pos),
      label:     buildLabel(body),
      radius:    radius,
      worldPos:  sunGroup.position.clone().add(pos),
      glowScale: isSun ? SUN_GLOW_SCALE : BODY_GLOW_SCALE,
      glowFades: !isSun,
      dist:      0,
      rPx:       0,
      box:       [0, 0, 0, 0]   // reused every frame; never reallocated
    };
    records.push(rec);
    _order.push(rec);
  }

  // ---------------------------------------------------------------------------
  // Per-frame
  // ---------------------------------------------------------------------------

  // Bodies sit relative to sunGroup, whose origin IS the Sun, so the direction
  // to the Sun is simply -position.
  function updateSunDirs() {
    records.forEach(function(rec) {
      var u = rec.mesh.material.uniforms.uSunDir;
      if (u) u.value.copy(rec.mesh.position).negate().normalize();
    });
    rings.forEach(function(r) {
      // Into the ring's own frame, where the pole is +Z, so the shader's
      // Lambert term is just abs(uSunDirLocal.z) and the shadow axis is direct.
      _sunDir.copy(r.mesh.position).negate().normalize()
        .applyQuaternion(_invQuat.copy(r.mesh.quaternion).invert());
      r.ring.material.uniforms.uSunDirLocal.value.copy(_sunDir);
    });
  }

  // Per *rendered* frame (the RAF loop is stop-on-idle): billboard the glows,
  // place the labels, and derive the near plane. Two passes, because the label
  // declutter has to sort by apparent size first.
  function updateSolarFrame() {
    if (!records.length) return;
    var halfFov  = SOLAR_CAM_FOV * DEG2RAD / 2;
    var pxPerRad = viewportHeight / (2 * Math.tan(halfFov));
    var camPos   = solarCamera.position;
    var nearest  = Infinity;
    var nearestLabel = Infinity;
    _fwd.set(0, 0, -1).applyQuaternion(solarCamera.quaternion);

    records.forEach(function(rec) {
      var dist = rec.worldPos.distanceTo(camPos);
      rec.dist = dist;
      rec.rPx  = rec.radius / dist * pxPerRad;
      nearest  = Math.min(nearest, dist - rec.radius);
      if (dist < nearestLabel) nearestLabel = dist;

      // Bodies stay true-to-scale, so a distant one is sub-pixel and rasterises
      // to nothing. Flooring the *glow* keeps it visible as a star without
      // inflating the body, and fading the glow once the disc resolves keeps it
      // from washing the surface out.
      var gW = Math.max(rec.rPx * rec.glowScale, GLOW_MIN_PX) / pxPerRad * dist;
      rec.glow.scale.set(2 * gW, 2 * gW, 1);
      rec.glow.material.opacity = rec.glowFades
        ? BODY_GLOW_ALPHA * GLOW_MIN_PX / (rec.rPx + GLOW_MIN_PX)
        : 1;
    });

    placeLabels(pxPerRad, nearestLabel, camPos);
    updateRingFacing(camPos);

    // z-buffer precision is set by the NEAR plane, not the far one. Left at
    // 1e-17 a body a few pixels across gets only a handful of depth levels
    // (Jupiter at 0.1 AU: 3), so its trail z-fights against it. Tracking the
    // nearest body instead gives ~1e5 levels.
    var near = Math.min(Math.max(nearest * 0.5, SOLAR_CAM_NEAR), SOLAR_CAM_FAR * 1e-6);
    if (near !== solarCamera.near) {
      solarCamera.near = near;
      solarCamera.updateProjectionMatrix();
    }
  }

  // The viewer is on one side of the ring plane or the other -- a single sign
  // test for the whole ring, not a per-fragment quantity. Seen from the shaded
  // face a ring is much darker, since it is lit only by what gets through.
  function updateRingFacing(camPos) {
    rings.forEach(function(r) {
      // sunSide is already the local-frame z; local +Z maps to the world pole,
      // so dotting the world-space view vector with that pole compares like
      // with like.
      _pole.set(0, 0, 1).applyQuaternion(r.mesh.quaternion);
      var sunSide  = r.ring.material.uniforms.uSunDirLocal.value.z;
      var viewSide = _toCam.copy(camPos).sub(r.worldPos).dot(_pole);
      r.ring.material.uniforms.uUnlitFace.value =
        (sunSide * viewSide > 0) ? 1.0 : RING_UNLIT_FACE;
    });
  }

  // Greedy screen-space decluttering. Labels are a constant LABEL_PX tall, so
  // two of them collide whenever their bodies are close on screen -- Earth and
  // the Moon are 1.2 px apart at 1 AU. Walk the bodies largest-apparent-size
  // first and drop any label whose box hits one already placed. Apparent size
  // is the right priority because it needs no authored ranking and adapts: the
  // Sun wins the inner cluster from far away, Earth beats the Moon at normal
  // range, and the Moon beats Earth once you are alongside it.
  function placeLabels(pxPerRad, nearestLabel, camPos) {
    if (!_radarVisible) {
      records.forEach(function(rec) { rec.label.visible = false; });
      return;
    }
    var labelK = LABEL_PX / pxPerRad;   // world size per unit distance
    var halfW  = viewportWidth  / 2;
    var halfH  = viewportHeight / 2;
    _camUp.set(0, 1, 0).applyQuaternion(solarCamera.quaternion);

    _order.sort(function(a, b) { return b.rPx - a.rPx; });
    _placedCount = 0;

    for (var i = 0; i < _order.length; ++i) {
      var rec  = _order[i];
      var size = labelK * rec.dist;

      rec.label.scale.setScalar(size);
      rec.label.quaternion.copy(solarCamera.quaternion);
      rec.label.position.copy(rec.worldPos)
        .addScaledVector(_camUp, rec.radius + size * 0.9);

      // Behind the camera project() mirrors the point, which would strand the
      // label on the wrong side of the screen.
      _ndc.copy(rec.label.position);
      if (_ndc.sub(camPos).dot(_fwd) <= 0) { rec.label.visible = false; continue; }

      _ndc.copy(rec.label.position).project(solarCamera);
      var cx = _ndc.x * halfW, cy = _ndc.y * halfH;
      var box = labelBox(rec, cx, cy);

      var clash = false;
      for (var j = 0; j < _placedCount && !clash; ++j) {
        var q = _placed[j];
        clash = box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1];
      }
      rec.label.visible = !clash;
      if (clash) continue;
      _placed[_placedCount++] = box;

      // Depth cue relative to the nearest labelled body, so it works at every
      // zoom rather than dimming the whole scene once you pull back.
      var alpha = Math.pow(nearestLabel / rec.dist, LABEL_FADE_POWER);
      alpha = Math.min(1, Math.max(LABEL_MIN_ALPHA, alpha));
      rec.label.fillOpacity    = LABEL_FILL_ALPHA    * alpha;
      rec.label.outlineOpacity = LABEL_OUTLINE_ALPHA * alpha;
    }
  }

  // Screen-space box in pixels, centred on the label anchor. fontSize is 1 and
  // the label is scaled to LABEL_PX on screen, so troika's blockBounds -- which
  // are in em -- convert straight to pixels with no corner projection.
  function labelBox(rec, cx, cy) {
    var info = rec.label.textRenderInfo;
    var w, h;
    if (info && info.blockBounds) {
      w = (info.blockBounds[2] - info.blockBounds[0]) * LABEL_PX;
      h = (info.blockBounds[3] - info.blockBounds[1]) * LABEL_PX;
    } else {                       // troika syncs asynchronously
      w = LABEL_FALLBACK_EM * rec.name.length * LABEL_PX;
      h = LABEL_PX;
    }
    w = w / 2 + LABEL_PAD_PX;
    h = h / 2 + LABEL_PAD_PX;
    var box = rec.box;
    box[0] = cx - w; box[1] = cy - h; box[2] = cx + w; box[3] = cy + h;
    return box;
  }

  function applyRadarVisibility() {
    trails.forEach(function(t) { t.visible = _radarVisible; });
    records.forEach(function(r) { r.label.visible = _radarVisible; });
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
        rec.mesh.traverse(function(o) {          // picks up Saturn's ring child
          if (o.geometry) o.geometry.dispose();
          disposeMaterial(o.material);
        });
        sunGroup.remove(rec.mesh);
        sunGroup.remove(rec.glow);
        disposeMaterial(rec.glow.material);
        solarScene.remove(rec.label);
        rec.label.dispose();
      });
      trails.forEach(function(t) {
        sunGroup.remove(t);
        t.geometry.dispose();
        t.material.dispose();
      });
      solarScene.remove(sunGroup);
      records = []; _order = []; _placed = []; _placedCount = 0;
      trails = []; rings = []; bodyById = {}; orbitMats = {};
    }
  };
}
