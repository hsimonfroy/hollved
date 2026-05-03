import config from '../../config.js';

export default function createDetailedGalaxies(scene, markDirty) {
  var PADDING_FACTOR          = 1.5; // galaxy ~2/3 of image → ×3/2 so diam = physical world size
  var RES_FACTOR              = 5;   // px/kpc
  var DEFAULT_THICK_DIAM_RATIO = 3/4;
  var N_SAMPLES               = 2;
  var ALPHA_THRESH            = 5;

  var allPoints = [];
  var _visible  = true;

  fetch(config.dataUrl + 'aux/local/manifest.json')
    .then(function(r) { return r.json(); })
    .then(function(manifest) {
      manifest.galaxies.forEach(function(gal) { loadGalaxy(gal); });
    });

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
    var PI = Math.PI;
    var ra_rad   = gal.ra   * PI / 180;
    var dec_rad  = gal.dec  * PI / 180;
    var pa_rad   = gal.pa   * PI / 180;
    var incl_rad = gal.incl * PI / 180;

    var dist      = gal.dist  / 1000; // kpc → Mpc
    var half_diam = (gal.diam / 2 / 1000) * PADDING_FACTOR;
    var half_thick = (gal.thick !== null ? gal.thick : DEFAULT_THICK_DIAM_RATIO * gal.diam) / 2 / 1000;
    var res        = Math.round(RES_FACTOR * gal.diam);

    // Galaxy center in ICRS Cartesian
    var cx = dist * Math.cos(dec_rad) * Math.cos(ra_rad);
    var cy = dist * Math.cos(dec_rad) * Math.sin(ra_rad);
    var cz = dist * Math.sin(dec_rad);

    // Local orthonormal frame at (RA, Dec)
    var r_hat_x = Math.cos(dec_rad) * Math.cos(ra_rad);
    var r_hat_y = Math.cos(dec_rad) * Math.sin(ra_rad);
    var r_hat_z = Math.sin(dec_rad);

    var north_x = -Math.sin(dec_rad) * Math.cos(ra_rad);
    var north_y = -Math.sin(dec_rad) * Math.sin(ra_rad);
    var north_z =  Math.cos(dec_rad);

    var east_x = -Math.sin(ra_rad);
    var east_y =  Math.cos(ra_rad);
    var east_z =  0;

    // Major axis: PA degrees East of North
    var cos_pa = Math.cos(pa_rad), sin_pa = Math.sin(pa_rad);
    var major_x = north_x * cos_pa + east_x * sin_pa;
    var major_y = north_y * cos_pa + east_y * sin_pa;
    var major_z = north_z * cos_pa + east_z * sin_pa;

    // Rotation matrix: tilt sky frame by incl around major axis
    // Columns = where sky-north, sky-east, -r_hat land after inclination
    var q = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(major_x, major_y, major_z), -incl_rad);
    var vN = new THREE.Vector3(north_x, north_y, north_z).applyQuaternion(q);
    var vE = new THREE.Vector3(east_x,  east_y,  east_z ).applyQuaternion(q);
    var vZ = new THREE.Vector3(-r_hat_x, -r_hat_y, -r_hat_z).applyQuaternion(q);
    var rotMat = new THREE.Matrix4().set(
      vN.x, vE.x, vZ.x, 0,
      vN.y, vE.y, vZ.y, 0,
      vN.z, vE.z, vZ.z, 0,
      0,    0,    0,    1
    );

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
        var gauss = Math.exp(-8.0 * (du * du + dv * dv));
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

    var uSize = 13.0 * half_diam / res * 351.0;
    var mat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: uSize } },
      vertexShader: [
        'uniform float uSize;',
        'attribute vec4 color;',
        'varying vec4 vColor;',
        'varying float vPointSize;',
        'void main() {',
        '  vColor = color;',
        '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
        '  if (vColor.a < 0.004 || mvPos.z > 0.0) {',
        '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);',
        '    gl_PointSize = 0.0; vPointSize = 0.0; return;',
        '  }',
        '  vPointSize = uSize / -mvPos.z;',
        '  if (vPointSize < 0.01) {',
        '    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);',
        '    gl_PointSize = 0.0; vPointSize = 0.0; return;',
        '  }',
        '  gl_PointSize = vPointSize;',
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
    pts.position.set(cx, cy, cz);
    pts.setRotationFromMatrix(rotMat);
    return pts;
  }

  return {
    setVisible: function(visible) {
      _visible = visible;
      allPoints.forEach(function(pts) { pts.visible = visible; });
      markDirty();
    },
    dispose: function() {
      allPoints.forEach(function(pts) {
        scene.remove(pts);
        pts.geometry.dispose();
        pts.material.dispose();
      });
      allPoints = [];
    }
  };
}
