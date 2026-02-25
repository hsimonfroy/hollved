/**
 * Turntable (orbit) controls.
 *
 * The camera orbits a pivot point using a custom spherical coordinate system
 * whose north pole (upAxis) is derived from the camera's screen-up direction
 * at the time of initialization. This means:
 *   - Whatever is "up" on screen when you enter turntable mode stays up.
 *   - Left-drag rotates around that axis (horizontal) or tilts (vertical).
 *
 *   theta — azimuth around upAxis
 *   phi   — polar angle from upAxis (0 = north pole, π = south pole)
 *   radius — distance from pivot
 *   upAxis — orbit north pole (camera's up direction at init)
 *   fwdRef — theta=0 reference direction in the equatorial plane
 *
 * Desktop:
 *   Left-drag  → orbit (theta / phi)
 *   Right-drag → pan pivot in camera's right/up plane
 *   Scroll     → zoom (change radius)
 *
 * Mobile (called externally by mobileControl.js):
 *   onTouchRotate(dx, dy)
 *   onTouchZoom(scale)    — scale = newPinchDist / prevPinchDist
 *   onTouchPan(dx, dy)
 */
export default createTurntableControl;

function createTurntableControl(camera, container, markDirty) {
  // window.THREE is set by renderer.js before this function is ever called
  var THREE = window.THREE;
  var enabled = false;

  // Spherical coordinates in the custom (upAxis, fwdRef) basis
  var pivot  = new THREE.Vector3(0, 0, 0);
  var radius = 1000;
  var theta  = 0;            // azimuth around upAxis
  var phi    = Math.PI / 2;  // polar from upAxis (0 = top, π = bottom)
  var upAxis = new THREE.Vector3(0, 1, 0); // orbit north pole
  var fwdRef = new THREE.Vector3(0, 0, 1); // theta=0 reference direction

  // Mouse drag state
  var isLeftDown  = false;
  var isRightDown = false;
  var lastX = 0;
  var lastY = 0;

  // Rotation sensitivity (radians per pixel)
  var ROT_SPEED = 0.005;
  // Pan sensitivity factor (world units per pixel, relative to radius)
  var PAN_SPEED = 0.001;
  // Zoom constants
  var MIN_RADIUS    = 1;     // minimum orbit radius
  var SWITCH_RADIUS = 1;   // initial orbit radius when switching from spaceship mode
  var ZOOM_SPEED    = 0.002; // exponential factor per clamped scroll pixel

  container.addEventListener('mousedown',    onMouseDown,  false);
  container.addEventListener('wheel',        onWheel,      { passive: false });
  container.addEventListener('contextmenu',  onContextMenu, false);
  document.addEventListener('mousemove',     onMouseMove,  false);
  document.addEventListener('mouseup',       onMouseUp,    false);

  return {
    setEnabled:      setEnabled,
    onTouchRotate:   onTouchRotate,
    onTouchZoom:     onTouchZoom,
    onTouchPan:      onTouchPan,
    destroy:         destroy
  };

  // ── Enable / disable ──────────────────────────────────────────────────────

  function setEnabled(val, cam, pivotInFront) {
    enabled = val;
    if (val && cam) initFromCamera(cam, pivotInFront);
  }

  function initFromCamera(cam, pivotInFront) {
    if (pivotInFront) {
      // Place pivot in front of camera — keeps camera in place, non-degenerate orbit.
      // Camera forward is -Z in camera space.
      var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      pivot.set(
        cam.position.x + fwd.x * SWITCH_RADIUS,
        cam.position.y + fwd.y * SWITCH_RADIUS,
        cam.position.z + fwd.z * SWITCH_RADIUS
      );
      radius = SWITCH_RADIUS;
    } else {
      // Orbit around galaxy center (origin) — used on startup from URL hash
      pivot.set(0, 0, 0);
      var d = cam.position.distanceTo(pivot);
      radius = d > 1 ? d : 1000;
    }

    // North pole = camera's current screen-up direction in world space
    upAxis.set(0, 1, 0).applyQuaternion(cam.quaternion).normalize();

    var dir = cam.position.clone().sub(pivot).normalize();
    phi = Math.acos(Math.max(-1, Math.min(1, dir.dot(upAxis))));

    // Reference direction = current camera direction projected onto the equatorial plane.
    // Setting fwdRef to this and theta=0 keeps the camera exactly in place.
    var dot = dir.dot(upAxis);
    var projected = new THREE.Vector3(
      dir.x - upAxis.x * dot,
      dir.y - upAxis.y * dot,
      dir.z - upAxis.z * dot
    );
    if (projected.lengthSq() > 1e-6) {
      fwdRef.copy(projected).normalize();
    } else {
      // Camera is at the north/south pole — pick any perpendicular direction
      var seed = new THREE.Vector3(1, 0, 0);
      if (Math.abs(upAxis.dot(seed)) > 0.9) seed.set(0, 0, 1);
      fwdRef.crossVectors(seed, upAxis).normalize();
    }
    theta = 0;

    updateCamera();
  }

  // ── Camera update ─────────────────────────────────────────────────────────

  function updateCamera() {
    // Build the third orthonormal basis axis (theta = π/2 direction)
    var fwdAxis = new THREE.Vector3().crossVectors(upAxis, fwdRef).normalize();

    var sinPhi = Math.sin(phi);
    var cosPhi = Math.cos(phi);
    var cosT   = Math.cos(theta);
    var sinT   = Math.sin(theta);

    camera.position.set(
      pivot.x + radius * (sinPhi * cosT * fwdRef.x + sinPhi * sinT * fwdAxis.x + cosPhi * upAxis.x),
      pivot.y + radius * (sinPhi * cosT * fwdRef.y + sinPhi * sinT * fwdAxis.y + cosPhi * upAxis.y),
      pivot.z + radius * (sinPhi * cosT * fwdRef.z + sinPhi * sinT * fwdAxis.z + cosPhi * upAxis.z)
    );
    camera.up.copy(upAxis); // ensure lookAt aligns correctly
    camera.lookAt(pivot);
    markDirty();
  }

  // ── Desktop mouse ─────────────────────────────────────────────────────────

  function onMouseDown(e) {
    if (!enabled) return;
    if (e.button === 0) isLeftDown  = true;
    if (e.button === 2) isRightDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!enabled) return;
    var dx = e.clientX - lastX;
    var dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isLeftDown)  applyRotate(dx, dy);
    if (isRightDown) applyPan(dx, dy);
  }

  function onMouseUp(e) {
    if (e.button === 0) isLeftDown  = false;
    if (e.button === 2) isRightDown = false;
  }

  function onWheel(e) {
    if (!enabled) return;
    e.preventDefault();
    applyZoom(e.deltaY);
  }

  function onContextMenu(e) {
    if (!enabled) return;
    e.preventDefault(); // suppress right-click browser menu
  }

  // ── Shared math ───────────────────────────────────────────────────────────

  function applyRotate(dx, dy) {
    theta -= dx * ROT_SPEED;
    phi    = Math.max(0.01, Math.min(Math.PI - 0.01, phi - dy * ROT_SPEED));
    updateCamera();
  }

  function applyPan(dx, dy) {
    // camera.lookAt() sets camera.quaternion but not camera.matrix, so use
    // quaternion directly to get world-space right/up vectors
    var right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    var up    = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    var scale = radius * PAN_SPEED;
    right.multiplyScalar(-dx * scale);
    up.multiplyScalar(dy * scale);
    pivot.add(right);
    pivot.add(up);
    updateCamera();
  }

  function applyZoom(delta) {
    radius = Math.max(MIN_RADIUS, radius * Math.exp(delta * ZOOM_SPEED));
    updateCamera();
  }

  // ── Touch API (called by mobileControl.js) ────────────────────────────────

  function onTouchRotate(dx, dy) {
    if (!enabled) return;
    applyRotate(dx, dy);
  }

  function onTouchZoom(scale) {
    if (!enabled) return;
    // scale = newDist / prevDist: > 1 means fingers spread (zoom in = smaller radius)
    radius = Math.max(1, radius / scale);
    updateCamera();
  }

  function onTouchPan(dx, dy) {
    if (!enabled) return;
    applyPan(dx, dy);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function destroy() {
    container.removeEventListener('mousedown',   onMouseDown,   false);
    container.removeEventListener('wheel',       onWheel,       false);
    container.removeEventListener('contextmenu', onContextMenu, false);
    document.removeEventListener('mousemove',    onMouseMove,   false);
    document.removeEventListener('mouseup',      onMouseUp,     false);
  }
}
