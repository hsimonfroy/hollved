import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import LoadingIndicator from './loadingIndicator.jsx';
import Scene from './scene.jsx';
import appEvents from './service/appEvents.js';

function lockViewportZoom() {
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  // First clamp current zoom to 1, then on the next frame lock it
  meta.content = 'width=device-width, initial-scale=1, maximum-scale=1';
  requestAnimationFrame(function() {
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no';
  });
}

function unlockViewportZoom() {
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.content = 'width=device-width, initial-scale=1';
}

export default function GalaxyPage() {
  var { name } = useParams();
  var currentPathRef = useRef(null);

  useEffect(function() {
    lockViewportZoom();
    return unlockViewportZoom;
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
