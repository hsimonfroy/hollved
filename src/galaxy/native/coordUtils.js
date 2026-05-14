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
