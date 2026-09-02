/**
 * Every name in the scene, decluttered and faded as ONE pool.
 *
 * Planets, stars, constellations and galaxies all end up on the same screen, so
 * they have to compete for it together. Kept as separate layers -- as the solar
 * overlay and the local group once were -- each ran its own declutter and its own
 * fade, and the two sets happily drew on top of each other while each believed it
 * had a clear frame.
 *
 * Pooling them is also the whole feature: the fade below is relative to the
 * NEAREST eligible label, so the hand-off comes out on its own. In the solar
 * system the planets are nearest and hold the frame; pull back and they fall out
 * of the zoom window while the stars come up to full; pull back further and the
 * galaxies do the same to the stars. Nothing is authored per scale.
 *
 * ONE SCENE, ONE CAMERA -- postScene and the main camera, drawn last, over
 * everything including the solar overlay. That the solar overlay has its own
 * camera does not matter here: a perspective projection puts near and far in the
 * z row ONLY, so both cameras land a world point on the same pixel, and the solar
 * camera copies the main one's position and orientation every frame anyway. What
 * its near plane does control is clipping, which is why CAMERA_NEAR had to come
 * down to 1e-17 Mpc (309 m) before the Moon's label could live here.
 *
 * Size never encodes anything: every label is LABEL_PX tall on screen at any
 * zoom, and overlap is resolved by hiding the loser -- the standard planetarium
 * approach. Shrinking distant labels instead is both undiscriminating (at 41 AU
 * the Sun, Jupiter and Neptune all landed within a pixel of each other) and least
 * legible exactly where names matter most.
 */
import * as THREE from 'three';
import { makeRadarLabel, LABEL_STYLE_NAME } from './radarStyle.js';
import slice from '../../unrender/lib/slice.js';

var DEG2RAD = Math.PI / 180;

var LABEL_PX            = 16;   // on-screen text height, in pixels
var LABEL_FADE_POWER    = 0.4;
// How faint a backgrounded label gets. Raised from 0.1 so star names are already
// readable while the planets still hold the frame, rather than only coming up once
// the solar overlay has retired at 10 pc.
var LABEL_MIN_ALPHA     = 0.33;
var LABEL_PAD_PX        = 2;    // gap required between two label boxes
var LABEL_FALLBACK_EM   = 0.55; // per-character width before troika has synced

var MPC_TO_PC = 1e6;

/**
 * Apparent brightness as a rank, for the things whose prominence is light rather
 * than size. Folding the distance modulus out of m = M + 5*log10(d) - 5 leaves
 *
 *     flux = 10^(-0.4*M) / d_pc^2   ==   10^(-0.4*m) / 100
 *
 * so it carries no arbitrary scale: a magnitude limit converts straight across
 * through rankForMagnitude, and the Sun -- the one object that is both a body and
 * a star -- can be ranked on the same scale as the catalogue that also contains
 * it. That is not a nicety: at 1 pc the Sun is magnitude -0.17 and Sirius -1.47,
 * so Sirius really should win that overlap, and only a shared scale says so.
 *
 * @param {number} absMag absolute visual magnitude
 */
export function magnitudeRank(absMag) {
  var lum = Math.pow(10, -0.4 * absMag);
  return function(rec, dist) {
    var d = dist * MPC_TO_PC;
    return lum / (d * d);
  };
}

/** The rank a star of this APPARENT magnitude has, for a minRank cutoff. */
export function rankForMagnitude(mag) {
  return Math.pow(10, -0.4 * mag) / 100;
}

/**
 * @param {object}   unrenderObj  supplies postScene, camera, container, hooks
 * @param {function} markDirty    wake the RAF loop (troika syncs async)
 * @param {object}  [opts]  default zoom window, in apparent DIAMETER:
 *   minDiamPx   hide once the object is this small -- too far out to matter
 *   maxDiamFrac hide once it exceeds this fraction of the viewport height --
 *               you are inside it, not looking at it
 */
