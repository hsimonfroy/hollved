/**
 * Top-center overlay displaying the camera/spaceship position in
 * cosmological coordinates.
 *
 * Row 1:  RA  xxx.xx°   DEC  xx.xx°   Z  x.xxxx
 * Row 2:  DISTANCE xxx.x Mpc   AGE  x.xx Gyr ago
 *
 * Visibility is tied to the Radar tracer toggle (same as ruler rings).
 * Position arrives via appEvents.cameraHUDUpdate (every ~200ms) and always
 * reflects the actual camera/viewpoint position.
 * HUD lookup table (chi_Mpc -> z, lookback_Myr) arrives via
 * appEvents.radarReady once at load time.
 */
import { useState, useEffect, useRef } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';

var RAD2DEG = 180 / Math.PI;

export default function CameraHUD() {
  var hudRef = useRef(null);   // hud lookup arrays

  // Match the default-hidden logic in renderer.js
  var configVisible = appConfig.getVisibleTracers();
  var [radarVisible, setRadarVisible] = useState(
    configVisible ? configVisible.indexOf('radar') >= 0 : false
  );
  var [pos, setPos] = useState(null);

  useEffect(function() {
    function onRadarReady(data) {
      if (data && data.hud) hudRef.current = data.hud;
    }
    function onCameraUpdate(p) {
      setPos({ x: p.x, y: p.y, z: p.z });
    }
    function onSetTracerVisibility(tracerId, visible) {
      if (tracerId === 'radar') setRadarVisible(visible);
    }
    appEvents.radarReady.on(onRadarReady);
    appEvents.cameraHUDUpdate.on(onCameraUpdate);
    appEvents.setTracerVisibility.on(onSetTracerVisibility);
    return function() {
      appEvents.radarReady.off(onRadarReady);
      appEvents.cameraHUDUpdate.off(onCameraUpdate);
      appEvents.setTracerVisibility.off(onSetTracerVisibility);
    };
  }, []);

  if (!radarVisible || !pos) return null;

  var hud = hudRef.current;
  var x = pos.x, y = pos.y, z = pos.z;
  var chi = Math.sqrt(x * x + y * y + z * z);

  // Spherical coordinates
  var ra  = chi > 0 ? Math.atan2(y, x) * RAD2DEG : 0;
  if (ra < 0) ra += 360;
  var dec = chi > 0 ? Math.atan2(z, Math.sqrt(x * x + y * y)) * RAD2DEG : 0;

  // Check if chi is within the HUD table range
  var inRange = hud && chi <= hud.chi_Mpc[hud.chi_Mpc.length - 1];
  var redshift    = inRange ? lerp(chi, hud.chi_Mpc, hud.z) : null;
  var lookbackMyr = inRange ? lerp(chi, hud.chi_Mpc, hud.lookback_Myr) : null;

  return (
    <div className="camera-hud">
      <div className="camera-hud-row">
        <span className="camera-hud-label">RA</span>
        <span className="camera-hud-value">{ra.toFixed(2)}&deg;</span>
        <span className="camera-hud-label">DEC</span>
        <span className="camera-hud-value">{dec.toFixed(2)}&deg;</span>
        <span className="camera-hud-label">Z</span>
        <span className="camera-hud-value">
          {redshift !== null ? formatZ(redshift) : '?'}
        </span>
      </div>
      <div className="camera-hud-row">
        <span className="camera-hud-label">DISTANCE</span>
        <span className="camera-hud-value">
          {inRange ? formatSI(chi) : '?'}
        </span>
        <span className="camera-hud-label">AGE</span>
        <span className="camera-hud-value">
          {lookbackMyr !== null ? formatAge(lookbackMyr) : '?'}
        </span>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Linear interpolation in a monotonically increasing xs array. */
function lerp(x, xs, ys) {
  var n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  var lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    var mid = (lo + hi) >>> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  var t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Format comoving distance in Mpc with adaptive SI prefix. */
function formatSI(chi) {
  if (chi < 1e-3) return chi.toFixed(1) + ' pc';
  if (chi < 1)    return (chi * 1e3).toFixed(0) + ' kpc';
  if (chi < 1e3)  return chi.toFixed(1) + ' Mpc';
  return (chi / 1e3).toFixed(2) + ' Gpc';
}

/** Format redshift: more decimals for small z, fewer for large. */
function formatZ(z) {
  if (z < 0.01)  return z.toFixed(4);
  if (z < 1)     return z.toFixed(3);
  if (z < 100)   return z.toFixed(1);
  return z.toFixed(0);
}

/** Format lookback time in Myr as "X.XX Gyr ago" or "X.X Myr ago". */
function formatAge(myr) {
  if (myr < 0.001) return '0 yr ago';
  if (myr < 1)     return (myr * 1e3).toFixed(0) + ' kyr ago';
  if (myr < 1e3)   return myr.toFixed(1) + ' Myr ago';
  return (myr / 1e3).toFixed(2) + ' Gyr ago';
}
