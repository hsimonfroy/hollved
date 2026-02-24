/**
 * Steering indicator — no longer used. Kept as an empty shell so that any
 * residual imports don't break the build. The on-screen mode button
 * (controlModeButton.jsx) replaced this component.
 */
import React from 'react';

module.exports = require('maco')(steeringIndicator, React);

function steeringIndicator(x) {
  x.render = function () { return null; };
}
