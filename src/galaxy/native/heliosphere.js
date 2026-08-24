/**
 * The heliosphere: the bubble the solar wind blows in the local interstellar
 * medium — the boundary Voyager 1 crossed in 2012 and Voyager 2 in 2018, both of
 * which are in this scene on real trajectories.
 *
 * Lives in solarRenderer's sunGroup, whose origin IS the Sun, so the mesh needs
 * no position: only the rotation that puts its axis on the nose direction.
 *
 * That axis is the Sun's motion relative to the LOCAL INTERSTELLAR CLOUD
 * (~26 km/s, RA 255.0 Dec -17.6, in Scorpius). It is 86 deg from the direction of
 * our galactic orbit and 52 deg from the solar apex, so this surface says nothing
 * about where the solar system is heading around the Milky Way.
 */
import * as THREE from 'three';
import { createShellMaterial } from './radarStyle.js';
import { raDec2UnitVec } from './coordUtils.js';

var AU_TO_MPC = 1 / 2.06264806e11;

// -----------------------------------------------------------------------------
// Shape: the envelope of spheres laid down the tail axis, whose radius grows from
// the nose standoff toward TAIL_RADIUS_AU:
//
//   r(u) = R0 + (W - R0) * u / (u + Zf)      u = distance down the axis
//
// The two crossings -- 121.6 AU at 30 deg from the nose, 119.0 at 53 deg -- are a
// 2% spread over 23 degrees, i.e. the upwind heliopause is a SPHERE CENTRED ON
// THE SUN. The u = 0 sphere is exactly that and stays the outermost surface out
// to 69 deg, so both crossings come out by construction rather than by fitting.
// Downstream the cross-section grows and then plateaus, matching a heliotail a
// few hundred AU wide and thousands long, open at the far end.
//
// Convex everywhere, and C1 at the cap/envelope junction. Both are asserted by
// the probe, because both are easy to break from here.
var TAIL_RADIUS_AU = 300;   // W  -- asymptotic tube radius
var FLARE_SCALE_AU = 500;   // Zf -- how fast it opens out of the nose sphere
var TAIL_LENGTH_AU = 1000;  // L  -- how far the tube runs before it closes

// The nose is the measured part, and the part you fly through, so it gets the
// density; the tail is a tube and needs almost none.
var NOSE_PTS   = 40;
var TAIL_PTS   = 80;
var CAP_PTS    = 24;
var LATHE_SEGS = 128;

// -----------------------------------------------------------------------------
// Look. All rendering, so none of it belongs in the manifest.
var SHELL_COLOR = new THREE.Vector3(0.35, 0.55, 1.0); // pale blue, against the warm Sun
var PEAK_ALPHA  = 0.03;  // at normal incidence
var LIMB_CAP    = 3.0;   // most the limb may brighten; DoubleSide doubles it again

// Tail fade: exp(z / TAIL_FADE_AU) downstream of the terminator plane, 1 upwind,
// so everything the Voyagers measured stays at full strength and only the
// disputed tail dims. Smaller = the tail disappears sooner. Baked into the
// geometry's uv.y, so the law is written in the unit it is argued about.
var TAIL_FADE_AU = 200;

// Distance fade, a SEPARATE thing: it switches the whole shell off as you zoom
// in, so the inner solar system is never washed blue. Full strength at the
// standoff, zero FADE_DECADES decades inside it -- 0.5 means "off below 38 AU".
// A large value means "never off".
var FADE_DECADES = 0.5;
var MIN_PX       = 4;    // below this apparent size, skip the draw entirely

/**
 * @param {THREE.Group}  sunGroup  solarRenderer's group, centred on the Sun
 * @param {object}       def       manifest.heliosphere: { nose:{ra,dec}, standoffAu }
 * @returns {{ update: function, dispose: function }}
 */
