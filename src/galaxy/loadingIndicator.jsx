import { useState, useEffect } from 'react';
import scene from './store/scene.js';

export default function LoadingIndicator() {
  var [loadingMessage, setLoadingMessage] = useState('');

  useEffect(function() {
    function updateLoadingIndicator(progress) {
      setLoadingMessage(progress.message + ' - ' + progress.completed);
    }
    scene.on('loadProgress', updateLoadingIndicator);
    return function() {
      scene.off('loadProgress', updateLoadingIndicator);
    };
  }, []);

  return scene.isLoading() ?
    <div className='loading'>{loadingMessage}</div> :
    null;
}
