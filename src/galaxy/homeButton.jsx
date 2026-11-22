import { useState, useEffect } from 'react';
import appEvents from './service/appEvents.js';

// The Earth button. Its press depends on where the camera is (see renderer.js,
// onHomePressed), and so do its icon and tooltip.
var LOOK = {
  recenter:   { icon: '🌍', title: 'Recenter on Earth' },
  toEarth:    { icon: '🌍', title: 'Fly to Earth' },
  toOverview: { icon: '🌌', title: 'Fly out to the whole survey' }
};

export default function HomeButton() {
  var [action, setAction] = useState('recenter');

  useEffect(function() {
    appEvents.homeActionChanged.on(setAction);
    return function() { appEvents.homeActionChanged.off(setAction); };
  }, []);

  var look = LOOK[action] || LOOK.recenter;
  return (
    <div
      className='hud-btn'
      title={look.title}
      onClick={function() { appEvents.resetToOrigin.fire(); }}
    >
      {look.icon}
    </div>
  );
}
