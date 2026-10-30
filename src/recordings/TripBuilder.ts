import type { PairedEntry } from './RecordingPairer';

export interface Segment {
  index: number;
  key: string;
  entry: PairedEntry;
  /** Seconds. Segment length = longer of the two cameras. */
  frontDuration?: number;
  rearDuration?: number;
  duration: number;
  /** Cumulative trip-timeline offsets (seconds). */
  globalStart: number;
  globalEnd: number;
  /**
   * Wall-clock gap (per filename times) before this segment, seconds. Positive = missing footage,
   * negative = overlap. 0 when within tolerance. The trip timeline itself does not include gaps.
   */
  gapBefore: number;
}

export interface Trip {
  segments: Segment[];
  totalDuration: number;
  warnings: string[];
}

export interface Durations {
  front?: number;
  rear?: number;
}

/** Name times are second-resolution and clips are ~60.3 s, so ±3 s is "continuous". */
export const GAP_TOLERANCE_S = 3;

export function buildTrip(entries: PairedEntry[], durations: Map<string, Durations>): Trip {
  const warnings: string[] = [];
  const segments: Segment[] = [];
  let t = 0;
  for (const entry of entries) {
    const d = durations.get(entry.key) ?? {};
    const duration = Math.max(d.front ?? 0, d.rear ?? 0);
    if (!(duration > 0)) {
      warnings.push(`Skipped ${entry.key}: duration could not be determined (unreadable file?).`);
      continue;
    }
    if (d.front !== undefined && d.rear !== undefined && Math.abs(d.front - d.rear) > 1.5) {
      warnings.push(`${entry.key}: front ${d.front.toFixed(1)}s vs rear ${d.rear.toFixed(1)}s duration mismatch.`);
    }
    const prev = segments[segments.length - 1];
    let gapBefore = 0;
    if (prev) {
      const g = (entry.startMs - prev.entry.startMs) / 1000 - prev.duration;
      if (Math.abs(g) > GAP_TOLERANCE_S) gapBefore = g;
    }
    segments.push({
      index: segments.length,
      key: entry.key,
      entry,
      frontDuration: d.front,
      rearDuration: d.rear,
      duration,
      globalStart: t,
      globalEnd: t + duration,
      gapBefore,
    });
    t += duration;
  }
  return { segments, totalDuration: t, warnings };
}

/** Segment containing trip time `t` (clamped to the ends). Binary search over cumulative starts. */
export function locate(trip: Trip, t: number): { segment: Segment; local: number } | null {
  const s = trip.segments;
  if (!s.length) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]!.globalStart <= t) lo = mid;
    else hi = mid - 1;
  }
  const segment = s[lo]!;
  return { segment, local: Math.min(Math.max(t - segment.globalStart, 0), segment.duration) };
}
