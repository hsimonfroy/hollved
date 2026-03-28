/**
 * On-screen button that shows the current control mode and toggles between
 * satellite and spaceship on click/tap.
 *
 * Satellite icon (🛰️) — orbit / look-around mode (default)
 * Spaceship icon (🚀) — free-fly mode
 */
import { useState, useEffect } from 'react';
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';

export default function ControlModeButton() {
  var [mode, setMode] = useState(appConfig.getControlMode());

  useEffect(function() {
    function onModeChanged(m) { setMode(m); }
    appEvents.controlModeChanged.on(onModeChanged);
    return function() { appEvents.controlModeChanged.off(onModeChanged); };
  }, []);

  var isSatellite = (mode === 'satellite');
  var icon  = isSatellite ? '🛰️' : '🚀';
  var title = isSatellite
    ? 'Satellite mode - click or press F to switch to Spaceship mode'
    : 'Spaceship mode - click or press F to switch to Satellite mode';

  return (
    <div
      className='control-mode-btn'
      title={title}
      onClick={function() { appEvents.toggleControlMode.fire(); }}
    >
      {icon}
    </div>
  );
}
