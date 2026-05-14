/**
 * Top-right overlay displaying the camera/spaceship position in
 * cosmological coordinates, plus a speed gauge in spaceship mode.
 *
 * Position rows (always):
 *   RA  xxx.xx°   DEC  xx.xx°   Z  x.xxxx
 *   DISTANCE xxx.x Mpc   AGE  x.xx Gyr ago
 *
 * Speed rows (spaceship mode only):
 *   SPEED  xx.xx Mpc/s
 *   [────────────────●──] logarithmic slider (MIN_MOVE_SPEED – MAX_MOVE_SPEED)
 *
 * HUD lookup table arrives via appEvents.radarReady once at load time.
 * Position arrives via appEvents.cameraHUDUpdate every ~200ms.
 * Speed arrives via appEvents.cameraSpeedUpdate every RAF frame.
 */
import { useState, useEffect, useRef } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';
import { MIN_MOVE_SPEED, MAX_MOVE_SPEED } from './native/spaceshipControl.js';

var LOG_MIN   = Math.floor(Math.log10(MIN_MOVE_SPEED));
var LOG_RANGE = Math.ceil(Math.log10(MAX_MOVE_SPEED)) - LOG_MIN;
var CLAMP_MIN = Math.pow(10, LOG_MIN - 1);  // one decade below min, safe log10 lower bound

