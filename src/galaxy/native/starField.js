/**
 * Everything anchored on the Sun and measured in PARSECS:
 *
 *   - ~119k real stars from HYG,
 *   - the Sky & Telescope constellation figures drawn between them, and their names,
 *   - the names of the stars worth naming,
 *   - the orbit the Sun is on around the Milky Way.
 *
 * They share a file because they share the three things that are awkward: the Sun
 * as origin (setOrigin), the split-camera transform that keeps float32 from
 * freezing when you fly up to a star, and a parsec-unit vertex buffer carried to
 * Mpc on the object's scale. Split apart, each would be duplicated three times.
 *
 * This layer fills the gap between the solar overlay and the local-group clouds,
 * and it is the one place in the scene where the third dimension is the whole
 * point: the figures are an Earth-centric projection of stars at wildly different
 * distances, so flying a few hundred parsecs pulls them apart.
 */
import * as THREE from 'three';
import config from '../../config.js';
import createStarMaterial from '../../unrender/lib/star-material.js';
import { createRteLineMaterial, LABEL_STYLE_REGION } from './radarStyle.js';
import { magnitudeRank, rankForMagnitude } from './labelLayer.js';

var PC_TO_MPC = 1e-6;

// Stars are point sources, so size follows the real one with a floor -- the same
// law the redshift catalogue uses -- rather than a chosen pixel count. One solar
// radius is 1.3e-5 px at 1 pc, so in practice every star sits at MIN_PX; the world
// size only takes over within a few AU, where a star resolves into a disc.
var STAR_RADIUS_PC = 2.2554e-8;   // 1 R_sun
var MIN_PX         = 2.0;

// The one brightness constant, measured through the shipped tone curve.
// Raising it flattens the sky toward white: the curve compresses hard at the top.
var STAR_FLUX = 1200.0;

// Faintest magnitude worth a fragment -- a cull, not a look control, so it sits
// below anything the tone curve can still show. It has to clear 11.19, or Proxima
// Centauri, the nearest star to the Sun, is not drawn at all.
var STAR_MAG_LIMIT = 12.3;

// Past this distance from the Sun the BRIGHTEST star in the catalogue is already
// fainter than STAR_MAG_LIMIT, so every vertex fails the shader's flux cull and the
// draw call puts nothing on screen -- 119,477 vertex shader runs for an empty frame.
// The cull saves the FRAGMENTS (it clips the vertex out of the clip volume, which is
// the standard way to drop a point, since GLSL has no discard in a vertex shader);
// only skipping the draw saves the vertices. Derived at load from the data and the
// limit above, so it cannot drift from either.
var starCutoffPc = Infinity;

// WHICH stars get a name. Two clauses, because "notable" is genuinely two things:
// bright enough to be a landmark in the sky, or close enough to be a neighbour.
// Neither implies the other -- Deneb is magnitude 1.3 at 433 pc, Barnard's Star is
// magnitude 9.8 at 1.8 pc -- and a rule with only the first would miss every red
// dwarf next door, which is most of what is next door. Together: 57 of 637.
//
// 2.1 mag to include POLARIS, 
// 12.3 mag to include Ross 248 the future nearest star to the Sun in 40,000 years,
// 3.3 pc to include Lacaille 9352. 
var STAR_LABEL_MAG = 2.1;
var STAR_LABEL_PC  = 3.3;
var STAR_LABEL_LIMIT_MAG = 12.3;

// ...and a second, independent retirement, on distance from the Sun. The magnitude
// rule alone cannot do this job: it has to stay faint enough to admit Proxima
// (11.19 from Earth), and that same limit lets a supergiant survive absurdly far --
// Alnilam is absolute magnitude -6.4, so it stayed named out to 50 kpc, reading as
// though it were the one star of the Milky Way. Tightening the magnitude instead
// would drop Proxima and Barnard first, which is backwards.
//
// So: full inside 1 kpc, gone by 10 kpc. One decade further out than the figures,
// because an individual star stays meaningful a little longer than an Earth-bound
// pattern drawn between several.
var STAR_LABEL_FADE_PC      = 1000;
var STAR_LABEL_FADE_DECADES = 1;

