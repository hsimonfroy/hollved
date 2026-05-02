import config from '../../config.js';

export default function createDetailedGalaxies(scene, markDirty) {
  var PADDING_FACTOR = 1.5; // galaxy ~2/3 of image → ×3/2 so diam = physical world size
  var N_SAMPLES      = 2;
  var ALPHA_THRESH   = 5;   // applied AFTER Gaussian fade

  var allPoints = [];
  var _visible  = true;

  fetch(config.dataUrl + 'aux/local_group/manifest.json')
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
    img.src = config.dataUrl + 'aux/local_group/' + gal.id + '.png';
  }

  function buildPoints(gal, img) {
    var PI = Math.PI;
    var ra_rad   = gal.ra   * PI / 180;
    var dec_rad  = gal.dec  * PI / 180;
    var pa_rad   = gal.pa   * PI / 180;
    var incl_rad = gal.incl * PI / 180;

    var dist      = gal.dist  / 1000; // kpc → Mpc
    var half_diam = (gal.diam / 2 / 1000) * PADDING_FACTOR;
    var half_thick = gal.thick / 2 / 1000;
    var res       = Math.round(gal.res);

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

    // Minor axis: perpendicular to major in sky plane
    var minor_x = -north_x * sin_pa + east_x * cos_pa;
    var minor_y = -north_y * sin_pa + east_y * cos_pa;
    var minor_z = -north_z * sin_pa + east_z * cos_pa;

    var cos_i = Math.cos(incl_rad), sin_i = Math.sin(incl_rad);

    // col2: disk normal (-r_hat at incl=0 = face-on toward observer; minor_sky at incl=90 = edge-on)
    var col2_x = -r_hat_x * cos_i + minor_x * sin_i;
    var col2_y = -r_hat_y * cos_i + minor_y * sin_i;
    var col2_z = -r_hat_z * cos_i + minor_z * sin_i;

    // col1: completes right-hand frame (cross(col2, major))
    var col1_x = minor_x * cos_i + r_hat_x * sin_i;
    var col1_y = minor_y * cos_i + r_hat_y * sin_i;
    var col1_z = minor_z * cos_i + r_hat_z * sin_i;

    // Rotation matrix (local disk frame → ICRS), row-major for THREE.Matrix4.set()
    var rotMat = new THREE.Matrix4().set(
      major_x, col1_x, col2_x, 0,
      major_y, col1_y, col2_y, 0,
      major_z, col1_z, col2_z, 0,
      0,       0,      0,      1
    );

    // Sample image on canvas
    var canvas = document.createElement('canvas');
    canvas.width = res; canvas.height = res;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, res, res);
    var pixels = ctx.getImageData(0, 0, res, res).data;

    // Worst-case alloc; trim at end
    var positions = new Float32Array(res * res * N_SAMPLES * 3);
    var colors    = new Uint8Array(res * res * N_SAMPLES * 4);
    var pix = 0;

    for (var j = 0; j < res; j++) {
      for (var i = 0; i < res; i++) {
        var idx   = (j * res + i) * 4;
        var alpha = pixels[idx + 3];
        if (alpha === 0) continue; // skip fully transparent early

        var u  = (i + Math.random() - 0.5) / (res - 1);
        var v  = (j + Math.random() - 0.5) / (res - 1);
        var du = u - 0.5, dv = v - 0.5;
        var gauss = Math.exp(-8.0 * (du * du + dv * dv));

        // Apply Gaussian before threshold (ALPHA_THRESH applied after Gaussian)
        var a = Math.round((alpha / N_SAMPLES) * gauss);
        if (a < ALPHA_THRESH) continue;

        var r = pixels[idx];
        var g = pixels[idx + 1];
        var b = pixels[idx + 2];

        var x = (u - 0.5) * 2.0 * half_diam; // local X along major axis
        var y = (v - 0.5) * 2.0 * half_diam; // local Y

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

    if (pix === 0) return null;

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, pix * 3), 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors.slice(0, pix * 4), 4, true));

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
