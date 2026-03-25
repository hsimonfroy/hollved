import { useState, useEffect, useRef } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';
import Key from './utils/key.js';

var isMobile = window.matchMedia('(pointer: coarse)').matches;

function HelpRow({ keys, label }) {
  return (
    <div className='help-row'>
      <span>{keys.map(function(k) { return <kbd key={k} className='help-key'>{k}</kbd>; })}</span>
      <span>{label}</span>
    </div>
  );
}

export default function Help() {
  var [visible, setVisible] = useState(false);
  var [mode, setMode] = useState(appConfig.getControlMode());
  var touchRef = useRef({ startTime: 0, startX: 0, startY: 0, startCount: 0, moved: false, multiSeen: false });

  useEffect(function() {
    function onGraphDownloaded() { setVisible(true); }
    function onDownloadRequested() { setVisible(false); }
    function onModeChanged(m) { setMode(m); }

    appEvents.graphDownloaded.on(onGraphDownloaded);
    appEvents.downloadGraphRequested.on(onDownloadRequested);
    appEvents.controlModeChanged.on(onModeChanged);

    if (!isMobile) {
      function onKeyDown(e) {
        if (Key.isControlKey(e)) { setVisible(false); return; }
        if (Key.isModifier(e)) return;
        setVisible(true);
      }
      function onWheel(e) {
        if (e.target && e.target.nodeName === 'CANVAS') setVisible(false);
      }
      document.body.addEventListener('keydown', onKeyDown);
      document.body.addEventListener('wheel', onWheel, true);
    } else {
      var t = touchRef.current;

      function onTouchStart(e) {
        if (e.touches.length >= 2) { setVisible(false); return; }
        t.startTime = Date.now();
        t.startX = e.touches[0].clientX;
        t.startY = e.touches[0].clientY;
        t.startCount = e.touches.length;
        t.moved = false;
        t.multiSeen = false;
      }

      function onTouchMove(e) {
        if (e.touches.length >= 2) { t.multiSeen = true; setVisible(false); return; }
        var dx = e.touches[0].clientX - t.startX;
        var dy = e.touches[0].clientY - t.startY;
        if (Math.sqrt(dx * dx + dy * dy) > 15) { t.moved = true; setVisible(false); }
      }

      function onTouchEnd() {
        if (t.moved || t.multiSeen) { setVisible(false); return; }
        var elapsed = Date.now() - t.startTime;
        var isTap = elapsed < 250 && t.startCount === 1;
        if (isTap) {
          setVisible(function(v) { return !v; });
        } else {
          setVisible(false);
        }
      }

      document.addEventListener('touchstart', onTouchStart, { passive: true });
      document.addEventListener('touchmove', onTouchMove, { passive: true });
      document.addEventListener('touchend', onTouchEnd, false);
    }

    return function() {
      appEvents.graphDownloaded.off(onGraphDownloaded);
      appEvents.downloadGraphRequested.off(onDownloadRequested);
      appEvents.controlModeChanged.off(onModeChanged);
      if (!isMobile) {
        document.body.removeEventListener('keydown', onKeyDown);
        document.body.removeEventListener('wheel', onWheel, true);
      } else {
        document.removeEventListener('touchstart', onTouchStart);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
      }
    };
  }, []);

  if (!visible) return null;

  return (
    <div className='help-panel'>
      <div className='help-mode-badge'>
        {mode === 'turntable' ? '⊙ Turntable' : '🚀 Spaceship'}
      </div>

      {!isMobile && mode === 'spaceship' && <>
        <div className='help-section'>Move</div>
        <HelpRow keys={['W', 'S']} label='Forward / Backward' />
        <HelpRow keys={['A', 'D']} label='Left / Right' />
        <HelpRow keys={['Space', 'Shift']} label='Up / Down' />
        <HelpRow keys={['Right hold']} label='Accelerate' />
        <div className='help-section'>Look</div>
        <HelpRow keys={['Left hold']} label='Look around' />
        <HelpRow keys={['↑↓←→']} label='Look around' />
        <HelpRow keys={['Q', 'E']} label='Roll' />
        <div className='help-section'>Mode</div>
        <HelpRow keys={['F']} label='Switch to Turntable' />
      </>}

      {!isMobile && mode === 'turntable' && <>
        <div className='help-section'>Move pivot</div>
        <HelpRow keys={['W', 'S']} label='Forward / Backward' />
        <HelpRow keys={['A', 'D']} label='Left / Right' />
        <HelpRow keys={['Space', 'Shift']} label='Up / Down' />
        <HelpRow keys={['Right drag']} label='Pan' />
        <div className='help-section'>Orbit</div>
        <HelpRow keys={['Left Drag']} label='Orbit' />
        <HelpRow keys={['↑↓←→']} label='Orbit' />
        <HelpRow keys={['Q', 'E']} label='Roll' />
        <HelpRow keys={['Scroll']} label='Zoom' />
        <div className='help-section'>Mode</div>
        <HelpRow keys={['F']} label='Switch to Spaceship' />
      </>}

      {isMobile && mode === 'spaceship' && <>
        <HelpRow keys={['Left stick']} label='Move' />
        <HelpRow keys={['Right stick']} label='Look around' />
        <HelpRow keys={['Tap ⊙']} label='Turntable mode' />
      </>}

      {isMobile && mode === 'turntable' && <>
        <HelpRow keys={['1-finger drag']} label='Orbit' />
        <HelpRow keys={['Pinch']} label='Zoom' />
        <HelpRow keys={['2-finger drag']} label='Pan' />
        <HelpRow keys={['Tap 🚀']} label='Spaceship mode' />
      </>}

      <div className='help-dismiss-hint'>
        {isMobile ? 'Tap to dismiss' : 'Press any control key to dismiss'}
      </div>
    </div>
  );
}
