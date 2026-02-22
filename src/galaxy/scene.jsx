import React from 'react';
import {findDOMNode} from 'react-dom';
import SteeringIndicator from './steeringIndicator.jsx';
import NoWebGL from './noWebgl.jsx';
import Help from './help.jsx';
import About from './about.jsx';

import WindowCollection from './windows/windowCollectionView.jsx';
import TracerSelector from './tracerSelector.jsx';
import createNativeRenderer from './native/renderer.js';
import createKeyboardBindings from './native/sceneKeyboardBinding.js';

var webglEnabled = require('webgl-enabled')();
module.exports = require('maco')(scene, React);

function scene(x) {
  var nativeRenderer, keyboard;

  x.render = function() {
    if (!webglEnabled) {
      return <NoWebGL />;
    }

    return (
      <div>
        <div ref='graphContainer' className='graph-full-size'/>
        <TracerSelector />
        <SteeringIndicator />
        <WindowCollection />
        <Help />
        <About />
      </div>
    );
  };

  x.componentDidMount = function() {
    if (!webglEnabled) return;
    var container = findDOMNode(x.refs.graphContainer);
    nativeRenderer = createNativeRenderer(container);
    keyboard = createKeyboardBindings(container);
  };

  x.componentWillUnmount = function() {
    if (nativeRenderer) nativeRenderer.destroy();
    if (keyboard) keyboard.destroy();
  };
}