export default function CameraHUD() {
  var hudRef = useRef(null);   // hud lookup arrays

  var [pos, setPos]             = useState(null);
  var [controlMode, setControlMode] = useState(appConfig.getControlMode());
  var [maxSpeed, setMaxSpeed]   = useState(10);   // Mpc/s — drives cursor position
  var [isDragging, setIsDragging] = useState(false);
  var [isWheeling, setIsWheeling] = useState(false);

  // Refs readable inside RAF closure without stale captures
  var maxSpeedRef      = useRef(10);
  var cursorFracRef    = useRef((Math.log10(10) - LOG_MIN) / LOG_RANGE); // cursor pos 0..1
  var isDraggingRef    = useRef(false);
  var isWheelingRef    = useRef(false);
  var wheelTimerRef    = useRef(null);
  var currentSpeedRef  = useRef(0);   // last actual speed, for restoring display on pointerup
  var fillLevelRef     = useRef(0);
  var fillTargetRef    = useRef(0);
  var rafRef           = useRef(null);

  // DOM refs for zero-rerender fill animation
  var trackRef      = useRef(null);
  var fillBarRef    = useRef(null);
  var cursorDotRef  = useRef(null);
  var speedTextRef  = useRef(null);

  // ── Event subscriptions ─────────────────────────────────────────────────────

  useEffect(function() {
    function onRadarReady(data) {
      if (data && data.hud) hudRef.current = data.hud;
    }
    function onCameraUpdate(p) {
      setPos(p);  // {ra, dec, r} pre-computed by renderer.js
    }
    function onControlModeChanged(m) {
      setControlMode(m);
      if (m !== 'spaceship') {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
        fillLevelRef.current  = 0;
        fillTargetRef.current = 0;
        if (fillBarRef.current)   fillBarRef.current.style.width = '0%';
        if (cursorDotRef.current) cursorDotRef.current.style.background = 'rgba(255,255,255,0.85)';
        if (speedTextRef.current) speedTextRef.current.textContent = '—';
      }
    }
    function onSpeedUpdate(speed, ms) {
      currentSpeedRef.current = speed;
      fillTargetRef.current = Math.min(1, speed / Math.max(ms, CLAMP_MIN));
      // Show current speed only when neither dragging nor wheeling
      if (!isDraggingRef.current && !isWheelingRef.current && speedTextRef.current)
        speedTextRef.current.textContent = formatSpeed(speed);
      if (ms !== maxSpeedRef.current) {
        maxSpeedRef.current = ms;
        cursorFracRef.current = (Math.log10(Math.max(CLAMP_MIN, ms)) - LOG_MIN) / LOG_RANGE;
        setMaxSpeed(ms);
        // Wheel change: show max speed label temporarily
        if (!isDraggingRef.current) {
          isWheelingRef.current = true;
          setIsWheeling(true);
          if (speedTextRef.current) speedTextRef.current.textContent = formatSpeed(ms);
          clearTimeout(wheelTimerRef.current);
          wheelTimerRef.current = setTimeout(function() {
            isWheelingRef.current = false;
            setIsWheeling(false);
            if (speedTextRef.current) speedTextRef.current.textContent = formatSpeed(currentSpeedRef.current);
          }, 500);
        }
      }
      if (!rafRef.current) startFillAnimation();
    }

    appEvents.radarReady.on(onRadarReady);
    appEvents.cameraHUDUpdate.on(onCameraUpdate);
    appEvents.controlModeChanged.on(onControlModeChanged);
    appEvents.cameraSpeedUpdate.on(onSpeedUpdate);
    return function() {
      appEvents.radarReady.off(onRadarReady);
      appEvents.cameraHUDUpdate.off(onCameraUpdate);
      appEvents.controlModeChanged.off(onControlModeChanged);
      appEvents.cameraSpeedUpdate.off(onSpeedUpdate);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearTimeout(wheelTimerRef.current);
    };
  }, []);

  // ── Fill animation (runs its own RAF, independent of renderer) ─────────────

  function startFillAnimation() {
    var prev = performance.now();
    function tick(now) {
      var dt      = Math.min((now - prev) / 1000, 0.05);
      prev        = now;
      var target  = fillTargetRef.current;
      var current = fillLevelRef.current;
      var diff    = target - current;
      if (Math.abs(diff) < 0.005) {
        fillLevelRef.current = target;
        rafRef.current = null;
        applyFillDOM(target);
        return;
      }
      var rate = diff > 0 ? 10 : 6;  // faster accel, slower decel
      fillLevelRef.current = current + diff * rate * dt;
      applyFillDOM(fillLevelRef.current);
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function applyFillDOM(fraction) {
    var pct = (Math.max(0, Math.min(1, fraction)) * cursorFracRef.current * 100).toFixed(1) + '%';
    if (fillBarRef.current)  fillBarRef.current.style.width = pct;
    if (cursorDotRef.current)
      cursorDotRef.current.style.background = fraction >= 0.995
        ? 'rgba(0,200,255,1)'
        : 'rgba(255,255,255,0.85)';
  }

  // ── Slider interaction ──────────────────────────────────────────────────────

  function fractionFromEvent(e) {
    var rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }
  function applySliderFraction(f) {
    var ms = Math.pow(10, LOG_MIN + f * LOG_RANGE);
    maxSpeedRef.current   = ms;
    cursorFracRef.current = f;
    setMaxSpeed(ms);
    appEvents.setMovementSpeed.fire(ms);
    if (speedTextRef.current) speedTextRef.current.textContent = formatSpeed(ms);
  }
  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    clearTimeout(wheelTimerRef.current);
    isWheelingRef.current = false;
    setIsWheeling(false);
    isDraggingRef.current = true;
    setIsDragging(true);
    applySliderFraction(fractionFromEvent(e));
  }
  function onPointerMove(e) {
    if (!e.buttons) return;
    applySliderFraction(fractionFromEvent(e));
  }
  function onPointerUp() {
    isDraggingRef.current = false;
    setIsDragging(false);
    if (speedTextRef.current) speedTextRef.current.textContent = formatSpeed(currentSpeedRef.current);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (!pos) return null;

  var hud = hudRef.current;
  var ra  = pos.ra;
  var dec = pos.dec;
  var chi = pos.r;

  var inRange     = hud && chi <= hud.chi_Mpc[hud.chi_Mpc.length - 1];
  var redshift    = inRange ? lerp(chi, hud.chi_Mpc, hud.z) : null;
  var lookbackMyr = inRange ? lerp(chi, hud.chi_Mpc, hud.lookback_Myr) : null;

  var cursorFrac = Math.max(0, Math.min(1, (Math.log10(Math.max(CLAMP_MIN, maxSpeed)) - LOG_MIN) / LOG_RANGE));
  var cursorPct  = (cursorFrac * 100).toFixed(1) + '%';

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
      {controlMode === 'spaceship' && (
        <>
          <div className="camera-hud-row">
            <span className="camera-hud-label">{isDragging || isWheeling ? 'MAX SPEED' : 'SPEED'}</span>
            <span ref={speedTextRef} className="camera-hud-value">—</span>
          </div>
          <div
            ref={trackRef}
            className="speed-slider-wrap"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            <div className="speed-slider-passive" style={{ width: cursorPct }} />
            <div ref={fillBarRef} className="speed-slider-fill" style={{ width: '0%' }} />
            <div ref={cursorDotRef} className="speed-slider-cursor" style={{ left: cursorPct }} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

var DIST_KM = 3.2408e-20; // 1 km in Mpc
var DIST_AU = 4.848e-12; // 1 AU in Mpc

var AGE_mSEC = 3.171e-17; // 1 msec in Myr
var AGE_SEC = 3.171e-14; // 1 sec in Myr
var AGE_MIN = 1.901e-12; // 1 min in Myr
var AGE_HR  = 1.141e-10; // 1 hr  in Myr
var AGE_DAY = 2.738e-9;  // 1 day in Myr
var AGE_YR  = 1e-6;      // 1 yr  in Myr

var MARGIN = 1e1; // anticipate change of units

function formatSI(chi) {
  if (chi < DIST_AU / MARGIN) return (chi / DIST_KM).toFixed(0) + ' km';
  if (chi < 1e-6 / MARGIN)    return (chi / DIST_AU).toFixed(2) + ' AU';
  if (chi < 1e-3)             return (chi * 1e6).toFixed(2) + ' pc';
  if (chi < 1)                return (chi * 1e3).toFixed(2) + ' kpc';
  if (chi < 1e3)              return chi.toFixed(2) + ' Mpc';
  return (chi / 1e3).toFixed(2) + ' Gpc';
}

function formatZ(z) {
  if (z < 1e-2)  return z.toFixed(5);
  if (z < 1e0)   return z.toFixed(3);
  if (z < 1e2)   return z.toFixed(1);
  return z.toFixed(0);
}


function formatAge(myr) {
  if (myr < AGE_mSEC) return 'now';
  if (myr < AGE_SEC)  return (myr / AGE_mSEC).toFixed(0) + ' ms ago';
  if (myr < AGE_MIN)  return (myr / AGE_SEC).toFixed(0) + ' s ago';
  if (myr < AGE_HR)   return (myr / AGE_MIN).toFixed(0) + ' min ago';
  if (myr < AGE_DAY)  return (myr / AGE_HR).toFixed(0)  + ' h ago';
  if (myr < AGE_YR)   return (myr / AGE_DAY).toFixed(0) + ' d ago';
  if (myr < 1e-3)     return (myr / AGE_YR).toFixed(0)  + ' yr ago';
  if (myr < 1)        return (myr * 1e3).toFixed(1)     + ' kyr ago';
  if (myr < 1e3)      return myr.toFixed(1)              + ' Myr ago';
  return (myr / 1e3).toFixed(2)                         + ' Gyr ago';
}

function formatSpeed(mpcPerSec) {
  if (mpcPerSec < DIST_AU / MARGIN) return (mpcPerSec / DIST_KM).toFixed(0) + ' km/s';
  if (mpcPerSec < 1e-6 / MARGIN)    return (mpcPerSec / DIST_AU).toFixed(2) + ' AU/s';
  if (mpcPerSec < 1e-3)             return (mpcPerSec * 1e6).toFixed(2) + ' pc/s';
  if (mpcPerSec < 1)                return (mpcPerSec * 1e3).toFixed(2) + ' kpc/s';
  if (mpcPerSec < 1000)             return mpcPerSec.toFixed(2) + ' Mpc/s';
  return (mpcPerSec / 1e3).toFixed(2) + ' Gpc/s';
}
