import type { GpxPoint } from './GpxParser';
import { toKmh, type SpeedUnit } from './units';

export interface GpsSource {
  id: string;
  points: GpxPoint[];
  /**
   * Trip-timeline time (s) that this source's FIRST sample maps to. Samples are placed at
   * base + (t - firstT). Per-clip GPX: the segment's globalStart. Trip-wide GPX: 0.
   */
  base: number;
  /**
   * 'first' (default): the first sample maps to `base` (GPX, whose absolute times are untrusted).
   * 'zero': sample times are already seconds from the clip start (embedded GPS, stamped by video PTS).
   */
  anchor?: 'first' | 'zero';
}

export type GpsState = 'ok' | 'gap' | 'none';

export interface GpsFix {
  state: GpsState;
  lat?: number;
  lon?: number;
  /** km/h; undefined when the file had no speed at this point. */
  speedKmh?: number;
  /** degrees clockwise from north; undefined until the vehicle has moved. */
  heading?: number;
}

/** Longest span between samples we will interpolate across. */
export const MAX_INTERP_GAP_S = 5;
/** Hold-over at the very ends of coverage (clip boundaries are not sample-aligned). */
const EDGE_TOLERANCE_S = 1.5;
const MIN_MOVE_M = 2;

const rad = Math.PI / 180;
function metres(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dy = (bLat - aLat) * rad * 6371000;
  const dx = (bLon - aLon) * rad * 6371000 * Math.cos(aLat * rad);
  return Math.hypot(dx, dy);
}
function bearing(aLat: number, aLon: number, bLat: number, bLon: number) {
  const dy = bLat - aLat;
  const dx = (bLon - aLon) * Math.cos(aLat * rad);
  return (Math.atan2(dx, dy) / rad + 360) % 360;
}

export class GpsTimeline {
  readonly t: Float64Array;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly speedKmh: Float64Array; // NaN = unknown
  readonly heading: Float64Array; // NaN = unknown
  readonly warnings: string[] = [];

  constructor(sources: GpsSource[], speedUnit: SpeedUnit) {
    const T: number[] = [];
    const LA: number[] = [];
    const LO: number[] = [];
    const SP: number[] = [];
    const ordered = [...sources].sort((a, b) => a.base - b.base);
    for (const src of ordered) {
      if (!src.points.length) continue;
      const t0 = src.anchor === 'zero' ? 0 : src.points[0]!.t;
      let dropped = 0;
      for (const p of src.points) {
        const g = src.base + (p.t - t0);
        // overlap with the previous source: keep the earlier source's samples, drop the overlap
        if (T.length && g <= T[T.length - 1]!) {
          dropped++;
          continue;
        }
        T.push(g);
        LA.push(p.lat);
        LO.push(p.lon);
        SP.push(Number.isFinite(p.speed) ? toKmh(p.speed, speedUnit) : NaN);
      }
      if (dropped) this.warnings.push(`${src.id}: ${dropped} sample(s) overlapped the previous track and were dropped.`);
    }
    this.t = Float64Array.from(T);
    this.lat = Float64Array.from(LA);
    this.lon = Float64Array.from(LO);
    this.speedKmh = Float64Array.from(SP);
    this.heading = new Float64Array(T.length).fill(NaN);
    // heading: bearing to the next point ≥ MIN_MOVE_M away; stationary keeps the last heading; reset after gaps
    let last = NaN;
    for (let i = 0; i < T.length; i++) {
      if (i > 0 && T[i]! - T[i - 1]! > MAX_INTERP_GAP_S) last = NaN;
      for (let j = i + 1; j < T.length && T[j]! - T[i]! <= MAX_INTERP_GAP_S * 2; j++) {
        if (metres(LA[i]!, LO[i]!, LA[j]!, LO[j]!) >= MIN_MOVE_M) {
          last = bearing(LA[i]!, LO[i]!, LA[j]!, LO[j]!);
          break;
        }
      }
      this.heading[i] = last;
    }
  }

  get length() {
    return this.t.length;
  }
  get start() {
    return this.t[0] ?? NaN;
  }
  get end() {
    return this.t[this.t.length - 1] ?? NaN;
  }

  /** Index i with t[i] <= q < t[i+1] (binary search); -1 if q < t[0]. */
  private find(q: number): number {
    let lo = 0;
    let hi = this.t.length - 1;
    if (q < this.t[0]!) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.t[mid]! <= q) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  at(q: number): GpsFix {
    const n = this.t.length;
    if (!n) return { state: 'none' };
    const i = this.find(q);
    const fix = (k: number): GpsFix => ({
      state: 'ok',
      lat: this.lat[k],
      lon: this.lon[k],
      speedKmh: Number.isNaN(this.speedKmh[k]!) ? undefined : this.speedKmh[k],
      heading: Number.isNaN(this.heading[k]!) ? undefined : this.heading[k],
    });
    if (i < 0) return q >= this.t[0]! - EDGE_TOLERANCE_S ? fix(0) : { state: 'gap' };
    if (i === n - 1) return q <= this.t[i]! + EDGE_TOLERANCE_S ? fix(i) : { state: 'gap' };
    const dt = this.t[i + 1]! - this.t[i]!;
    if (dt > MAX_INTERP_GAP_S) return q - this.t[i]! <= EDGE_TOLERANCE_S ? fix(i) : { state: 'gap' };
    const f = (q - this.t[i]!) / dt;
    const s0 = this.speedKmh[i]!;
    const s1 = this.speedKmh[i + 1]!;
    return {
      state: 'ok',
      lat: this.lat[i]! + (this.lat[i + 1]! - this.lat[i]!) * f,
      lon: this.lon[i]! + (this.lon[i + 1]! - this.lon[i]!) * f,
      speedKmh: Number.isNaN(s0) || Number.isNaN(s1) ? undefined : s0 + (s1 - s0) * f,
      heading: Number.isNaN(this.heading[i]!) ? undefined : this.heading[i],
    };
  }

  /** Polylines broken wherever interpolation would be refused, so gaps are drawn as gaps. */
  routeSegments(): [number, number][][] {
    const out: [number, number][][] = [];
    let cur: [number, number][] = [];
    for (let i = 0; i < this.t.length; i++) {
      if (i > 0 && this.t[i]! - this.t[i - 1]! > MAX_INTERP_GAP_S) {
        if (cur.length) out.push(cur);
        cur = [];
      }
      cur.push([this.lat[i]!, this.lon[i]!]);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Trip time of the sample nearest a map coordinate (for click-to-seek). */
  nearestTime(lat: number, lon: number): number | null {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.t.length; i++) {
      const d = metres(lat, lon, this.lat[i]!, this.lon[i]!);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best < 0 ? null : this.t[best]!;
  }
}

/** Absolute-time sanity: how far the GPX clock is from the clip's filename time. */
export function timestampWarning(firstGpxEpochS: number, clipStartMs: number): string | null {
  const diffDays = Math.abs(firstGpxEpochS * 1000 - clipStartMs) / 86_400_000;
  return diffDays > 1
    ? `GPX absolute time (${new Date(firstGpxEpochS * 1000).toISOString()}) is ${Math.round(diffDays)} day(s) from the filename time; absolute timestamps are not trusted, using relative sync.`
    : null;
}