// Constellation figures: the base line's look. The colour is an argument so it
// can be split from the rest later. The figures are an annotation over the stars,
// not the subject: at any wide field a hundred segments cross the frame at once,
// so they sit below the stars they join.
//
// They render into the HDR buffer with the stars, so this is a PRE-tone-map value
// and the curve amplifies it -- at exposure 500, 6e-3 lands near 74/255. It reads
// 6e-3 rather than 3e-3 only because createLineMaterial stopped drawing every line
// twice; the number on screen is unchanged.
var LINE_ALPHA = 6e-3;
var LINE_COLOR = 0xffffff;

// A name sits this fraction of the figure's own angular radius above its centre --
// off the busiest lines without leaving the shape. At 1.0 (which is what you get by
// letting `radius` double as the offset, the body default) every label lands on its
// figure's outer edge, a median 6.8 deg out and 28.7 for Hydra, i.e. inside the
// neighbours. Median 2.4 deg here.
var REGION_LABEL_OFFSET = 0.1;

// Serpens is the ONE figure drawn in two pieces that must be named twice: its halves
// straddle Ophiuchus, so a single label sits squarely inside Ophiuchus. It is also
// the one case with real names for the pieces -- the IAU itself recognises Serpens
// Caput and Serpens Cauda. Ordered west to east, i.e. by increasing right ascension:
// the head is at RA 237 deg, the tail at 270.
//
// Deliberately a named special case rather than a general "split components more
// than N degrees apart" rule. That rule works -- the separations are bimodal, Serpens
// 37 deg and Hydra 53, then Taurus 18, Sagittarius 12, Crux 1 -- but its only other
// catch is Hydra, which is one constellation with one name and does not want two.
var SPLIT_PART_NAMES = { Ser: ['Caput', 'Cauda'] };

// The figures are a view from one place, so they stop meaning anything once you
// leave it -- but slowly, because watching them shear is the point. Full inside
// FADE_PC, gone FADE_DECADES out. Same log-decade law as the ruler rings.
var LINE_FADE_PC      = 300;
var LINE_FADE_DECADES = 1;

// ---------------------------------------------------------------------------
// The Sun's galactic orbit.
//
// It exists because the heliosphere reads as an arrow and is not one. The nose of
// that bubble is the wind from the Local Interstellar Cloud: 86.4 degrees from the
// direction of galactic rotation, and only 15.4 from the galactic centre. It is a
// sideways breeze, and nothing at all about where we are going. Where we ARE going
// is the head of this trail: RA 313.8, Dec +47.8, which is 3.5 degrees from Deneb.
//
// That is NOT the pure circular direction (u x vZ, RA 318.0 Dec +48.3, 6.1 deg from
// Deneb). The drawn curve leaves along the Sun's ACTUAL velocity, which is 2.8 deg
// off the circular one because the Sun does not move on a circle: the tilt is
// atan(hypot(U,W)/(V0+V)) = 3.1 deg, toward the galactic centre and north. A
// circle could not express that either.
//
// The orbit is NOT a circle, and the difference is measurable. Epicyclic solution
// for a flat rotation curve, with the initial conditions set to the Sun's actual
// motion, which gives kappa/Omega = sqrt(2): irrational, so the path never closes.
// Checked against a direct RK4 integration
// in a logarithmic potential -- radial range 8.10 to 9.12 kpc against the
// integrator's 8.10 to 9.17, agreeing to 0.6% -- which is why no integrator ships.
// Over the lap drawn here the tail ends 1122 pc from the head, and that gap is
// the honest part of the picture: it is what a circle would be asserting away.
var KMS_TO_PC_MYR = 1.02271;
var ORBIT_V0      = 233.0;    // local circular speed, km/s
var ORBIT_U       = 11.10;    // solar motion wrt the LSR, km/s, toward the centre
var ORBIT_V       = 12.24;    // ...in the direction of rotation
var ORBIT_W       = 7.25;     // ...toward the north galactic pole
var ORBIT_Z0_PC   = 20.8;     // the Sun's present height above the plane
var ORBIT_NU_MYR  = 74.0;     // vertical oscillation period
var ORBIT_SEGMENTS = 512;     // per lap; matches the solar trails'
// THREE laps, not one, and this is what makes the orbit legible as an orbit.
// A single lap nearly retraces itself: successive passes at the same azimuth are a
// median of only 92 pc apart (2.4 px against a 446 px ring), so a 6% radial
// eccentricity reads as a circle and the whole point is lost. Because kappa/Omega is
// sqrt(2), one azimuthal turn advances the radial phase by 0.489 cycles -- very
// nearly antiphase -- so the SECOND pass runs ~800 pc (21 px) inside or outside the
// first, and the rosette becomes obvious. Three laps also gives 9 vertical cycles
// instead of 3, which is the only way the +-90 pc wobble reads at all edge-on.
var ORBIT_LAPS     = 1.;
var ORBIT_ALPHA    = 0.5;    // pre-tone-map, alongside LINE_ALPHA
// Fades IN over the decade right after the planet trails die (the solar overlay
// is gone by 10 pc), so the two never share the frame -- which is the whole of
// "do not mix it with the orbits of the planets".
var ORBIT_FADE_PC      = 10;
var ORBIT_FADE_DECADES = 1;
// ...and retired again once the whole lap is a few pixels across, the same rule
// the heliosphere uses. Past the local group it is a sub-pixel tangle drawn over
// the catalogues, which is noise, not information.
var ORBIT_MIN_PX       = 8;

