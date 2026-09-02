import config from '../../config.js';
import { galaxyFrame } from './coordUtils.js';
import slice from '../../unrender/lib/slice.js';

/**
 * @param {object}   labels        the scene-wide label layer; galaxy names go in
 *                                 its 'galaxies' group and take its default zoom
 *                                 window, which was authored for them.
 * @param {function} onGalaxyFrame called with the Milky Way's frame once the
 *                                 manifest resolves, so starField can lay the
 *                                 Sun's orbit in the same plane this disc is
 *                                 drawn in. One manifest fetch, one definition.
 */
export default function createDetailedGalaxies(unrenderObj, markDirty, labels,
                                               onGalaxyFrame) {
  var container      = unrenderObj.getContainer();
  var scene          = unrenderObj.scene();
  var viewportHeight = container.clientHeight || 600;
  var PADDING_FACTOR          = 1.5; // galaxy ~2/3 of image → ×3/2 so diam = physical world size
  var RES_FACTOR              = 10;   // resolution in px/kpc
  var DEFAULT_THICK_DIAM_RATIO = 3/4; // default thickness = 3/4 of diameter, if unspecified
  var ALPHA_THRESH            = 5; // min pixel alpha to qualify
  var N_SAMPLES               = 2; // points per qualifying pixel
  var SMOOTH_ALPHA            = 10; // Gaussian alpha smoothing strength
  var PART_SIZE               = 4.0; // particle size in picture pixel

  // A grain stands for a patch 444 pc across (PART_SIZE / RES_FACTOR / 1000).
  // Far away that patch is unresolved and the cloud reads as the long-exposure
  // photograph it was sampled from; close up it is resolved, drawing it as one
  // blob becomes a lie, and it shrinks and dims into a star, handing the volume to
  // the real HYG catalogue.
  //
  // The whole cloud shrinks TOGETHER, on one uniform, so ordinary 1/d perspective
  // survives inside it. Judging each grain by its own distance instead inverts
  // that -- the drawn size goes as c*d/D^2, which makes the FAR grains the large
  // ones.
  //
  // The driver is the MAHALANOBIS radius of the camera in the galaxy's own
  // ellipsoid (diam, diam, thick): 0 at the centre, 1 on the ellipse, 2 twice as
  // far. Dimensionless, so both anchors are galaxy scales and mean the same thing
  // for a 1.5 kpc dwarf and 44 kpc M31. It measures distance in units of the
  // galaxy's own size IN THAT DIRECTION, so for the Milky Way's 9:1 disc, k = 2 is
  // 27 kpc out edge-on but 3 kpc out face-on -- the grains are chunkier over the
  // poles by roughly the axis ratio. That is accepted, deliberately.
  var FLOOR_AT_SCALE          = 0.61;   // floors reached at and inside this. Sun is at about 0.61 in the Milky Way, so should be higher
  var SHRINK_AT_SCALE         = 5.0;   // full nominal size at and beyond this
  // The floor cannot go below 1.415 px, and that number is exact. The fragment
  // shader discards at r2 > 0.25, so the sprite is a disc of radius 0.5*S pixels,
  // while the worst a point centre can sit from every pixel centre is sqrt(0.5) =
  // 0.707 (a lattice-cell corner). At S = 1 the disc reaches no fragment at all
  // for 1 - pi/4 = 21.5% of sub-pixel positions -- the dot is DROPPED, and re-rolled
  // every time it moves. That is the flicker, and it is invisible to any aggregate:
  // the count of lit pixels barely moves because the dots dropping out are replaced
  // by others reappearing. At 1.5 px it is 0.00%. Quiet the near field with
  // MIN_PART_ALPHA instead, which costs nothing.
  var MIN_PART_PX             = 1.5;
  var MIN_PART_ALPHA          = 0.3;   // what a fully shrunk grain keeps of its own alpha

  var allPoints = [];
  var _visible  = true;
  var _radarVisible = false;

  unrenderObj.onResize(function() {
    viewportHeight = container.clientHeight || 600;
    allPoints.forEach(function(pts) {
      pts.material.uniforms.uViewportHeight.value = viewportHeight;
    });
  });

  // The camera's Mahalanobis radius in this galaxy's ellipsoid: exact, and one
  // line, because a normalised radius needs no closest-point solve.
  var _local = new THREE.Vector3();
  function galaxyScale(pts, camPos) {
    pts.worldToLocal(_local.copy(camPos));
    return Math.hypot(_local.x / pts.userData.a,
                      _local.y / pts.userData.a,
                      _local.z / pts.userData.c);
  }

  fetch(config.dataUrl + 'aux/local/manifest.json')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(manifest) {
      manifest.galaxies.forEach(function(gal) {
        var frame = galaxyFrame(gal);
        // Registered before the PNG arrives, so a name never waits on megabytes
        // of texture. The radius is the PHYSICAL one: the PADDING_FACTOR below is
        // an image-framing artefact, not a size.
        labels.add(gal.name, frame.centre, gal.diam / 2 / 1000,
                   { group: 'galaxies' });
        if (gal.id === 'mw' && onGalaxyFrame) onGalaxyFrame(frame);
        loadGalaxy(gal);
      });
    })
    .catch(function(err) { console.warn('[detailedGxyRenderer] manifest load failed:', err); });

  function loadGalaxy(gal) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() {
      var pts = buildPoints(gal, img);
      if (!pts) return;
      pts.visible = _visible;
      scene.add(pts);
      allPoints.push(pts);
      markDirty();
    };
    img.src = config.dataUrl + 'aux/local/' + gal.id + '.png';
  }

  function buildPoints(gal, img) {
    var half_diam = (gal.diam / 2 / 1000) * PADDING_FACTOR;
    var half_thick = (gal.thick !== null ? gal.thick : DEFAULT_THICK_DIAM_RATIO * gal.diam) / 2 / 1000;
    var res        = Math.round(gal.diam * RES_FACTOR * PADDING_FACTOR);

    // Position and orientation come from coordUtils.galaxyFrame, which starField
    // also uses to lay the Sun's orbit in this disc. One definition: a second one
    // here would drift the moment the manifest is retuned.
    var frame  = galaxyFrame(gal);
    var center = frame.centre;
    var rotMat = frame.rotMat;

    // Sample image on canvas
    var canvas = document.createElement('canvas');
    canvas.width = res; canvas.height = res;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, res, res);
    var pixels = ctx.getImageData(0, 0, res, res).data;

    // First pass: count qualifying pixels
    var count = 0;
    for (var k = 0; k < res * res; k++) {
      if (pixels[k * 4 + 3] >= ALPHA_THRESH) count++;
    }
    if (count === 0) return null;
    var positions = new Float32Array(count * N_SAMPLES * 3);
    var colors    = new Uint8Array(count * N_SAMPLES * 4);
    var pix = 0;

    for (var j = 0; j < res; j++) {
      for (var i = 0; i < res; i++) {
        var idx   = (j * res + i) * 4;
        var alpha = pixels[idx + 3];
        if (alpha < ALPHA_THRESH) continue;

        // Jitter sample position to break up regular grid effect.
        var u  = (i + Math.random() - 0.5) / (res - 1);
        var v  = (j + Math.random() - 0.5) / (res - 1);
        
        // Apply Gaussian alpha smoothing
        var du = u - 0.5, dv = v - 0.5;
        var gauss = Math.exp(-SMOOTH_ALPHA * (du * du + dv * dv));
        var a = Math.round((alpha / N_SAMPLES) * gauss);

        var r = pixels[idx];
        var g = pixels[idx + 1];
        var b = pixels[idx + 2];

        var x = (0.5 - v) * 2.0 * half_diam;  // sky north (image top)
        var y = (0.5 - u) * 2.0 * half_diam;  // sky east (image left)

        var zScale = (alpha / 255) * half_thick;
        for (var si = 0; si < N_SAMPLES; si++) {
          var z = (Math.random() * 2.0 - 1.0) * zScale;
          positions[pix * 3]     = x;
          positions[pix * 3 + 1] = y;
          positions[pix * 3 + 2] = z;
          colors[pix * 4]     = r;
          colors[pix * 4 + 1] = g;
          colors[pix * 4 + 2] = b;
          colors[pix * 4 + 3] = a;
          pix++;
        }
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 4, true));

    var uSize = PART_SIZE / RES_FACTOR / 1000;
    var mat = new THREE.ShaderMaterial({
      uniforms: slice.withSlice({
        uSize:           { value: uSize },
        uViewportHeight: { value: viewportHeight },
        uShrink:         { value: 1.0 },        // set per frame, below
        uMinPx:          { value: MIN_PART_PX },
        uMinAlpha:       { value: MIN_PART_ALPHA }
      }),
      vertexShader: [
        slice.GLSL,
        'uniform float uSize;',
        'uniform float uViewportHeight;',
        'uniform float uShrink;',
        'uniform float uMinPx;',
        'uniform float uMinAlpha;',
        'attribute vec4 color;',
        'varying vec4 vColor;',
        'varying float vPointSize;',
        'void main() {',
        '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
        // The fade rides in vColor.a rather than a varying of its own, so the
        // fragment shader needs no knowledge of it and the cull below drops a
        // faded grain before it ever rasterises.
        '  vColor = vec4(color.rgb, color.a * mix(uMinAlpha, 1.0, uShrink));',
        // Folded into vColor.a, so the cull below drops a sliced-out grain for free.
        '  vColor.a *= sliceAlpha((modelMatrix * vec4(position, 1.0)).xyz);',
        '  if (vColor.a < 0.004 || mvPos.z > 0.0) {',
        '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);',
        '    gl_PointSize = 0.0; vPointSize = 0.0; return;',
        '  }',
        // vPointSize stays NOMINAL: the fragment's min(vPointSize, 1.0) is the
        // far-field distance-flux law and must not follow the shrink. -mvPos.z,
        // not the radial length, because that is what the perspective divide does.
        '  vPointSize = uSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / -mvPos.z;',
        '  gl_PointSize = max(vPointSize * uShrink, uMinPx);',
        '  gl_Position  = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec4 vColor;',
        'varying float vPointSize;',
        'void main() {',
        '  vec2  xy = gl_PointCoord - 0.5;',
        '  float r2 = dot(xy, xy);',
        '  if (r2 > 0.25) discard;',
        '  float soft  = 1.0 - smoothstep(0.15, 0.25, r2);',
        '  float alpha = vColor.a * min(vPointSize, 1.0) * soft;',
        '  gl_FragColor = vec4(vColor.rgb * alpha, alpha);',
        '}'
      ].join('\n'),
      blending:    THREE.AdditiveBlending,
      transparent: true,
      depthWrite:  false,
      depthTest:   false
    });

    var pts = new THREE.Points(geo, mat);
    // The PHYSICAL semi-axes, so k = 1 is the ellipse the manifest describes and
    // the Sun lands at k = 0.61. The padding is an image-framing artefact, and
    // FLOOR_AT_SCALE is what accounts for the material it leaves outside.
    pts.userData = { a: gal.diam / 2 / 1000, c: half_thick };
    pts.position.set(center.x, center.y, center.z);
    pts.setRotationFromMatrix(rotMat);
    // onBeforeRender, not the afterToneMap pass: matrixWorld is current here and
    // there is no frame of latency.
    pts.onBeforeRender = function(renderer, scene, camera) {
      var k = galaxyScale(pts, camera.position);
      mat.uniforms.uShrink.value = Math.min(Math.max(
        (k - FLOOR_AT_SCALE) / (SHRINK_AT_SCALE - FLOOR_AT_SCALE), 0), 1);
    };
    return pts;
  }

  // Two independent gates: the `local` tracer draws the galaxies at all, the
  // radar toggle draws the annotation over them.
  function applyLabelVisibility() {
    labels.setGroupVisible('galaxies', _visible && _radarVisible);
  }

  return {
    setVisible: function(visible) {
      _visible = visible;
      allPoints.forEach(function(pts) { pts.visible = visible; });
      applyLabelVisibility();
      markDirty();
    },
    setRadarVisible: function(visible) {
      _radarVisible = visible;
      applyLabelVisibility();
    },
    dispose: function() {
      // The label layer is the scene's, not ours; renderer.js disposes it.
      allPoints.forEach(function(pts) {
        scene.remove(pts);
        pts.geometry.dispose();
        pts.material.dispose();
      });
      allPoints = [];
    }
  };
}
