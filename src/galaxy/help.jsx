import { useState, useEffect, useRef } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';
import Key from './utils/key.js';

var pointerCoarseQuery = window.matchMedia('(pointer: coarse)');

function HelpRow({ keys, label }) {
  return (
    <div className='help-row'>
      <span>{keys.map(function(k, i) { return <kbd key={i} className='help-key'>{k}</kbd>; })}</span>
      <span>{label}</span>
    </div>
  );
}

var EXIT_ICON = (
  <svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 -960 960 960' fill='currentColor' style={{position:'relative',top:'2.5px'}}>
    <path d='M200-120q-33 0-56.5-23.5T120-200v-160h80v160h560v-560H200v160h-80v-160q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm220-160-56-58 102-102H120v-80h346L364-622l56-58 200 200-200 200Z'/>
  </svg>
);

// QWERTY fallbacks for when getLayoutMap() is unavailable (Firefox, Safari)
var QWERTY = { KeyW:'W', KeyS:'S', KeyA:'A', KeyD:'D', KeyQ:'Q', KeyE:'E', KeyF:'F', KeyR:'R', KeyI:'I' };

export default function Help() {
  var [visible, setVisible] = useState(false);
  var [mode, setMode] = useState(appConfig.getControlMode());
  var [isMobile, setIsMobile] = useState(pointerCoarseQuery.matches);
  var [keys, setKeys] = useState(QWERTY);
  var isMobileRef = useRef(pointerCoarseQuery.matches);
  var panelRef  = useRef(null);
  var touchRef  = useRef({ startTime: 0, startX: 0, startY: 0, startCount: 0, moved: false, multiSeen: false, isPanel: false, scrolled: false });

  // Keep ref in sync with state (for use inside stable event handlers)
  useEffect(function() { isMobileRef.current = isMobile; }, [isMobile]);

  // Media query listener — updates state (re-render) and ref (handlers) on device switch
  useEffect(function() {
    function onChange(e) { isMobileRef.current = e.matches; setIsMobile(e.matches); }
    pointerCoarseQuery.addEventListener('change', onChange);
    return function() { pointerCoarseQuery.removeEventListener('change', onChange); };
  }, []);

  // Resolve physical-key → printed-character labels for the current keyboard layout.
  // getLayoutMap() is Chromium-only; other browsers fall back to QWERTY labels.
  useEffect(function() {
    if (!navigator.keyboard || !navigator.keyboard.getLayoutMap) return;
    navigator.keyboard.getLayoutMap().then(function(map) {
      var resolved = {};
      Object.keys(QWERTY).forEach(function(code) {
        var ch = map.get(code);
        resolved[code] = ch ? ch.toUpperCase() : QWERTY[code];
      });
      setKeys(resolved);
    });
  }, []);

  // All input listeners registered once; each handler checks isMobileRef.current
  useEffect(function() {
    function onGraphDownloaded() { setVisible(true); }
    function onDownloadRequested() { setVisible(false); }
    function onModeChanged(m) { setMode(m); }

    appEvents.graphDownloaded.on(onGraphDownloaded);
    appEvents.downloadGraphRequested.on(onDownloadRequested);
    appEvents.controlModeChanged.on(onModeChanged);

    function onKeyDown(e) {
      if (isMobileRef.current) return;
      if (Key.isControlKey(e)) { setVisible(false); return; }
      if (Key.isModifier(e)) return;
      setVisible(true);
    }
    function onWheel(e) {
      if (isMobileRef.current) return;
      if (e.target && e.target.nodeName === 'CANVAS') setVisible(false);
    }
    function onMouseDown(e) {
      if (isMobileRef.current) return;
      if (e.target && e.target.nodeName === 'CANVAS') setVisible(false);
    }

    var t = touchRef.current;
    function onTouchStart(e) {
      if (!isMobileRef.current) return;
      if (e.touches.length >= 2) { setVisible(false); return; }
      var isPanel = !!(panelRef.current && panelRef.current.contains(e.target));
      t.isPanel  = isPanel;
      t.ignored  = !isPanel && e.target.nodeName !== 'CANVAS';
      t.scrolled = false;
      t.startTime  = Date.now();
      t.startX     = e.touches[0].clientX;
      t.startY     = e.touches[0].clientY;
      t.startCount = e.touches.length;
      t.moved    = false;
      t.multiSeen = false;
    }
    function onTouchMove(e) {
      if (!isMobileRef.current) return;
      if (t.ignored) return;
      if (e.touches.length >= 2) { t.multiSeen = true; setVisible(false); return; }
      var dx = e.touches[0].clientX - t.startX;
      var dy = e.touches[0].clientY - t.startY;
      if (Math.sqrt(dx * dx + dy * dy) > 15) {
        if (t.isPanel) { t.scrolled = true; } // let native scroll handle it
        else { t.moved = true; setVisible(false); }
      }
    }
    function onTouchEnd() {
      if (!isMobileRef.current) return;
      if (t.ignored) return;
      if (t.scrolled) return; // was a panel scroll — do nothing
      if (t.moved || t.multiSeen) { setVisible(false); return; }
      var elapsed = Date.now() - t.startTime;
      var isTap = elapsed < 250 && t.startCount === 1;
      if (isTap) {
        if (t.isPanel) { setVisible(false); } // panel tap → always dismiss
        else { setVisible(function(v) { return !v; }); } // canvas tap → toggle
      } else {
        setVisible(false);
      }
    }

    document.body.addEventListener('keydown', onKeyDown);
    document.body.addEventListener('wheel', onWheel, true);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, false);

    return function() {
      appEvents.graphDownloaded.off(onGraphDownloaded);
      appEvents.downloadGraphRequested.off(onDownloadRequested);
      appEvents.controlModeChanged.off(onModeChanged);
      document.body.removeEventListener('keydown', onKeyDown);
      document.body.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  if (!visible) return null;

  return (
    <div className='help-panel' ref={panelRef}>
      <div className='help-mode-badge'>
        {mode === 'satellite' ? '🛰️ Satellite' : '🚀 Spaceship'}
      </div>

      {!isMobile && mode === 'spaceship' && <>
        <div className='help-section'>Move</div>
        <HelpRow keys={[keys.KeyW, keys.KeyS]} label='Forward / Backward' />
        <HelpRow keys={[keys.KeyA, keys.KeyD]} label='Left / Right' />
        <HelpRow keys={['Space', 'Shift']} label='Up / Down' />
        <HelpRow keys={['Scroll']} label='Set max speed' />
        <div className='help-section'>Look</div>
        <HelpRow keys={['Left hold']} label='Look around' />
        <HelpRow keys={['↑↓←→']} label='Look around' />
        <HelpRow keys={[keys.KeyQ, keys.KeyE]} label='Roll' />
        <div className='help-section'>Options</div>
        <HelpRow keys={[keys.KeyF]} label='Switch to satellite' />
        <HelpRow keys={[keys.KeyR]} label='Reset to origin' />
        <HelpRow keys={[keys.KeyI]} label='Show survey info' />
      </>}

      {!isMobile && mode === 'satellite' && <>
        <div className='help-section'>Move pivot</div>
        <HelpRow keys={[keys.KeyW, keys.KeyS]} label='Forward / Backward' />
        <HelpRow keys={[keys.KeyA, keys.KeyD]} label='Left / Right' />
        <HelpRow keys={['Space', 'Shift']} label='Up / Down' />
        <HelpRow keys={['Right drag']} label='Pan' />
        <div className='help-section'>Orbit</div>
        <HelpRow keys={['Left Drag']} label='Orbit' />
        <HelpRow keys={['↑↓←→']} label='Orbit' />
        <HelpRow keys={[keys.KeyQ, keys.KeyE]} label='Roll' />
        <HelpRow keys={['Scroll']} label='Zoom' />
        <div className='help-section'>Options</div>
        <HelpRow keys={[keys.KeyF]} label='Switch to spaceship' />
        <HelpRow keys={[keys.KeyR]} label='Reset to origin' />
        <HelpRow keys={[keys.KeyI]} label='Show survey info' />
      </>}

      {isMobile && mode === 'spaceship' && <>
        <div className='help-section'>Move</div>
        <HelpRow keys={['Left stick']} label='Move' />
        <HelpRow keys={['Right stick']} label='Look around' />
        {/* <div className='help-section'>Options</div>
        <HelpRow keys={['🚀']} label='Switch to satellite' />
        <HelpRow keys={['🔭']} label='Show survey info' />
        <HelpRow keys={['🌍']} label='Reset to origin' />
        <HelpRow keys={[EXIT_ICON]} label='Back to menu' /> */}
      </>}

      {isMobile && mode === 'satellite' && <>
        <div className='help-section'>Move</div>
        <HelpRow keys={['1-finger drag']} label='Orbit' />
        <HelpRow keys={['2-finger pinch']} label='Zoom' />
        <HelpRow keys={['3-finger drag']} label='Pan' />
        {/* <div className='help-section'>Options</div>
        <HelpRow keys={['🛰️']} label='Switch to spaceship' />
        <HelpRow keys={['🔭']} label='Show survey info' />
        <HelpRow keys={['🌍']} label='Reset to origin' />
        <HelpRow keys={[EXIT_ICON]} label='Back to menu' /> */}
      </>}

      <div className='help-dismiss-hint'>
        {isMobile ? 'Tap to dismiss' : 'Press any control key to dismiss'}
      </div>
    </div>
  );
}
