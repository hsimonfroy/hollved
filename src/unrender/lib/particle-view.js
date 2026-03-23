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
    geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
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
    if (isFloat32Array(newPoints)) {
      points = newPoints;
    } else {
      points = new Float32Array(newPoints);
    }
    if (points.length > 0 && (points.length % 3) !== 0) {
      throw new Error('Each particle is expected to have three coordinates');
    }
  }

  function getOrSetCoordinates(newValue) {
    if (newValue === undefined) {
      return points;
    }
    if (isFloat32Array(newValue) && newValue.length === points.length) {
      points = newValue;
      geometry.getAttribute('position').needsUpdate = true;
    } else {
      throw new Error('Coordinates expect Float32Array and the size should be the same as original');
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

  function isFloat32Array(obj) {
    return Object.prototype.toString.call(obj) === '[object Float32Array]';
  }

  function isUint8Array(obj) {
    return Object.prototype.toString.call(obj) === '[object Uint8Array]';
  }
}
