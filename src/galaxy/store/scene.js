/**
 * Manages graph model life cycle. The low-level rendering of the particles
 * is handled by ../native/renderer.js
 */
import loadGraph from  '../service/graphLoader.js';
import appEvents from '../service/appEvents.js';

import eventify from 'ngraph.events';

export default sceneStore();

function sceneStore() {
  var loadInProgress = true;
  var currentGraphName;

  var api = {
    isLoading: isLoading,
    getGraphName: getGraphName,
    downloadGraph: downloadGraph,
    reportProgress: reportProgress,
    loadComplete: loadComplete
  };

  appEvents.downloadGraphRequested.on(downloadGraph);

  eventify(api);

  return api;

  function isLoading() {
    return loadInProgress;
  }

  function downloadGraph(graphName) {
    if (graphName === currentGraphName) return;

    loadInProgress = true;
    currentGraphName = graphName;
    loadGraph(graphName, reportProgress).then(loadComplete);
  }

  function getGraphName() {
    return currentGraphName;
  }

  function reportProgress(progress) {
    api.fire('loadProgress', progress);
  }

  function loadComplete() {
    loadInProgress = false;
    api.fire('loadProgress', {});
    appEvents.graphDownloaded.fire();
  }
}