export default function createHeliosphere(sunGroup, def) {
  var standoffAu = def.standoffAu;

  // Built in AU and scaled down on the mesh: it keeps the vertex buffer at O(100)
  // instead of O(1e-9), and three composes the uniform scale in float64.
  var profile  = buildProfile(standoffAu);
  var geometry = new THREE.LatheGeometry(profile, LATHE_SEGS);
  var material = createShellMaterial(SHELL_COLOR.clone(), 0, LIMB_CAP);
  bakeTailFade(geometry, profile);

  var mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(AU_TO_MPC);
  // LatheGeometry revolves about local +Y, so +Y is the nose axis.
  var n = raDec2UnitVec(def.nose.ra, def.nose.dec);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
                                     new THREE.Vector3(n.x, n.y, n.z));
  // Additive and depth-testless, so order is irrelevant; -1 keeps the veil from
  // brightening the bodies drawn after it.
  mesh.renderOrder = -1;
  mesh.visible     = false;   // until the first update() decides otherwise
  sunGroup.add(mesh);

  var noseMpc   = standoffAu * AU_TO_MPC;
  var lengthMpc = (profile[0].y - profile[profile.length - 1].y) * AU_TO_MPC;

  /**
   * @param {number} dist     camera distance from the SUN, in Mpc
   * @param {number} pxPerRad viewport scale, for the too-small-to-draw cutoff
   */
  function update(dist, pxPerRad) {
    // dist = 0 gives -Infinity, which the clamp turns into 0.
    var t = Math.log10(dist / noseMpc) / FADE_DECADES + 1;
    t = Math.min(1, Math.max(0, t));
    if (lengthMpc / dist * pxPerRad < MIN_PX) t = 0;

    mesh.visible = t > 0;
    material.uniforms.uAlpha.value = PEAK_ALPHA * t;
  }

  return {
    update: update,
    dispose: function() {
      sunGroup.remove(mesh);
      geometry.dispose();
      material.dispose();
    }
  };
}

// The shell shader multiplies uv.y in as an emission weight. LatheGeometry emits
// vertices as `for each segment: for each profile point`, so a vertex's profile
// index is just `k % profile.length` — the y channel can be overwritten in place.
function bakeTailFade(geometry, profile) {
  var w = new Float32Array(profile.length);
  for (var j = 0; j < profile.length; ++j) {
    var z = profile[j].y;                     // AU along the axis, + toward the nose
    w[j] = z >= 0 ? 1 : Math.exp(z / TAIL_FADE_AU);
  }
  var uv = geometry.attributes.uv;
  for (var k = 0; k < uv.count; ++k) uv.setY(k, w[k % profile.length]);
  uv.needsUpdate = true;
}

// Radius of the swept sphere at u, its slope, and the angle at which the envelope
// leaves that sphere. |r'| < 1 is required for the envelope to exist at all, so
// FLARE_SCALE_AU must stay above TAIL_RADIUS_AU - standoff.
function sweptRadius(standoffAu, u) {
  return standoffAu + (TAIL_RADIUS_AU - standoffAu) * u / (u + FLARE_SCALE_AU);
}
function sweptSlope(standoffAu, u) {
  var d = u + FLARE_SCALE_AU;
  return (TAIL_RADIUS_AU - standoffAu) * FLARE_SCALE_AU / (d * d);
}
function tangencyAngle(standoffAu, u) {
  return Math.PI / 2 - Math.asin(sweptSlope(standoffAu, u));
}

// Profile in the XY half-plane LatheGeometry revolves: x is the distance from the
// axis, y is along it, ordered nose -> tail. Three pieces with matched tangents:
// the nose sphere out to its tangency, the envelope, and the last sphere's
// remaining cap so the mesh closes.
//
// The envelope comes from dF/du = 0 on rho^2 + (z+u)^2 - r(u)^2, which gives
// z = -u + r*r' and hence rho = r*sqrt(1-r'^2). Negating that z puts the contact
// point downstream of the sphere centre and creases the junction by 44 degrees.
//
// The ordering makes LatheGeometry's normals point inward (it derives them from
// the profile tangent, which assumes increasing y). Harmless: the shell shader
// takes abs(dot(N, V)) and the material is DoubleSide.
function buildProfile(standoffAu) {
  var pts = [];
  var i, t;

  var thTan = tangencyAngle(standoffAu, 0);
  for (i = 0; i <= NOSE_PTS; ++i) {                  // nose sphere, incl. tangency
    t = thTan * i / NOSE_PTS;
    pts.push(new THREE.Vector2(standoffAu * Math.sin(t), standoffAu * Math.cos(t)));
  }

  for (i = 1; i <= TAIL_PTS; ++i) {                  // envelope (i=0 repeats above)
    var u = TAIL_LENGTH_AU * i / TAIL_PTS;
    var r = sweptRadius(standoffAu, u), d = sweptSlope(standoffAu, u);
    pts.push(new THREE.Vector2(r * Math.sqrt(Math.max(0, 1 - d * d)), -u + r * d));
  }

  var rL = sweptRadius(standoffAu, TAIL_LENGTH_AU);  // closing cap
  var tL = tangencyAngle(standoffAu, TAIL_LENGTH_AU);
  for (i = 1; i <= CAP_PTS; ++i) {
    t = tL + (Math.PI - tL) * i / CAP_PTS;
    pts.push(new THREE.Vector2(rL * Math.sin(t), -TAIL_LENGTH_AU + rL * Math.cos(t)));
  }

  // Both poles must land exactly on the axis or Lathe leaves a pinhole.
  pts[0].x = 0;
  pts[pts.length - 1].x = 0;
  return pts;
}
