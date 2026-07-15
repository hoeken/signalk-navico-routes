/**
 * Lowrance/Navico mercator-meter coordinate conversion (WGS84 semi-minor
 * axis spherical mercator). Same math as GPSBabel's lowranceusr module.
 *
 * The int32 mercator-meter grid stores roughly 1e-5 degrees (~1 m) of
 * precision; `lonDegToMm`/`latDegToMm` define the canonical rounding used
 * for change detection everywhere in the plugin.
 */

const SEMIMINOR = 6356752.3142;
const DEG2RAD = Math.PI / 180;

export function lonMmToDeg(mm: number): number {
  return mm / (DEG2RAD * SEMIMINOR);
}

export function latMmToDeg(mm: number): number {
  return (2 * Math.atan(Math.exp(mm / SEMIMINOR)) - Math.PI / 2) / DEG2RAD;
}

export function lonDegToMm(deg: number): number {
  return Math.round(deg * SEMIMINOR * DEG2RAD);
}

export function latDegToMm(deg: number): number {
  return Math.round(SEMIMINOR * Math.log(Math.tan((deg * DEG2RAD + Math.PI / 2) / 2)));
}
