var THREE = require('three');

module.exports = particleView;

function particleView(scene) {
  var points, colors;
  var pointCloud, geometry;
  var particleMaterial = require('./particle-material.js')();

  var api = {
    initWithNewCoordinates: initWithNewCoordinates,
    coordinates: getOrSetCoordinates,
    colors: getOrSetColors,
    getPointCloud: getPointCloud
  };

  return api;

  function getPointCloud() {
    return pointCloud;
  }

  function initWithNewCoordinates(newPoints) {
    setPoints(newPoints);
    setColors();

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float16BufferAttribute(points, 3));
    geometry.setAttribute('customColor', new THREE.BufferAttribute(colors, 4, true)); // normalized Uint8 → [0,1]

    if (pointCloud) {
      scene.remove(pointCloud);
    }

    pointCloud = new THREE.Points(geometry, particleMaterial);
    scene.add(pointCloud);
  }

  function setColors() {
    var colorsLength = 4 * (points.length / 3);
    colors = new Uint8Array(colorsLength);

    for (var i = 0; i < colorsLength; i += 4) {
      colors[i]     = 0xff;
      colors[i + 1] = 0xff;
      colors[i + 2] = 0xff;
      colors[i + 3] = 0xff;
    }
  }

  function setPoints(newPoints) {
    if (newPoints.length > 0 && (newPoints.length % 3) !== 0) {
      throw new Error('Each particle is expected to have three coordinates');
    }
    points = newPoints;
  }

  function getOrSetCoordinates(newValue) {
    if (newValue === undefined) {
      return points;
    }
    if (newValue.length === points.length) {
      points = newValue;
      geometry.getAttribute('position').needsUpdate = true;
    } else {
      throw new Error('Coordinates size must match original');
    }
  }

  function getOrSetColors(newValue) {
    if (newValue === undefined) {
      return colors;
    }
    if (isUint8Array(newValue) && newValue.length === colors.length) {
      colors = newValue;
      geometry.getAttribute('customColor').needsUpdate = true;
    } else {
      throw new Error('colors expect Uint8Array and the size should be the same as original');
    }
  }

  function isUint8Array(obj) {
    return Object.prototype.toString.call(obj) === '[object Uint8Array]';
  }
}
