/**
 * The render loop. Owns the WebGL renderer, the camera and three passes:
 *
 *   1. scene      -> HDR target   additive layers: catalogue, stars, clouds, CMB
 *   2. tone map   -> screen       generalized Reinhard, on luminance
 *   3. postScene  -> screen       labels, crisp and unaffected by the tone curve
 *
 * with the afterToneMap callbacks (the solar overlay, the label layout) between
 * 2 and 3.
 *
 * Rendering is on demand: a frame is drawn only when the camera moved or
 * markDirty() was called, and the loop stops when nothing is in motion.
 */
import * as THREE from 'three';

var CAMERA_FOV  = 70; // vertical field of view (degrees), human central vision is about 60
// Safe because NOTHING drawn with this camera uses depth: the HDR target has no
// depth buffer, the catalogue and CMB materials set depthTest and depthWrite
// false, and every label sets depthTest false. Only clipping changes.
var CAMERA_NEAR = 1e-17;
var CAMERA_FAR  = 1e5;

var EXPOSURE = 500.0;
var POWER    = 0.4;

export default function createEngine(container) {
  var beforeRenderCallbacks = [];
  var afterToneMapCallbacks = [];
  var frameCallbacks  = [];
  var resizeCallbacks = [];
  var update = function() { return false; };   // see setUpdate

  var scene     = new THREE.Scene();
  var postScene = new THREE.Scene();   // labels, drawn after tone-mapping
  var camera    = new THREE.PerspectiveCamera(CAMERA_FOV,
    container.clientWidth / container.clientHeight, CAMERA_NEAR, CAMERA_FAR);
  scene.add(camera);

  var renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.autoClear = false;   // all clears are explicit so postScene can add on top
  renderer.setClearColor(0x000000, 1);
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  var hdrTarget = createHdrTarget();
  var tmMesh    = createToneMappingMesh();
  var tmScene   = new THREE.Scene();
  var tmCamera  = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  tmScene.add(tmMesh);

  var lastCamPos  = new THREE.Vector3();
  var lastCamQuat = new THREE.Quaternion();
  var needsRender = true;
  var loopRunning = false;
  var rafId, lastFrameTime = 0;

  window.addEventListener('resize', onResize, false);
  markDirty();

  return {
    scene:        function() { return scene; },
    postScene:    function() { return postScene; },
    camera:       function() { return camera; },
    renderer:     function() { return renderer; },
    getContainer: function() { return container; },
    getExposure:  function() { return EXPOSURE; },
    getPower:     function() { return POWER; },
    markDirty:    markDirty,
    destroy:      destroy,

    /**
     * The controls' per-frame step: fn(deltaSeconds) moves the camera and returns
     * whether anything is still in motion -- a held key, a gliding orbit -- which
     * keeps the loop running on a frame where the camera has not moved yet.
     */
    setUpdate: function(fn) { update = fn; },

    onFrame:  function(cb) { frameCallbacks.push(cb); },
    offFrame: function(cb) { remove(frameCallbacks, cb); },
    onResize:  function(cb) { resizeCallbacks.push(cb); },
    offResize: function(cb) { remove(resizeCallbacks, cb); },
    // After the camera has settled for the frame (controls, animations) and
    // before anything is drawn: the place to decide what is visible. Deciding
    // it after the frame is a frame late, and that late frame is the one left
    // on screen when the camera stops.
    onBeforeRender:  function(cb) { beforeRenderCallbacks.push(cb); },
    offBeforeRender: function(cb) { remove(beforeRenderCallbacks, cb); },
    onAfterToneMap:  function(cb) { afterToneMapCallbacks.push(cb); },
    offAfterToneMap: function(cb) { remove(afterToneMapCallbacks, cb); }
  };

  function markDirty() {
    needsRender = true;
    if (!loopRunning) {
      loopRunning = true;
      rafId = requestAnimationFrame(frame);
    }
  }

  function frame(time) {
    // Controls first: they may move the camera. A markDirty() from in there
    // cannot keep the loop alive -- this frame's own render consumes it -- which
    // is why update() reports motion instead.
    var delta = lastFrameTime ? Math.min((time - lastFrameTime) / 1000, 0.1) : 0;
    lastFrameTime = time;
    var busy = update(delta);
    var i;
    for (i = 0; i < frameCallbacks.length; ++i) frameCallbacks[i](time);

    var moved = !camera.position.equals(lastCamPos) || !camera.quaternion.equals(lastCamQuat);
    if (moved || needsRender) {
      lastCamPos.copy(camera.position);
      lastCamQuat.copy(camera.quaternion);
      for (i = 0; i < beforeRenderCallbacks.length; ++i) beforeRenderCallbacks[i](camera);
      renderer.setRenderTarget(hdrTarget);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.clear();
      renderer.render(tmScene, tmCamera);
      for (i = 0; i < afterToneMapCallbacks.length; ++i) afterToneMapCallbacks[i](renderer, camera);
      renderer.render(postScene, camera);
      needsRender = false;
    }

    if (moved || needsRender || busy || frameCallbacks.length > 0) {
      rafId = requestAnimationFrame(frame);
    } else {
      loopRunning = false;
      // So the first frame after idle measures no elapsed time rather than the
      // whole idle gap, which the 0.1 s clamp turned into a jump at the start of
      // every drag, glide and keypress.
      lastFrameTime = 0;
    }
  }

  function onResize() {
    var w = container.clientWidth, h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    hdrTarget.setSize(w, h);
    for (var i = 0; i < resizeCallbacks.length; ++i) resizeCallbacks[i](h);
    markDirty();
  }

  function destroy() {
    window.removeEventListener('resize', onResize, false);
    cancelAnimationFrame(rafId);
    container.removeChild(renderer.domElement);
    hdrTarget.dispose();
    tmMesh.material.dispose();
    tmMesh.geometry.dispose();
  }

  function createHdrTarget() {
    // HalfFloat wherever the device can render to a float texture -- either
    // extension says so -- which is desktop, Android and iOS alike. 8-bit only on
    // very old hardware.
    var halfFloat = renderer.extensions.has('EXT_color_buffer_half_float') ||
                    renderer.extensions.has('EXT_color_buffer_float');
    return new THREE.WebGLRenderTarget(container.clientWidth, container.clientHeight, {
      type:          halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format:        THREE.RGBAFormat,
      minFilter:     THREE.NearestFilter,
      magFilter:     THREE.NearestFilter,
      // Nothing drawn into it tests or writes depth (see CAMERA_NEAR above), so
      // a depth buffer would only be cleared and carried every frame.
      depthBuffer:   false,
      stencilBuffer: false
    });
  }

  function createToneMappingMesh() {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: hdrTarget.texture },
          exposure: { value: EXPOSURE },
          power:    { value: POWER }
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main() {',
          '  vUv = uv;',
          '  gl_Position = vec4(position.xy, 0.0, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
            'uniform sampler2D tDiffuse;',
            'uniform float exposure;',
            'uniform float power;',
            'varying vec2 vUv;',
            'void main() {',
            '  vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;',
            '  float L = dot(c, vec3(0.2126, 0.7152, 0.0722));',
        // Generalized Reinhard luminance tone mapping
            '  float Lm = L / pow(1.0 + pow(L, power), 1.0/power);',

          //   '  float Lm = (L*(2.51*L+0.03)) / (L*(2.43*L+0.59)+0.14);',
          //   '  float bL = power * max(L, 0.0);',
          //   '  float Lm = log(bL + sqrt(bL * bL + 1.0)) / power;', // asinh(beta*L) / beta

            '  gl_FragColor = vec4(clamp(c * (Lm / max(L, 0.0001)), 0.0, 1.0), 1.0);',

        // Generalized Reinhard RGB tone mapping
            // '  gl_FragColor = vec4(c / pow(1.0 + pow(c, vec3(power)), vec3(1.0/power)), 1.0);',
          '}'
        ].join('\n'),
        depthTest:  false,
        depthWrite: false
      })
    );
  }
}

function remove(list, cb) {
  var i = list.indexOf(cb);
  if (i >= 0) list.splice(i, 1);
}
