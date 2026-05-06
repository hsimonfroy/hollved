import { useState, useEffect } from 'react';
import scene from './store/scene.js';
import appEvents from './service/appEvents.js';

export default function LoadingIndicator() {
  var [active, setActive] = useState(false);
  var [msg,    setMsg]    = useState('');

  useEffect(function() {
    function onProgress(p) {
      if (p.message) setMsg(p.message + ' - ' + p.completed);
    }
    function onStart() { setActive(true); setMsg(''); }
    function onDone()  { setActive(false); }
    scene.on('loadProgress', onProgress);
    appEvents.downloadGraphRequested.on(onStart);
    appEvents.graphDownloaded.on(onDone);
    return function() {
      scene.off('loadProgress', onProgress);
      appEvents.downloadGraphRequested.off(onStart);
      appEvents.graphDownloaded.off(onDone);
    };
  }, []);

  return active ? <div className='loading-progress'>{msg}</div> : null;
}
