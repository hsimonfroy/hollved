/**
 * Screen-space name labels for a set of world-space objects.
 *
 * Two callers, same behaviour, different scenes and cameras:
 *   solarRenderer.js       — Sun, planets, Moon, in solarScene / solarCamera.
 *   detailedGxyRenderer.js — the local group, in unrender's postScene (drawn
 *                            after tone-mapping, so white text is truly white)
 *                            with the main camera.
 *
 * Size never encodes anything: every label is LABEL_PX tall on screen at any
 * zoom, and overlap is resolved by hiding the loser -- the standard planetarium
 * approach. Shrinking distant labels instead, as the solar overlay once did, is
 * both undiscriminating (at 41 AU the Sun, Jupiter and Neptune all landed within
 * a pixel of each other) and least legible exactly where names matter most.
 *
 * Priority for both the declutter and the zoom window is APPARENT size, which
 * needs no authored ranking and adapts on its own: the Sun wins the inner system
 * from far away, Earth beats the Moon at normal range, the Moon beats Earth once
 * you are alongside it, and M31's dwarf satellites name themselves only once you
 * are inside the group.
 */
import * as THREE from 'three';
import { makeRadarLabel } from './radarStyle.js';

var DEG2RAD = Math.PI / 180;

var LABEL_PX            = 16;   // on-screen text height, in pixels
var LABEL_FILL_ALPHA    = 0.8;
var LABEL_OUTLINE_ALPHA = 0.8;
// Depth cue: fade relative to the NEAREST labelled object, not to an absolute
// distance. An absolute fade would dim everything uniformly once zoomed out,
// reproducing the very problem the size falloff had.
var LABEL_FADE_POWER    = 0.4;
var LABEL_MIN_ALPHA     = 0.1;
var LABEL_PAD_PX        = 2;    // gap required between two label boxes
var LABEL_FALLBACK_EM   = 0.55; // per-character width before troika has synced

/**
 * @param {THREE.Scene}  scene      where the label meshes live
 * @param {THREE.Camera} camera     the one that scene is rendered with
 * @param {function}     markDirty  wake the RAF loop (troika syncs async)
 * @param {object}      [opts]      zoom window, in apparent DIAMETER:
 *   minDiamPx   hide once the object is this small -- too far out to matter
 *   maxDiamFrac hide once it exceeds this fraction of the viewport height --
 *               you are inside it, not looking at it
 * Omit both and every label is drawn whenever the layer is visible.
 */
export default function createLabelLayer(scene, camera, markDirty, opts) {
  opts = opts || {};
  var minDiamPx   = opts.minDiamPx   !== undefined ? opts.minDiamPx   : 0;
  var maxDiamFrac = opts.maxDiamFrac !== undefined ? opts.maxDiamFrac : Infinity;

  var items    = [];
  var _visible = false;

  var _camUp  = new THREE.Vector3();
  var _fwd    = new THREE.Vector3();
  var _ndc    = new THREE.Vector3();
  var _placed = [];   // accepted label boxes this frame, _placedCount live entries
  var _placedCount = 0;

  /**
   * @param {string}  name
   * @param {object}  worldPos any {x,y,z}; copied, so the caller may reuse it
   * @param {number}  radius   the object's world radius — sets the anchor offset
   *                           and drives both the priority and the zoom window
   */
  function add(name, worldPos, radius) {
    var label = makeRadarLabel(name, 1.0, markDirty);
    label.frustumCulled = false;   // positioned in world space every frame
    label.visible       = false;   // until update() decides otherwise
    scene.add(label);

    items.push({
      name:     name,
      label:    label,
      worldPos: new THREE.Vector3(worldPos.x, worldPos.y, worldPos.z),
      radius:   radius,
      dist:     0,
      rPx:      0,
      show:     false,
      box:      [0, 0, 0, 0]   // reused every frame; never reallocated
    });
  }

  // Greedy screen-space decluttering. Labels are a constant LABEL_PX tall, so two
  // of them collide whenever their objects are close on screen -- Earth and the
  // Moon are 1.2 px apart at 1 AU. Walk largest-apparent-size first and drop any
  // label whose box hits one already placed.
  function update(viewportWidth, viewportHeight) {
    if (!items.length) return;
    if (!_visible) { hideAll(); return; }

    var pxPerRad = viewportHeight / (2 * Math.tan(camera.fov * DEG2RAD / 2));
    var labelK   = LABEL_PX / pxPerRad;          // world size per unit distance
    var halfW    = viewportWidth  / 2;
    var halfH    = viewportHeight / 2;
    var minRPx   = minDiamPx / 2;
    var maxRPx   = maxDiamFrac * viewportHeight / 2;
    var camPos   = camera.position;

    _camUp.set(0,  1,  0).applyQuaternion(camera.quaternion);
    _fwd.set  (0,  0, -1).applyQuaternion(camera.quaternion);

    // Nearest among the ELIGIBLE items, so the fade reference is always a label
    // that is actually drawn.
    var nearest = Infinity;
    for (var i = 0; i < items.length; ++i) {
      var it = items[i];
      it.dist = it.worldPos.distanceTo(camPos);
      it.rPx  = it.radius / it.dist * pxPerRad;
      it.show = it.rPx >= minRPx && it.rPx <= maxRPx;
      if (it.show && it.dist < nearest) nearest = it.dist;
    }

    items.sort(byApparentSize);
    _placedCount = 0;

    for (var k = 0; k < items.length; ++k) {
      var rec = items[k];
      if (!rec.show) { rec.label.visible = false; continue; }

      var size = labelK * rec.dist;
      rec.label.scale.setScalar(size);
      rec.label.quaternion.copy(camera.quaternion);
      rec.label.position.copy(rec.worldPos)
        .addScaledVector(_camUp, rec.radius + size * 0.9);

      // Behind the camera project() mirrors the point, which would strand the
      // label on the wrong side of the screen.
      _ndc.copy(rec.label.position);
      if (_ndc.sub(camPos).dot(_fwd) <= 0) { rec.label.visible = false; continue; }

      _ndc.copy(rec.label.position).project(camera);
      var box = labelBox(rec, _ndc.x * halfW, _ndc.y * halfH);

      var clash = false;
      for (var j = 0; j < _placedCount && !clash; ++j) {
        var q = _placed[j];
        clash = box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1];
      }
      rec.label.visible = !clash;
      if (clash) continue;
      _placed[_placedCount++] = box;

      // Depth cue relative to the nearest labelled object, so it works at every
      // zoom rather than dimming the whole scene once you pull back.
      var alpha = Math.pow(nearest / rec.dist, LABEL_FADE_POWER);
      alpha = Math.min(1, Math.max(LABEL_MIN_ALPHA, alpha));
      rec.label.fillOpacity    = LABEL_FILL_ALPHA    * alpha;
      rec.label.outlineOpacity = LABEL_OUTLINE_ALPHA * alpha;
    }
  }

  function byApparentSize(a, b) { return b.rPx - a.rPx; }

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

  function hideAll() {
    for (var i = 0; i < items.length; ++i) items[i].label.visible = false;
  }

  return {
    add: add,
    update: update,

    // Turning the layer ON only raises the flag: which labels are actually
    // drawn is the next update()'s decision, never this one's.
    setVisible: function(v) {
      _visible = v;
      if (!v) hideAll();
      markDirty();
    },

    dispose: function() {
      items.forEach(function(it) {
        scene.remove(it.label);
        it.label.dispose();
      });
      items = [];
    }
  };
}