export default function createLabelLayer(unrenderObj, markDirty, opts) {
  opts = opts || {};
  var minDiamPx   = opts.minDiamPx   !== undefined ? opts.minDiamPx   : 0;
  var maxDiamFrac = opts.maxDiamFrac !== undefined ? opts.maxDiamFrac : Infinity;

  var scene     = unrenderObj.postScene();
  var camera    = unrenderObj.camera();
  var container = unrenderObj.getContainer();
  var viewportWidth  = container.clientWidth  || 800;
  var viewportHeight = container.clientHeight || 600;

  var items  = [];
  var groups = {};   // name -> { alpha, visible }; created on first add

  var _camUp  = new THREE.Vector3();
  var _fwd    = new THREE.Vector3();
  var _ndc    = new THREE.Vector3();
  var _placed = {};    // declutter set -> array of accepted boxes
  var _counts = {};    // declutter set -> live entries in it

  unrenderObj.onResize(function() {
    viewportWidth  = container.clientWidth  || 800;
    viewportHeight = container.clientHeight || 600;
  });

  // Apparent size: the right prominence for anything with a surface, and the
  // default because it needs no authored ranking -- the Sun wins the inner system
  // from far away, Earth beats the Moon at normal range, the Moon beats Earth once
  // you are alongside it, and M31's dwarfs name themselves only inside the group.
  function apparentSize(rec, dist, pxPerRad) {
    return rec.radius / dist * pxPerRad;
  }

  /**
   * @param {string} name
   * @param {object} worldPos any {x,y,z}; copied, so the caller may reuse it
   * @param {number} radius   the object's world radius — the default rank, the
   *                          default anchor offset, and the upper end of the zoom
   *                          window
   * @param {object} [o]
   *   group      owns visibility and the group alpha. Default 'names'.
   *   declutter  which collision set to compete in. Default 'names'.
   *   rank       (rec, dist, pxPerRad) -> prominence. Sort key AND the lower
   *              eligibility bound. Default: apparent size in pixels.
   *
   *              Apparent size is wrong for a POINT source -- every star is drawn
   *              at the same floored pixel size, so it cannot discriminate between
   *              them. A star passes its flux instead, which is what it actually
   *              has; starField already culls its dots on exactly that quantity.
   *              Ranks are exactly comparable within a class and only roughly
   *              across classes, which does not bite because the fade keeps two
   *              classes from being eligible at once -- a planet's name is gone by
   *              ~1e3 AU and the nearest star is 2.7e5 AU away. The one object that
   *              is both a body and a star is the Sun, and it is ranked as a star.
   *   minRank    lower bound, in whatever unit `rank` returns.
   *   offset     world distance to lift the label above the anchor. Defaults to
   *              `radius`, which is right for a body — the name clears the disc.
   *              It is WRONG for anything whose radius is its own extent rather
   *              than a surface: a constellation lifted by its own angular radius
   *              lands on its outer edge, and for a big figure well inside a
   *              neighbour.
   *   sliced     false to ignore the slice wedge. The solar bodies opt out: their
   *              names are an inner-system annotation, and a wedge cut through the
   *              planets would be nonsense — the same exclusion star-material makes
   *              by gating its slice behind #ifdef MAGNITUDE.
   *   depthFade  false to opt out of the nearest-relative fade. That fade is a
   *              DEPTH CUE -- "this label is further from you than that one" -- and
   *              a constellation has no depth: it is a direction, and the anchor
   *              distance it is parked at is a rendering convenience, not a fact
   *              about the label. Fading it as though it were 50 pc away left every
   *              region name pinned at the floor near Earth, where the nearest
   *              eligible label is a planet a hundred-thousandth as far.
   *   maxDiamFrac  per-item override of the layer's upper bound.
   *   style      a LABEL_STYLE_* from radarStyle.
   */
  function add(name, worldPos, radius, o) {
    o = o || {};
    var style = o.style || LABEL_STYLE_NAME;
    var label = makeRadarLabel(name, 1.0, markDirty, style);
    label.frustumCulled = false;   // positioned in world space every frame
    label.visible       = false;   // until update() decides otherwise
    scene.add(label);

    var group = o.group || 'names';
    if (!groups[group]) groups[group] = { alpha: 1, visible: true };

    items.push({
      name:      name,
      label:     label,
      worldPos:  new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z),
      radius:    radius,
      group:     group,
      declutter: o.declutter || 'names',
      // The style's authored opacities, kept so the per-frame fade can scale
      // them without each voice needing its own constant in here.
      baseFill:    style.fillOpacity,
      baseOutline: style.outlineOpacity,
      rankOf:    o.rank    || apparentSize,
      minRank:   o.minRank !== undefined ? o.minRank : minDiamPx / 2,
      offset:    o.offset  !== undefined ? o.offset  : radius,
      depthFade: o.depthFade !== false,
      sliced:    o.sliced    !== false,
      maxFrac:   o.maxDiamFrac !== undefined ? o.maxDiamFrac : maxDiamFrac,
      dist:      0,
      rank:      0,
      show:      false,
      box:       [0, 0, 0, 0]   // reused every frame; never reallocated
    });
  }

  // Greedy screen-space decluttering. Labels are a constant LABEL_PX tall, so two
  // of them collide whenever their objects are close on screen -- Earth and the
  // Moon are 1.2 px apart at 1 AU. Walk highest-rank first and drop any label
  // whose box hits one already placed IN ITS OWN SET.
  //
  // The sets exist so a constellation name and a star name can share a pixel: one
  // is light, tracked and haloed, the other crisp and outlined, and a reader
  // separates them at a glance. Without that split the region names -- which are
  // degrees across and so outrank everything -- would suppress every star name
  // they overlap, which is most of them.
  function update() {
    if (!items.length) return;

    var pxPerRad = viewportHeight / (2 * Math.tan(camera.fov * DEG2RAD / 2));
    var labelK   = LABEL_PX / pxPerRad;          // world size per unit distance
    var halfW    = viewportWidth  / 2;
    var halfH    = viewportHeight / 2;
    var camPos   = camera.position;

    _camUp.set(0,  1,  0).applyQuaternion(camera.quaternion);
    _fwd.set  (0,  0, -1).applyQuaternion(camera.quaternion);

    // Nearest among the ELIGIBLE items, so the fade reference is always a label
    // that is actually drawn -- and, since every class is in this one pool, the
    // reference moves from planet to star to galaxy on its own as you pull back.
    var nearest = Infinity;
    for (var i = 0; i < items.length; ++i) {
      var it = items[i];
      it.dist = it.worldPos.distanceTo(camPos);
      it.rank = it.rankOf(it, it.dist, pxPerRad);
      var g   = groups[it.group];
      it.show = g.visible && g.alpha > 0 &&
                it.rank >= it.minRank &&
                apparentSize(it, it.dist, pxPerRad) <= it.maxFrac * halfH &&
                (!it.sliced || slice.inside(it.worldPos));
      if (it.show && it.dist < nearest) nearest = it.dist;
    }

    items.sort(byRank);
    for (var s in _counts) _counts[s] = 0;

    for (var k = 0; k < items.length; ++k) {
      var rec = items[k];
      if (!rec.show) { rec.label.visible = false; continue; }

      // Scale by the DEPTH ALONG THE VIEW AXIS, not the radial distance to the
      // camera. A perspective divide is by z, so `labelK * dist` renders at
      // LABEL_PX / cos(theta) -- every label grows toward the edges of the frame,
      // by 31% in the corner of a 70 deg / 16:10 view. It also quietly broke the
      // declutter, since labelBox converts troika's em bounds to pixels assuming
      // the label really is LABEL_PX tall, so edge boxes were undersized.
      //
      // The depth of the ANCHOR, not of the final label position: the offset below
      // depends on `size`, and the anchor is what the label belongs to anyway.
      var depth = _ndc.subVectors(rec.worldPos, camPos).dot(_fwd);
      // Behind the camera project() mirrors the point, which would strand the
      // label on the wrong side of the screen.
      if (depth <= 0) { rec.label.visible = false; continue; }

      var size = labelK * depth;
      rec.label.scale.setScalar(size);
      rec.label.quaternion.copy(camera.quaternion);
      rec.label.position.copy(rec.worldPos)
        .addScaledVector(_camUp, rec.offset + size * 0.9);

      _ndc.copy(rec.label.position).project(camera);
      var box  = labelBox(rec, _ndc.x * halfW, _ndc.y * halfH);
      var set  = rec.declutter;
      if (!_placed[set]) { _placed[set] = []; _counts[set] = 0; }
      var used = _placed[set], n = _counts[set];

      var clash = false;
      for (var j = 0; j < n && !clash; ++j) {
        var q = used[j];
        clash = box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1];
      }
      rec.label.visible = !clash;
      if (clash) continue;
      used[n] = box;
      _counts[set] = n + 1;

      // Depth cue relative to the nearest labelled object, so it works at every
      // zoom rather than dimming the whole scene once you pull back. Items that
      // opted out take their group alpha alone -- see `depthFade` on add().
      var alpha = rec.depthFade
        ? Math.min(1, Math.max(LABEL_MIN_ALPHA,
                               Math.pow(nearest / rec.dist, LABEL_FADE_POWER)))
        : 1;
      alpha *= groups[rec.group].alpha;
      rec.label.fillOpacity    = rec.baseFill    * alpha;
      rec.label.outlineOpacity = rec.baseOutline * alpha;
    }
  }
  unrenderObj.onAfterToneMap(update);

  function byRank(a, b) { return b.rank - a.rank; }

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

  function group(name) {
    if (!groups[name]) groups[name] = { alpha: 1, visible: true };
    return groups[name];
  }

  return {
    add: add,

    // Visibility is per GROUP, never layer-wide: the sources switch on and off
    // independently -- the radar toggle drives them all, but the `local` and
    // `stars` tracers also gate their own. Raising a flag only decides what the
    // next update() may draw, never what is on screen right now.
    setGroupVisible: function(name, v) { group(name).visible = v; markDirty(); },

    // For a group whose whole extent is scale-limited. The solar overlay fades
    // out as a unit, so its names go with it rather than being clipped by a far
    // plane; the constellation names ride their figures' own fade. Neither can be
    // said with the zoom window -- solar bodies are drawn at FLOORED screen sizes,
    // so their apparent diameter stops describing what is on screen.
    //
    // Applied on the next update(). For the solar fade that is one frame late over
    // a ramp a full decade of distance wide, which is not observable.
    setGroupAlpha: function(name, a) { group(name).alpha = a; },

    dispose: function() {
      unrenderObj.offAfterToneMap(update);
      items.forEach(function(it) {
        scene.remove(it.label);
        it.label.dispose();
      });
      items = [];
    }
  };
}
