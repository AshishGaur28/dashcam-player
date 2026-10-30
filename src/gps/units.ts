/**
 * The Wolfbox GPX <speed> unit is NOT m/s. On the sample track (FILE261029-072021F.gpx) the value
 * divided by speed measured from consecutive positions has median ~1.92; 1 m/s = 1.944 knots, so
 * the values are knots (NMEA RMC convention). Still selectable: confirm against the official player.
 */
export type SpeedUnit = 'knots' | 'mps' | 'kmh' | 'mph';

const TO_KMH: Record<SpeedUnit, number> = { knots: 1.852, mps: 3.6, kmh: 1, mph: 1.609344 };


export function toKmh(value: number, unit: SpeedUnit): number {
  return value * TO_KMH[unit];
}

/** Embedded NMEA speed is always knots; express it in the unit the GPS store converts from. */
export function knotsTo(value: number, unit: SpeedUnit): number {
  return (value * TO_KMH.knots) / TO_KMH[unit];
}
