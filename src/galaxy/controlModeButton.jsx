/**
 * On-screen button that shows the current control mode and toggles between
 * turntable and spaceship on click/tap.
 *
 * Turntable icon (⊙) — orbit / look-around mode (default)
 * Spaceship icon (✈) — free-fly mode
 */
import appEvents from './service/appEvents.js';
import appConfig from './native/appConfig.js';
import React from 'react';

module.exports = require('maco')(controlModeButton, React);

function controlModeButton(x) {
  var mode = appConfig.getControlMode();

  appEvents.controlModeChanged.on(function(m) {
    mode = m;
    x.forceUpdate();
  });

  x.render = function() {
    var isTurntable = (mode === 'turntable');
    var icon  = isTurntable ? '⊙' : '🚀';
    var title = isTurntable
      ? 'Turntable mode — click or press F to switch to Spaceship mode'
      : 'Spaceship mode — click or press F to switch to Turntable mode';

    return (
      <div
        className='control-mode-btn'
        title={title}
        onClick={function() { appEvents.toggleControlMode.fire(); }}
      >
        {icon}
      </div>
    );
  };
}
