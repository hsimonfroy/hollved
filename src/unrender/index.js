var THREE = require('three');
var TWEEN = require('tween.js');
var combineOptions = require('./options.js');
var createParticleView = require('./lib/particle-view.js');
var createLineView = require('./lib/line-view.js');
var createHitTest = require('./lib/hit-test.js');
var createAutoPilot = require('./lib/auto-pilot.js');
var flyControls = require('three.fly');
var normalizeColor = require('./lib/normalize-color.js');

// Expose three.js as well, so simple clients do not have to require it
unrender.THREE = THREE;
unrender.TWEEN = TWEEN;

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
    hitTest: getHitTest,
    lines: drawLines,
    onFrame: onFrame,
    offFrame: offFrame,
    lookAt: lookAt,
    around: around,
    getContainer: getContainer,
    markDirty: markDirty,
    setExposure: setExposure
  };

  options = combineOptions(options);
  var lastFrame;
  var rafCallbacks = [];

  // Demand rendering: only call renderer.render() when the camera moved or
  // data changed (markDirty). Eliminates all GPU work on idle frames.
  var _lastCamPos  = new THREE.Vector3();
  var _lastCamQuat = new THREE.Quaternion();
  var _needsRender = true; // render at least once on startup

  function markDirty() {
    _needsRender = true;
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
  var lineView = createLineView(scene);
  var input = createInputHandler();
  var autoPilot = createAutoPilot(camera);

  // TODO: This doesn't seem to belong here... Not sure where to put it
  var hitTest = createHitTest(particleView, container, input);
  var updateTween = window.performance ? highResTimer : dateTimer;

  startEventsListening();

  frame();

  return api;

  function getHitTest() {
    return hitTest;
  }

  function createInputHandler() {
    var controls = flyControls(camera, container, THREE);
    controls.movementSpeed = 200;
    controls.rollSpeed = 0.065;

    return controls;
  }

  function frame(time) {
    lastFrame = requestAnimationFrame(frame);

    // Demand rendering: skip GPU work when nothing has changed
    var moved = !camera.position.equals(_lastCamPos) || !camera.quaternion.equals(_lastCamQuat);
    if (moved || _needsRender) {
      _lastCamPos.copy(camera.position);
      _lastCamQuat.copy(camera.quaternion);
      renderer.render(scene, camera, hdrTarget, true);
      renderer.render(tmScene, tmCamera);
      _needsRender = false;
    }

    input.update(0.1);
    updateTween(time);

    for (var i = 0; i < rafCallbacks.length; ++i) {
      rafCallbacks[i](time);
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
    hitTest.destroy();
    input.destroy();
    stopEventsListening();
    container.removeChild(renderer.domElement);
    hdrTarget.dispose();
    tmMesh.material.dispose();
    tmMesh.geometry.dispose();
  }

  function createScene() {
    var scene = new THREE.Scene();
    scene.sortObjects = false;
    return scene;
  }

  function getScene() {
    return scene;
  }

  function createCamera() {
    var camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 1, 10000);
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

  function drawLines(lines, color) {
    lineView.draw(lines, color);
  }

  function around(r, x, y, z) {
    autoPilot.around(r, x, y, z);
  }

  function lookAt(index, done, distanceFromTarget) {
    // todo: this should tak x,y,z instead
    var points = particleView.coordinates()
    var pos = {
      x: points[index],
      y: points[index + 1],
      z: points[index + 2]
    };

    autoPilot.flyTo(pos, done, distanceFromTarget);
  }

  function createHdrTarget() {
    return new THREE.WebGLRenderTarget(
      container.clientWidth, container.clientHeight,
      {
        type:          THREE.FloatType,
        format:        THREE.RGBAFormat,
        minFilter:     THREE.NearestFilter,
        magFilter:     THREE.NearestFilter,
        depthBuffer:   false,
        stencilBuffer: false
      }
    );
  }

  function createToneMappingMesh() {
    return new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          tDiffuse: { type: 't', value: hdrTarget },
          exposure: { type: 'f', value: 1.0 }
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
          'varying vec2 vUv;',
          'void main() {',
          '  vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;',
          '  gl_FragColor = vec4(c / (1.0 + c), 1.0);',
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

  function highResTimer(time) {
    TWEEN.update(time);
  }

  function dateTimer(time) {
    TWEEN.update(+new Date());
  }
}