/**
 * @param {object} labels the scene-wide label layer. Star names go in its 'stars'
 *                        group, constellation names in 'regions' -- a separate
 *                        declutter set and a softer voice, because a region is not
 *                        a thing at a place.
 */
export default function createStarField(unrenderObj, markDirty, labels) {
  // Both layers live in the HDR scene, which is drawn BEFORE the solar overlay.
  // That ordering is what makes planets occlude them: the solar pass renders
  // opaque bodies into the same framebuffer afterwards. Putting the lines in
  // postScene instead -- as they first were -- draws them after the solar pass,
  // and they show straight through Jupiter.
  var scene     = unrenderObj.scene();
  var camera    = unrenderObj.camera();

  var stars   = null;
  var lines   = null;
  var lineMat = null;
  var orbit   = null;
  var names   = null;   // names.json, once fetched
  var _frame  = null;   // the Milky Way's, routed in by renderer.js
  var _originSet   = false;
  var _labelsAdded = false;
  var _visible      = true;
  var _radarVisible = false;
  var _origin = new THREE.Vector3();   // the Sun: the catalogue's true origin
  var _rel    = new THREE.Vector3();

  unrenderObj.onResize(function(h) {
    if (stars) stars.material.uniforms.uViewportHeight.value = h;
  });

  fetch(config.dataUrl + 'aux/stars/meta.json')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(meta) {
      return Promise.all([meta].concat(
        ['positions.bin', 'absmag.bin', 'colors.bin', 'lines.bin', 'names.json']
          .map(function(f) {
            return fetch(config.dataUrl + 'aux/stars/' + f).then(function(r) {
              if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
              return f.slice(-5) === '.json' ? r.json() : r.arrayBuffer();
            });
          })));
    })
    .then(function(parts) {
      names = parts[5];
      build(parts[0], parts[1], parts[2], parts[3], parts[4]);
      updateFade();
      markDirty();
    })
    .catch(function(err) { console.warn('[starField] load failed:', err); });

  function build(meta, posBuf, magBuf, colBuf, lineBuf) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position',    new THREE.BufferAttribute(new Float32Array(posBuf), 3));
    geo.setAttribute('aAbsMag',     new THREE.BufferAttribute(new Float32Array(magBuf), 1));
    geo.setAttribute('customColor', new THREE.BufferAttribute(new Uint8Array(colBuf), 3, true));
    geo.computeBoundingSphere();

    // flux ~ 10^(-0.4*M)/d^2 falls below the limit's flux at d = 10^((lim-M)/5 + 1) pc
    var mag = new Float32Array(magBuf), brightest = Infinity;
    for (var mi = 0; mi < mag.length; ++mi) if (mag[mi] < brightest) brightest = mag[mi];
    starCutoffPc = Math.pow(10, (STAR_MAG_LIMIT - brightest) / 5 + 1);

    stars = new THREE.Points(geo, createStarMaterial(2 * STAR_RADIUS_PC * PC_TO_MPC, {
      magnitude:  true,
      fluxScale:  STAR_FLUX,
      magLimit:   STAR_MAG_LIMIT,
      minPx:      MIN_PX,
      // The shader measures distance in view space, i.e. after this scale, so it
      // needs the square of the inverse to get back to parsecs.
      unitsToPc2: 1 / (PC_TO_MPC * PC_TO_MPC)
    }));
    stars.material.uniforms.uViewportHeight.value =
      unrenderObj.getContainer().clientHeight || 600;
    // onBeforeRender, not the afterToneMap pass: this feeds the vertex transform,
    // so a frame of latency would smear the whole field while the camera moves.
    stars.onBeforeRender = syncCamera;
    stars.scale.setScalar(PC_TO_MPC);
    stars.frustumCulled = false;   // the bounding sphere is in pc, the scale is not
    stars.visible = _visible;
    scene.add(stars);

    // The figures share the star position attribute outright: an endpoint IS the
    // star it names, and no coordinate is stored twice. They share the split
    // camera too -- the same uniform objects, not copies -- so the endpoint is
    // transformed exactly as the dot is and lands on it, and syncCamera below
    // feeds every material at once.
    var lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', geo.getAttribute('position'));
    lineGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(lineBuf), 1));
    lineMat = createRteLineMaterial(LINE_ALPHA, LINE_COLOR,
                                    stars.material.uniforms.uCamHi,
                                    stars.material.uniforms.uCamLo);
    lines = new THREE.LineSegments(lineGeo, lineMat);
    // Both objects sit at the same world position with the same renderOrder, so
    // three's transparent sort does not settle which is drawn first; syncing from
    // both costs one vector subtract and removes the question.
    lines.onBeforeRender = syncCamera;
    lines.scale.setScalar(PC_TO_MPC);
    lines.frustumCulled = false;
    lines.visible = false;         // until the radar toggle and the fade agree
    scene.add(lines);

    applyOrigin();
    tryDeferred();
    console.info('[starField] %d stars, %d constellation segments',
                 meta.count, meta.segments);
  }

  // The camera in the field's own parsec units, split so float32 can hold it --
  // see the relative-to-eye note in star-material.js. `_rel` is float64 here;
  // Math.fround gives exactly what the uniform will store, so the remainder is
  // exact by construction.
  function syncCamera() {
    var u = stars.material.uniforms;
    _rel.subVectors(camera.position, _origin).divideScalar(PC_TO_MPC);
    u.uCamHi.value.set(Math.fround(_rel.x), Math.fround(_rel.y), Math.fround(_rel.z));
    u.uCamLo.value.set(_rel.x - u.uCamHi.value.x,
                       _rel.y - u.uCamHi.value.y,
                       _rel.z - u.uCamHi.value.z);
  }

  function applyOrigin() {
    if (stars) stars.position.copy(_origin);
    if (lines) lines.position.copy(_origin);
    if (orbit) orbit.position.copy(_origin);
  }

  // Labels and the orbit both need the catalogue AND the Sun's true position, and
  // those arrive from two independent fetches. Waiting for both is the whole of
  // it: a label's world position is copied once at registration, so registering
  // before setOrigin would leave every star's name 1 AU off its star -- which is
  // 0.8 arcsec from Earth and irrelevant, but 45 degrees if you fly up to the star.
  function tryDeferred() {
    if (!stars || !names || !_originSet) return;
    if (!_labelsAdded) {
      _labelsAdded = true;
      addStarLabels();
      addFigureLabels();
    }
    if (_frame && !orbit) buildOrbit();
  }

  // ---- names ---------------------------------------------------------------

  function addStarLabels() {
    var pos = stars.geometry.getAttribute('position').array;
    var mag = stars.geometry.getAttribute('aAbsMag').array;
    var minRank = rankForMagnitude(STAR_LABEL_LIMIT_MAG);
    var n = 0;
    names.stars.forEach(function(s) {
      var i = s.i * 3;
      var d = Math.hypot(pos[i], pos[i + 1], pos[i + 2]);
      if (!(s.mag !== null && s.mag <= STAR_LABEL_MAG) && !(d <= STAR_LABEL_PC)) return;
      // A star is a point source: its apparent SIZE is the same floored dot for
      // every one of them, so it cannot rank them. Flux can, and it is what the
      // star actually has -- the same quantity the dot shader already culls on.
      labels.add(s.name, {
        x: _origin.x + pos[i]     * PC_TO_MPC,
        y: _origin.y + pos[i + 1] * PC_TO_MPC,
        z: _origin.z + pos[i + 2] * PC_TO_MPC
      }, STAR_RADIUS_PC * PC_TO_MPC, {
        group:       'stars',
        rank:        magnitudeRank(mag[s.i]),
        minRank:     minRank,
        maxDiamFrac: Infinity
      });
      ++n;
    });
    console.info('[starField] %d star names', n);
  }

  // A constellation is a SKY PATTERN, so its anchor is a direction question and a
  // distance question and they get different estimators.
  //
  // The direction is the plain mean of the member UNIT vectors. Robustifying it
  // makes things worse, not better -- measured against the arc-length centre of
  // the drawn segments, the mean is 0.83 deg off in the median where a spherical
  // median is 1.74. There are no outliers to reject on a sphere: a member star
  // lies in the patch of sky the figure occupies by definition, and a unit vector
  // cannot run away. The heavy tail is entirely in DISTANCE.
  //
  // Which is where the median does earn its place. Any single 3D point estimator
  // is dragged by that tail -- a plain barycentre is 2.06 deg off in the median,
  // and the 3D geometric median, the robust one, is the worst of the four at 2.42
  // -- because it minimises a radial spread that has nothing to do with where a
  // name belongs. Cepheus alone has a member at 8.4 kpc, which drags its
  // barycentre out to 934 pc; under the median every anchor lands between 18 and
  // 205 pc.
  function addFigureLabels() {
    var pos = stars.geometry.getAttribute('position').array;
    // The index is the FIGURES' -- the star geometry has none. Both share the
    // same `position` attribute, so these row numbers index straight into `pos`.
    var idx = lines.geometry.getIndex().array;
    var n = 0;

    names.constellations.forEach(function(con) {
      var parts = splitFigure(con.iau, idx, con.seg[0] * 2,
                              (con.seg[0] + con.seg[1]) * 2);
      var suffix = SPLIT_PART_NAMES[con.iau];
      // West to east, so a Serpens part gets the right one of Caput / Cauda.
      if (parts.length > 1) {
        parts.sort(function(a, b) { return meanRa(pos, a) - meanRa(pos, b); });
      }
      parts.forEach(function(rows, k) {
        var a = anchorOf(pos, rows);
        if (!a) return;
        var name = con.name;
        if (parts.length > 1 && suffix && suffix[k]) name += ' ' + suffix[k];
        labels.add(name.toUpperCase(), {
          x: _origin.x + a.dir[0] * a.dist * PC_TO_MPC,
          y: _origin.y + a.dir[1] * a.dist * PC_TO_MPC,
          z: _origin.z + a.dir[2] * a.dist * PC_TO_MPC
        }, a.rms * a.dist * PC_TO_MPC, {
          group:       'regions',
          declutter:   'regions',
          style:       LABEL_STYLE_REGION,
          minRank:     0,             // the figures' own fade retires them instead
          maxDiamFrac: Infinity,      // you are never "inside" a direction
          // A fraction of its own radius, not the whole of it: see the constant.
          offset:      a.rms * a.dist * PC_TO_MPC * REGION_LABEL_OFFSET,
          // A constellation has no depth to cue. Left in the nearest-relative fade
          // it sat at the floor everywhere inside the solar system, where the
          // nearest eligible label is a planet a hundred-thousandth as far away --
          // so the names were invisible from exactly the place the figures were
          // drawn for.
          depthFade:   false
        });
        ++n;
      });
    });
    console.info('[starField] %d constellation names', n);
  }

  // One part per figure, except for the few named in SPLIT_PART_NAMES, which are
  // broken into the connected components of their segment graph. Every other figure
  // is drawn in several strokes that belong to one shape, so splitting generally
  // would scatter names that belong together.
  function splitFigure(iau, idx, from, to) {
    var k, all;
    if (!SPLIT_PART_NAMES[iau]) {
      all = {};
      for (k = from; k < to; ++k) all[idx[k]] = 1;
      return [Object.keys(all).map(Number)];
    }
    var parent = {};
    function find(a) {
      if (parent[a] === undefined) parent[a] = a;
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    for (k = from; k < to; k += 2) {
      var ra = find(idx[k]), rb = find(idx[k + 1]);
      if (ra !== rb) parent[ra] = rb;
    }
    var byRoot = {};
    for (k = from; k < to; k += 2) {
      var r = find(idx[k]);
      if (!byRoot[r]) byRoot[r] = {};
      byRoot[r][idx[k]] = 1; byRoot[r][idx[k + 1]] = 1;
    }
    return Object.keys(byRoot).map(function(r) {
      return Object.keys(byRoot[r]).map(Number);
    });
  }

  function meanDir(pos, rows, out) {
    var x = 0, y = 0, z = 0;
    for (var i = 0; i < rows.length; ++i) {
      var k = rows[i] * 3;
      var d = Math.hypot(pos[k], pos[k + 1], pos[k + 2]);
      if (!(d > 0)) continue;
      x += pos[k] / d; y += pos[k + 1] / d; z += pos[k + 2] / d;
    }
    var l = Math.hypot(x, y, z) || 1;
    out[0] = x / l; out[1] = y / l; out[2] = z / l;
    return out;
  }

  function meanRa(pos, rows) {
    var m = meanDir(pos, rows, [0, 0, 0]);
    var ra = Math.atan2(m[1], m[0]) * 180 / Math.PI;
    return ra < 0 ? ra + 360 : ra;
  }

  // A constellation is a SKY PATTERN, so its anchor is a direction question and a
  // distance question and they get different estimators.
  //
  // The direction is the plain mean of the member UNIT vectors. Robustifying it
  // makes things worse, not better -- measured against the arc-length centre of
  // the drawn segments, the mean is 0.83 deg off in the median where a spherical
  // median is 1.74. There are no outliers to reject on a sphere: a member star
  // lies in the patch of sky the figure occupies by definition, and a unit vector
  // cannot run away. The heavy tail is entirely in DISTANCE.
  //
  // Which is where the median does earn its place. Any single 3D point estimator
  // is dragged by that tail -- a plain barycentre is 2.06 deg off in the median,
  // and the 3D geometric median, the robust one, is the worst of the four at 2.42
  // -- because it minimises a radial spread that has nothing to do with where a
  // name belongs. Cepheus alone has a member at 8.4 kpc, which drags its
  // barycentre out to 934 pc; under the median every anchor lands between 18 and
  // 205 pc.
  function anchorOf(pos, rows) {
    var dir = meanDir(pos, rows, [0, 0, 0]);
    var d = [], i, k;
    for (i = 0; i < rows.length; ++i) {
      k = rows[i] * 3;
      var r = Math.hypot(pos[k], pos[k + 1], pos[k + 2]);
      if (r > 0) d.push(r);
    }
    if (!d.length) return null;
    d.sort(function(a, b) { return a - b; });

    // rms angular radius -> a world radius, which is the figure's apparent size
    // and so its rank. Big sprawling figures outrank small tight ones, which is
    // the right order for a name that has to sit inside its own shape.
    var s2 = 0, m = 0;
    for (i = 0; i < rows.length; ++i) {
      k = rows[i] * 3;
      var rr = Math.hypot(pos[k], pos[k + 1], pos[k + 2]);
      if (!(rr > 0)) continue;
      var c = (pos[k] * dir[0] + pos[k + 1] * dir[1] + pos[k + 2] * dir[2]) / rr;
      var an = Math.acos(Math.min(1, Math.max(-1, c)));
      s2 += an * an; ++m;
    }
    return { dir: dir, dist: d[d.length >> 1], rms: Math.sqrt(s2 / Math.max(m, 1)) };
  }

  // ---- the Sun's galactic orbit --------------------------------------------

  // Built in the Milky Way's OWN frame, the one detailedGxyRenderer draws the disc
  // from, so the two cannot disagree. Deriving it from the standard galactic-pole
  // constants instead would be a second definition -- right in itself, and
  // therefore guaranteed to drift from the drawn disc the moment the manifest is
  // retuned. (It is currently 0.6 deg from those constants, worth 85 pc of height
  // at the Sun's radius, which is why the manifest's `pa` was corrected to align
  // the two exactly.)
  function buildOrbit() {
    // GC -> Sun, and the Sun's galactocentric radius, both straight from the frame
    // so the orbit's size is the same number that placed the Sun in the disc.
    var u = _origin.clone().sub(_frame.centre);
    var R0 = u.length() / PC_TO_MPC;
    u.normalize();
    var vZ = _frame.vZ.clone().normalize();
    // WATCH THE ORDER. u x vZ, not vZ x u: the Galaxy turns CLOCKWISE seen from
    // the north galactic pole. Measured against the true l=90 direction, this
    // order gives +1.0000000 and the other -1.0000000 -- flip it and we fly toward
    // Puppis instead of Cygnus.
    var tang = u.clone().cross(vZ).normalize();

    var Om   = ORBIT_V0 * KMS_TO_PC_MYR / R0;
    var kap  = Math.SQRT2 * Om;              // flat rotation curve
    var Rg   = R0 * (1 + ORBIT_V / ORBIT_V0); // angular momentum conserved
    var Omg  = ORBIT_V0 * KMS_TO_PC_MYR / Rg;
    var nu   = 2 * Math.PI / ORBIT_NU_MYR;

    // Phases fixed by the Sun's actual state: R(0)=R0, R'(0)=-U, z(0)=z0, z'(0)=W.
    var Acos = R0 - Rg, Asin = ORBIT_U * KMS_TO_PC_MYR / kap;
    var A    = Math.hypot(Acos, Asin), phi = Math.atan2(Asin, Acos);
    var Zsin = ORBIT_Z0_PC, Zcos = ORBIT_W * KMS_TO_PC_MYR / nu;
    var Z    = Math.hypot(Zsin, Zcos), psi = Math.atan2(Zsin, Zcos);
    var wob  = 2 * Omg * A / (kap * Rg);

    var T = 2 * Math.PI / Omg * ORBIT_LAPS;  // 227 Myr per guiding-centre lap
    var N = ORBIT_SEGMENTS * ORBIT_LAPS;
    var pos = new Float32Array(N * 3);
    var alp = new Float32Array(N);

    for (var k = 0; k < N; ++k) {
      var t  = -T * k / (N - 1);             // backwards: a trail is the past
      var ph = kap * t + phi;
      var R  = Rg + A * Math.cos(ph);
      // The sin(phi) term keeps theta(0) exactly 0, so the curve stays centred on
      // the galactic centre instead of being slid 650 pc sideways by the phase.
      var th = Omg * t - wob * (Math.sin(ph) - Math.sin(phi));
      var z  = Z * Math.sin(nu * t + psi);
      var c  = Math.cos(th), s = Math.sin(th);
      // Relative to the SUN, in parsecs: R0*u + z0*vZ is where the model puts it,
      // so subtracting that pins the head of the trail exactly on the Sun whatever
      // the model and the manifest disagree about (the manifest has the Sun at
      // z = 0 by construction; the model has it 20.8 pc north).
      pos[k * 3]     = R * (c * u.x + s * tang.x) + z * vZ.x - (R0 * u.x + ORBIT_Z0_PC * vZ.x);
      pos[k * 3 + 1] = R * (c * u.y + s * tang.y) + z * vZ.y - (R0 * u.y + ORBIT_Z0_PC * vZ.y);
      pos[k * 3 + 2] = R * (c * u.z + s * tang.z) + z * vZ.z - (R0 * u.z + ORBIT_Z0_PC * vZ.z);
      alp[k] = 1 - k / (N - 1);              // 1 at the Sun, 0 one lap back
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alp, 1));
    // Relative-to-eye, on the star field's OWN camera uniforms: at 8 kpc a float32
    // holds only ~200 AU, and the near end of this curve passes through the camera.
    // createOrbitLineMaterial cannot be reused -- its depthTest samples a buffer
    // the HDR pass never wrote.
    orbit = new THREE.Line(geo, createRteLineMaterial(
      ORBIT_ALPHA, LINE_COLOR,
      stars.material.uniforms.uCamHi, stars.material.uniforms.uCamLo, true));
    orbit.onBeforeRender = syncCamera;
    orbit.scale.setScalar(PC_TO_MPC);
    orbit.frustumCulled = false;
    // How big the lap is, for the sub-pixel retirement in updateFade.
    orbit.userData.spanPc = 2 * (Rg + A);
    orbit.visible = false;
    orbit.position.copy(_origin);
    scene.add(orbit);
    updateFade();
    markDirty();
  }

  // ---- fades ---------------------------------------------------------------

  // Runs after tone-mapping, so it lands on the NEXT frame -- fine while the
  // camera is moving, since that frame is always drawn anyway. The setters call
  // it directly so a toggle does not have to wait for one.
  function updateFade() {
    var on = _visible && _radarVisible;
    _rel.subVectors(camera.position, _origin).divideScalar(PC_TO_MPC);
    var d = Math.max(_rel.length(), 1e-9);

    if (lines) {
      var t = Math.log10(LINE_FADE_PC / d) / LINE_FADE_DECADES + 1;
      t = on ? Math.min(1, Math.max(0, t)) : 0;
      lines.visible = t > 0;
      lineMat.uniforms.uOpacity.value = LINE_ALPHA * t;
      // The names ride their figures: they arrive and leave together, which is
      // the only reading under which an Earth-bound stick figure means anything.
      labels.setGroupAlpha('regions', t);
    }
    // Star names retire on their own, wider law -- see STAR_LABEL_FADE_PC.
    var st = Math.log10(STAR_LABEL_FADE_PC / d) / STAR_LABEL_FADE_DECADES + 1;
    labels.setGroupAlpha('stars', on ? Math.min(1, Math.max(0, st)) : 0);
    if (orbit) {
      // Fade IN, so the sign is flipped against the house law above.
      var o = Math.log10(d / ORBIT_FADE_PC) / ORBIT_FADE_DECADES;
      o = on ? Math.min(1, Math.max(0, o)) : 0;
      var pxPerRad = (unrenderObj.getContainer().clientHeight || 600) /
                     (2 * Math.tan(camera.fov * Math.PI / 360));
      if (orbit.userData.spanPc / d * pxPerRad < ORBIT_MIN_PX) o = 0;
      orbit.visible = o > 0;
      orbit.material.uniforms.uOpacity.value = ORBIT_ALPHA * o;
    }
    labels.setGroupVisible('stars', on);
    if (stars) stars.visible = _visible && d < starCutoffPc;
  }
  unrenderObj.onAfterToneMap(updateFade);

  return {
    setVisible: function(v) {
      _visible = v;
      if (stars) stars.visible = v;
      updateFade();
      markDirty();
    },
    setRadarVisible: function(v) {
      _radarVisible = v;
      updateFade();
      markDirty();
    },
    // The catalogue's coordinates are measured from the solar-system barycentre;
    // this scene's origin is EARTH. solarRenderer knows the offset, so it hands it
    // over. 1 AU is 0.8 arcsec at the nearest star and irrelevant there, but it is
    // 3 degrees seen from Neptune -- and row 0 of the catalogue is the Sun itself.
    setOrigin: function(p) {
      _origin.set(p.x, p.y, p.z);
      _originSet = true;
      applyOrigin();
      tryDeferred();
      updateFade();
      markDirty();
    },
    // The Milky Way's frame, routed from detailedGxyRenderer's single manifest
    // fetch. One definition of the disc plane, shared by the cloud and the orbit.
    setGalaxyFrame: function(frame) {
      _frame = frame;
      tryDeferred();
    },
    dispose: function() {
      unrenderObj.offAfterToneMap(updateFade);
      if (stars) {
        scene.remove(stars);
        stars.geometry.dispose();
        if (stars.material.uniforms.tStar.value) stars.material.uniforms.tStar.value.dispose();
        stars.material.dispose();
        stars = null;
      }
      [lines, orbit].forEach(function(o) {
        if (!o) return;
        scene.remove(o);
        o.geometry.dispose();   // lines share `position` with the stars, already disposed
        o.material.dispose();
      });
      lines = orbit = lineMat = null;
    }
  };
}
