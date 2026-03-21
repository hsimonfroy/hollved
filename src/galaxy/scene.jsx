import React from 'react';
import {findDOMNode} from 'react-dom';
import ControlModeButton from './controlModeButton.jsx';
import NoWebGL from './noWebgl.jsx';
import Help from './help.jsx';
import About from './about.jsx';

import TracerSelector from './tracerSelector.jsx';
import createNativeRenderer from './native/renderer.js';

var webglEnabled = require('webgl-enabled')();
module.exports = require('maco')(scene, React);

function scene(x) {
  var nativeRenderer;

  x.render = function() {
    if (!webglEnabled) {
      return <NoWebGL />;
    }

    return (
      <div>
        <div ref='graphContainer' className='graph-full-size'/>
        <TracerSelector />
        <ControlModeButton />
        <Help />
        <About />
      </div>
    );
  };

  x.componentDidMount = function() {
    if (!webglEnabled) return;
    var container = findDOMNode(x.refs.graphContainer);
    nativeRenderer = createNativeRenderer(container);
  };

  x.componentWillUnmount = function() {
    if (nativeRenderer) nativeRenderer.destroy();
  };
}
