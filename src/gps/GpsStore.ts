import { GpsTimeline, type GpsSource } from './GpsTimeline';
import type { SpeedUnit } from './units';

/**
 * Append-only GPS for the trip. A segment's samples are added when that segment is prepared and are
 * kept after its video is released, so the route only ever grows. The (small) timeline is rebuilt on
 * each add; arrays are ~1 sample/s.
 */
export class GpsStore {
  private sources = new Map<string, GpsSource>();
  private inflight = new Set<string>();
  private listeners = new Set<(t: GpsTimeline) => void>();
  timeline: GpsTimeline;

  constructor(private unit: SpeedUnit) {
    this.timeline = new GpsTimeline([], unit);
  }

  has(key: string) {
    return this.sources.has(key) || this.inflight.has(key);
  }

  add(key: string, source: GpsSource) {
    this.sources.set(key, source);
    this.timeline = new GpsTimeline([...this.sources.values()], this.unit);
    this.listeners.forEach((f) => f(this.timeline));
  }

  /** Runs `load` once per key; never throws into the caller. */
  async ensure(key: string, load: () => Promise<GpsSource | null>) {
    if (this.has(key)) return;
    this.inflight.add(key);
    try {
      const src = await load();
      if (src && src.points.length) this.add(key, src);
    } catch {
      /* no GPS for this segment: shown as a gap */
    } finally {
      this.inflight.delete(key);
    }
  }

  subscribe(fn: (t: GpsTimeline) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}
