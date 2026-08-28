/**
 * Coordinate conversion utilities for ICRS equatorial coordinates.
 *
 * World-space convention (Z-up, confirmed from detailedGxyRenderer.js + hollved-data/utils.py):
 *   x = R · cos(DEC) · cos(RA)
 *   y = R · cos(DEC) · sin(RA)
 *   z = R · sin(DEC)
 *
 * Horizontal coordinate convention:
 *   zenith (upAxis) = orbit north pole direction
 *   azimuth = angle from North (+DEC direction projected onto horizontal plane), increasing toward East (+RA)
 *   altitude = elevation above the horizontal plane
 *
 * Pole fallback: when zenith is at DEC=±90°, North is undefined; we use North=(1,0,0),
 * East=(0,1,0) so that azimuth = RA at both poles (standard astronomical convention).
 */
import * as THREE from 'three';

var DEG2RAD = Math.PI / 180;
var RAD2DEG = 180 / Math.PI;

export function cartToRaDecR(x, y, z) {
  var r = Math.sqrt(x * x + y * y + z * z);
  if (r < 1e-20) return { ra: 0, dec: 0, r: 0 };
  var dec = Math.asin(Math.max(-1, Math.min(1, z / r))) * RAD2DEG;
  var ra  = Math.atan2(y, x) * RAD2DEG;
  if (ra < 0) ra += 360;
  return { ra: ra, dec: dec, r: r };
}

export function raDec2Cart(ra, dec, r) {
  var raRad  = ra  * DEG2RAD;
  var decRad = dec * DEG2RAD;
  var cosDec = Math.cos(decRad);
  return {
    x: r * cosDec * Math.cos(raRad),
    y: r * cosDec * Math.sin(raRad),
    z: r * Math.sin(decRad)
  };
}

export function unitVecToRaDec(ux, uy, uz) {
  var dec = Math.asin(Math.max(-1, Math.min(1, uz))) * RAD2DEG;
  var ra  = Math.atan2(uy, ux) * RAD2DEG;
  if (ra < 0) ra += 360;
  return { ra: ra, dec: dec };
}

export function raDec2UnitVec(ra, dec) {
  return raDec2Cart(ra, dec, 1);
}

// Returns {north, east} unit vectors spanning the horizontal plane at the given zenith.
// north = toward +DEC, east = toward +RA in the horizontal plane.
// Pole fallback: when |upAxis.z| ≈ ±1, uses north=(1,0,0) east=(0,1,0) → az = RA.
export function getLocalFrame(up) {
  // project north pole (0,0,1) onto the plane perpendicular to upAxis
  var northLen2 = 1 - up.z * up.z;  // = cos²(DEC_zen)
  if (northLen2 < 1e-8) {
    return { north: { x: 1, y: 0, z: 0 }, east: { x: 0, y: 1, z: 0 } };
  }
  var len = Math.sqrt(northLen2);
  var north = {
    x: -up.x * up.z / len,
    y: -up.y * up.z / len,
    z: len
  };
  // east = cross(north, upAxis)
  var east = {
    x: north.y * up.z - north.z * up.y,
    y: north.z * up.x - north.x * up.z,
    z: north.x * up.y - north.y * up.x
  };
  return { north: north, east: east };
}

// Convert direction vector to (az, alt) in degrees.
// az ∈ [0, 360), alt ∈ [-90, 90].
export function dirToAzAlt(dir, up) {
  var dot = dir.x * up.x + dir.y * up.y + dir.z * up.z;
  var alt = Math.asin(Math.max(-1, Math.min(1, dot))) * RAD2DEG;
  var frame = getLocalFrame(up);
  var dotN  = dir.x * frame.north.x + dir.y * frame.north.y + dir.z * frame.north.z;
  var dotE  = dir.x * frame.east.x  + dir.y * frame.east.y  + dir.z * frame.east.z;
  var az = Math.atan2(dotE, dotN) * RAD2DEG;
  if (az < 0) az += 360;
  return { az: az, alt: alt };
}

// Convert (az, alt) in degrees to a unit direction vector.
export function azAltToDir(az_deg, alt_deg, up) {
  var az  = az_deg  * DEG2RAD;
  var alt = alt_deg * DEG2RAD;
  var frame   = getLocalFrame(up);
  var cosAlt  = Math.cos(alt), sinAlt = Math.sin(alt);
  var cosAz   = Math.cos(az),  sinAz  = Math.sin(az);
  return {
    x: cosAlt * (cosAz * frame.north.x + sinAz * frame.east.x) + sinAlt * up.x,
    y: cosAlt * (cosAz * frame.north.y + sinAz * frame.east.y) + sinAlt * up.y,
    z: cosAlt * (cosAz * frame.north.z + sinAz * frame.east.z) + sinAlt * up.z
  };
}

/**
 * Where a galaxy sits and how its disc is oriented, from its manifest entry alone.
 *
 * ONE definition, because two would drift. detailedGxyRenderer builds the point
 * cloud from `rotMat`, and starField draws the Sun's orbit in the plane `vZ` is
 * normal to; if those disagreed by even a degree the orbit would visibly leave
 * the disc it is supposed to lie in. Deriving either one from the standard
 * galactic-pole constants instead would be exactly that second definition — right
 * in itself, and therefore guaranteed to disagree the moment the manifest is
 * retuned.
 *
 * The construction: take the sky frame at (ra, dec), turn the major axis `pa`
 * degrees east of north, then tilt by `incl` about it. Columns of `rotMat` are
 * where sky-north, sky-east and -r_hat land.
 *
 * For the Milky Way `incl` is exactly -90, and that is load-bearing: it leaves
 * `vZ` perpendicular to r_hat for ANY `pa`, which puts the Sun — sitting at the
 * scene origin, r_hat away from the centre — exactly in the disc plane.
 *
 * @param {object} gal manifest entry: ra, dec (deg), dist (kpc), pa, incl (deg)
 * @returns {{centre: THREE.Vector3, vN, vE, vZ: THREE.Vector3, rotMat: THREE.Matrix4}}
 *          centre in Mpc, in scene coordinates; vZ the unit disc normal.
 */
export function galaxyFrame(gal) {
  var ra = gal.ra * DEG2RAD, dec = gal.dec * DEG2RAD, pa = gal.pa * DEG2RAD;
  var cosDec = Math.cos(dec), sinDec = Math.sin(dec);
  var cosRa  = Math.cos(ra),  sinRa  = Math.sin(ra);

  var rHat  = new THREE.Vector3( cosDec * cosRa,  cosDec * sinRa,  sinDec);
  var north = new THREE.Vector3(-sinDec * cosRa, -sinDec * sinRa,  cosDec);
  var east  = new THREE.Vector3(-sinRa,           cosRa,           0);

  // Major axis: PA degrees East of North, in the plane of the sky.
  var major = north.clone().multiplyScalar(Math.cos(pa))
                   .addScaledVector(east, Math.sin(pa));
  var q  = new THREE.Quaternion().setFromAxisAngle(major, -gal.incl * DEG2RAD);
  var vN = north.clone().applyQuaternion(q);
  var vE = east.clone().applyQuaternion(q);
  var vZ = rHat.clone().negate().applyQuaternion(q);

  return {
    centre: rHat.clone().multiplyScalar(gal.dist / 1000),   // kpc -> Mpc
    vN: vN, vE: vE, vZ: vZ,
    rotMat: new THREE.Matrix4().set(vN.x, vE.x, vZ.x, 0,
                                    vN.y, vE.y, vZ.y, 0,
                                    vN.z, vE.z, vZ.z, 0,
                                    0,    0,    0,    1)
  };
}
