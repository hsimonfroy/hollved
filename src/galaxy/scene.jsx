import { useEffect, useRef } from 'react';
import ControlModeButton from './controlModeButton.jsx';
import NoWebGL from './noWebgl.jsx';
import Help from './help.jsx';
import About from './about.jsx';
import TracerSelector from './tracerSelector.jsx';
import CameraHUD from './cameraHUD.jsx';
import createNativeRenderer from './native/renderer.js';

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
        </div>
      </div>
      <Help />
    </div>
  );
}
