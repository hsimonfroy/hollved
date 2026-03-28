var THREE = require('three');
var combineOptions = require('./options.js');
var createParticleView = require('./lib/particle-view.js');

var CAMERA_FOV  = 70; // vertical field of view (degrees), human central vision is about 60
var CAMERA_NEAR = 1;
var CAMERA_FAR  = 100000;

// Expose three.js as well, so simple clients do not have to require it
unrender.THREE = THREE;

module.exports = unrender;

function unrender(container, options) {
  var api = {
    destroy: destroy,
    scene: getScene,
    camera: getCamera,
    input: getInput,
    renderer: getRenderer,
    // todo: this should all be refactored into single particles class.
    particles: particles,
    getParticleView: getParicleView,
    onFrame: onFrame,
    offFrame: offFrame,
    getContainer: getContainer,
    markDirty: markDirty,
    setExposure: setExposure,
    setPower: setPower
  };

  options = combineOptions(options);
  var lastFrame;
  var rafCallbacks = [];

  // Demand rendering: only call renderer.render() when the camera moved or
  // data changed (markDirty). Eliminates all GPU work on idle frames.
  var _lastCamPos  = new THREE.Vector3();
  var _lastCamQuat = new THREE.Quaternion();
  var _needsRender  = true;  // render at least once on startup
  var _loopRunning  = false;

  function markDirty() {
    _needsRender = true;
    if (!_loopRunning) {
      _loopRunning = true;
      lastFrame = requestAnimationFrame(frame);
    }
  }

  var scene = createScene();
  var camera = createCamera();
  var renderer = createRenderer();
  var hdrTarget = createHdrTarget();
  var tmMesh = createToneMappingMesh();
  var tmScene = new THREE.Scene();
  var tmCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  tmScene.add(tmMesh);

  var particleView = createParticleView(scene);
  // Stub — renderer.js replaces input.update with the combined control updater.
  var input = {
    update:    function() {},
    destroy:   function() {},
    isMoving:  function() {
      return !camera.position.equals(_lastCamPos) || !camera.quaternion.equals(_lastCamQuat);
    }
  };
  startEventsListening();

  markDirty(); // trigger initial render

  return api;

  function frame(time) {
    // Update controls first (may move camera)
    input.update(0.1);

    for (var i = 0; i < rafCallbacks.length; ++i) {
      rafCallbacks[i](time);
    }

    // Render only when camera moved or data changed
    var moved = !camera.position.equals(_lastCamPos) || !camera.quaternion.equals(_lastCamQuat);
    if (moved || _needsRender) {
      _lastCamPos.copy(camera.position);
      _lastCamQuat.copy(camera.quaternion);
      renderer.setRenderTarget(hdrTarget);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(tmScene, tmCamera);
      _needsRender = false;
    }

    // Continue loop only while there is work; otherwise pause until markDirty()
    if (moved || _needsRender || rafCallbacks.length > 0) {
      lastFrame = requestAnimationFrame(frame);
    } else {
      _loopRunning = false;
    }
  }

  function getParicleView() {
    return particleView;
  }

  function particles(coordinates) {
    // todo: this should go away when we refactor this into single view
    if (coordinates === undefined) {
      return particleView.coordinates();
    }
    particleView.initWithNewCoordinates(coordinates);

    markDirty(); // new particle data — must render
    return api;
  }

  function getContainer() {
    return container;
  }

  function destroy() {
    input.destroy();
    stopEventsListening();
    container.removeChild(renderer.domElement);
    hdrTarget.dispose();
    tmMesh.material.dispose();
    tmMesh.geometry.dispose();
  }

  function createScene() {
    var scene = new THREE.Scene();
    return scene;
  }

  function getScene() {
    return scene;
  }

  function createCamera() {
    var camera = new THREE.PerspectiveCamera(CAMERA_FOV, container.clientWidth / container.clientHeight, CAMERA_NEAR, CAMERA_FAR);
    scene.add(camera);

    return camera;
  }

  function getCamera() {
    return camera;
  }

  function getInput() {
    return input;
  }

  function onFrame(callback) {
    rafCallbacks.push(callback)
  }

  function offFrame(callback) {
    var idx = rafCallbacks.indexOf(callback);
    if (idx < 0) return;
    rafCallbacks.splice(idx, 1);
  }

  function createRenderer() {
    var renderer = new THREE.WebGLRenderer({
      antialias: false
    });

    renderer.setClearColor(options.clearColor, 1);
    renderer.setSize(container.clientWidth, container.clientHeight);

    container.appendChild(renderer.domElement);
    return renderer;
  }

  function getRenderer() {
    return renderer;
  }

  function startEventsListening() {
    window.addEventListener('resize', onWindowResize, false);
  }

  function stopEventsListening() {
    window.removeEventListener('resize', onWindowResize, false);
    cancelAnimationFrame(lastFrame);
  }

  function onWindowResize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
    hdrTarget.setSize(container.clientWidth, container.clientHeight);
    markDirty();
  }

  function detectRenderTargetType() {
    // Three.js r171 internal pattern (WebGLRenderer.js:1476).
    // Always returns HalfFloatType or UnsignedByteType — FloatType is never used.
    //
    // EXT_color_buffer_half_float OR EXT_color_buffer_float signal that the device
    // can render to float textures; either one is sufficient to confirm HalfFloat support.
    //
    // Result: HalfFloat on desktop, Android, AND iOS (uniform format across all devices).
    //         UnsignedByte only on very old hardware that supports neither extension.
    return (renderer.extensions.has('EXT_color_buffer_half_float') ||
            renderer.extensions.has('EXT_color_buffer_float'))
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;
  }

  function createHdrTarget() {
    return new THREE.WebGLRenderTarget(
      container.clientWidth, container.clientHeight,
      {
        type:          detectRenderTargetType(),
        format:        THREE.RGBAFormat,
        minFilter:     THREE.NearestFilter,
        magFilter:     THREE.NearestFilter,
        depthBuffer:   true,
        stencilBuffer: false
      }
    );
  }

  function createToneMappingMesh() {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { value: hdrTarget.texture },
          exposure: { value: 10.0 },
          power:    { value: 0.5 }
        //   exposure: { type: 'f', value: 2.0 },
        //   power:    { type: 'f', value: 1.0 }
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

  function setExposure(v) {
    tmMesh.material.uniforms.exposure.value = v;
    markDirty();
  }

  function setPower(v) {
    tmMesh.material.uniforms.power.value = v;
    markDirty();
  }

}
