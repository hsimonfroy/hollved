import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import LoadingIndicator from './loadingIndicator.jsx';
import Scene from './scene.jsx';
import appEvents from './service/appEvents.js';

function setViewportZoom(allow) {
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.content = allow
    ? 'width=device-width, initial-scale=1'
    : 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
}

export default function GalaxyPage() {
  var { name } = useParams();
  var currentPathRef = useRef(null);

  useEffect(function() {
    setViewportZoom(false);
    return function() { setViewportZoom(true); };
  }, []);

  useEffect(function() {
    if (name !== currentPathRef.current) {
      currentPathRef.current = name;
      appEvents.downloadGraphRequested.fire(name);
    }
    appEvents.queryChanged.fire();
  }, [name]);

  return (
    <div>
      <LoadingIndicator />
      <Scene />
    </div>
  );
}
