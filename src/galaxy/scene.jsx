import { useEffect, useRef } from 'react';
import ControlModeButton from './controlModeButton.jsx';
import NoWebGL from './noWebgl.jsx';
import Help from './help.jsx';
import About from './about.jsx';
import TracerSelector from './tracerSelector.jsx';
import CameraHUD from './cameraHUD.jsx';
import createNativeRenderer from './native/renderer.js';
import appEvents from './service/appEvents.js';

var webglEnabled = require('webgl-enabled')();

export default function Scene() {
  var containerRef = useRef(null);

  useEffect(function() {
    if (!webglEnabled) return;
    var nativeRenderer = createNativeRenderer(containerRef.current);
    return function() {
      nativeRenderer.destroy();
    };
  }, []);

  if (!webglEnabled) {
    return <NoWebGL />;
  }

  return (
    <div>
      <div ref={containerRef} className='graph-full-size' />
      <TracerSelector />
      <div className='top-right-panel'>
        <CameraHUD />
        <div className='top-right-buttons'>
          <ControlModeButton />
          <About />
          <div
            className='hud-btn'
            title='Reset to origin'
            onClick={function() { appEvents.resetToOrigin.fire(); }}
          >
            🌍
          </div>
          <a href='#/' className='hud-btn' title='Exit to menu'>
            <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e399"><path d="M200-120q-33 0-56.5-23.5T120-200v-160h80v160h560v-560H200v160h-80v-160q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm220-160-56-58 102-102H120v-80h346L364-622l56-58 200 200-200 200Z"/></svg>
            {/* 🌌 */}
            {/* 🏠 */}
            {/* 🚪 */}
          </a>
        </div>
      </div>
      <Help />
    </div>
  );
}
