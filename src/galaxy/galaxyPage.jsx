import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import LoadingIndicator from './loadingIndicator.jsx';
import Scene from './scene.jsx';
import appEvents from './service/appEvents.js';

export default function GalaxyPage() {
  var { name } = useParams();
  var currentPathRef = useRef(null);

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
