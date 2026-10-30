import { scanEmbeddedGps } from '../gps/embedded';
import { parseGpx, type GpxPoint } from '../gps/GpxParser';
import { GpsStore } from '../gps/GpsStore';
import { timestampWarning } from '../gps/GpsTimeline';
import { knotsTo, type SpeedUnit } from '../gps/units';
import { probeTs } from '../media/ts';
import { pairRecordings, type PairedEntry, type PairResult, type SourceFile } from '../recordings/RecordingPairer';
import { buildTrip, type Durations, type Segment, type Trip } from '../recordings/TripBuilder';

export interface GpxInfo {
  name: string;
  mode: 'per-clip' | 'trip-wide';
  count: number;
  first?: string;
  last?: string;
  warnings: string[];
}

export interface Loaded {
  pair: PairResult;
  trip: Trip;
  /** Append-only GPS: grows as segments are prepared. */
  gps: GpsStore;
  gpx: GpxInfo[];
  warnings: string[];
}

export function describeFiles(files: File[]): PairResult {
  return pairRecordings(files.map((f) => ({ name: f.name, size: f.size, blob: f })));
}

export interface BuildOptions {
  speedUnit: SpeedUnit;
  /** Name of a loose GPX to treat as one track covering the whole trip (relative to trip start). */
  tripWideName?: string;
  excluded: Set<string>;
  /** True once a newer load has replaced this one: stop probing and stop emitting. */
  cancelled?: () => boolean;
  /** The rest of the files are only probed once this resolves (the first clip gets the disk to itself). */
  gate?: Promise<void>;
}

/**
 * Progressive: files are probed in order (head+tail only, ~1.7 MB each, 4 at a time) and `onUpdate` fires
 * as soon as the first segment is known so playback can start, then as the trip grows. Embedded GPS is
 * NOT read here: it is read per segment when that segment is prepared (see `embeddedGpsFor`).
 */
export async function loadTrip(pair: PairResult, opts: BuildOptions, onUpdate: (l: Loaded, complete: boolean) => void): Promise<void> {
  const entries = pair.entries.filter((e) => !opts.excluded.has(e.key));
  const warnings = [...pair.warnings];
  const durations = new Map<string, Durations>();
  const done = new Set<string>();
  const gps = new GpsStore(opts.speedUnit);
  const gpx: GpxInfo[] = [];
  let emitted = 0;

  const addGpx = async (f: SourceFile, base: number, mode: GpxInfo['mode'], key: string, clipStartMs?: number) => {
    const r = parseGpx(await f.blob.text());
    const w = [...r.warnings];
    if (r.points.length && clipStartMs !== undefined) {
      const tw = timestampWarning(r.points[0]!.t, clipStartMs);
      if (tw) w.push(tw);
    }
    gpx.push({
      name: f.name,
      mode,
      count: r.points.length,
      first: r.points.length ? new Date(r.points[0]!.t * 1000).toISOString() : undefined,
      last: r.points.length ? new Date(r.points[r.points.length - 1]!.t * 1000).toISOString() : undefined,
      warnings: w,
    });
    warnings.push(...w.map((x) => `${f.name}: ${x}`));
    await gps.ensure(key, async () => ({ id: f.name, points: r.points, base }));
  };

  const wide = pair.looseGpx.find((g) => g.name === opts.tripWideName);
  if (wide) await addGpx(wide, 0, 'trip-wide', 'trip-wide', entries[0]?.startMs);

  const emit = async (final: boolean) => {
    if (opts.cancelled?.()) return;
    let k = 0;
    while (k < entries.length && done.has(entries[k]!.key)) k++;
    if (!final && (k === emitted || (emitted > 0 && k - emitted < 8))) return;
    const trip = buildTrip(entries.slice(0, k), durations);
    for (let i = emitted; i < trip.segments.length; i++) {
      const seg = trip.segments[i]!;
      if (seg.entry.gpx) await addGpx(seg.entry.gpx, seg.globalStart, 'per-clip', seg.key, seg.entry.startMs);
    }
    emitted = k;
    onUpdate({ pair, trip, gps, gpx: [...gpx], warnings: [...warnings, ...trip.warnings] }, final && k === entries.length);
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < entries.length && !opts.cancelled?.()) {
        const idx = next++;
        const e = entries[idx]!;
        if (idx > 0) await opts.gate;
        if (opts.cancelled?.()) return;
        const d: Durations = {};
        for (const [cam, f] of [['front', e.front], ['rear', e.rear]] as const) {
          if (!f) continue;
          try {
            d[cam] = /\.mp4$/i.test(f.name) ? await mp4Duration(f.blob) : (await probeTs(f.blob)).duration;
          } catch (err) {
            warnings.push(`${f.name}: ${(err as Error).message}`);
          }
        }
        durations.set(e.key, d);
        done.add(e.key);
        await emit(false);
      }
    }),
  );
  await emit(true);
}

/**
 * Read a segment's own GPS (embedded NMEA) and hand it to the store. Called when the segment is prepared,
 * so it is on the map before it plays and stays after its video is released. Official GPX wins.
 */
export function embeddedGpsFor(store: GpsStore, seg: Segment, unit: SpeedUnit, hasTripWide: boolean, known?: GpxPoint[]): Promise<void> {
  const ts = seg.entry.frontTs ?? seg.entry.rearTs; // GPS lives in the original recording, not a repaired MP4
  if (seg.entry.gpx || hasTripWide || (!ts && !known)) return Promise.resolve();
  return store.ensure(seg.key, async () => {
    // `known`: already read while the clip was converted, so no second pass over a 90 MB file
    const pts = known ? known.map((p) => ({ ...p })) : await scanEmbeddedGps(ts!.blob, await probeTs(ts!.blob));
    for (const p of pts) if (Number.isFinite(p.speed)) p.speed = knotsTo(p.speed, unit);
    return { id: `embedded:${ts?.name ?? seg.key}`, points: pts, base: seg.globalStart, anchor: 'zero' };
  });
}

function mp4Duration(blob: Blob): Promise<number> {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(blob);
    const done = () => URL.revokeObjectURL(url);
    v.preload = 'metadata';
    v.onloadedmetadata = () => (done(), res(v.duration));
    v.onerror = () => (done(), rej(new Error('Cannot read this MP4')));
    v.src = url;
  });
}

/**
 * Loading-page preview: read ONLY the GPS of one clip (its GPX, or the NMEA inside the original .TS) onto a
 * store keyed by wall-clock seconds. Raw embedded points are cached so starting the session does not read the file again.
 */
export async function previewGps(store: GpsStore, entry: PairedEntry, unit: SpeedUnit, cache: Map<string, GpxPoint[]>): Promise<void> {
  const base = entry.startMs / 1000;
  if (entry.gpx) {
    const r = parseGpx(await entry.gpx.blob.text());
    return store.ensure(entry.key, async () => ({ id: entry.gpx!.name, points: r.points, base }));
  }
  const ts = entry.frontTs ?? entry.rearTs;
  if (!ts) return;
  let pts = cache.get(entry.key);
  if (!pts) cache.set(entry.key, (pts = await scanEmbeddedGps(ts.blob, await probeTs(ts.blob))));
  const raw = pts;
  return store.ensure(entry.key, async () => ({
    id: `embedded:${ts.name}`,
    points: raw.map((p) => ({ ...p, speed: Number.isFinite(p.speed) ? knotsTo(p.speed, unit) : p.speed })),
    base,
    anchor: 'zero' as const,
  }));
}

const windowFixes = new WeakMap<GpsStore, Map<string, Map<number, GpxPoint>>>();

/**
 * A long recording is converted in windows, each of which carries only its own part of the clip's GPS. Merge them into
 * the clip's track so the route only ever grows (a window's fixes replace the same seconds, never remove others).
 */
export function addWindowGps(store: GpsStore, seg: Segment, unit: SpeedUnit, hasTripWide: boolean, points: GpxPoint[]) {
  if (seg.entry.gpx || hasTripWide || !points.length) return;
  let perClip = windowFixes.get(store);
  if (!perClip) windowFixes.set(store, (perClip = new Map()));
  let m = perClip.get(seg.key);
  if (!m) perClip.set(seg.key, (m = new Map()));
  for (const p of points) m.set(Math.round(p.t * 10), p);
  const all = [...m.values()].sort((a, b) => a.t - b.t).map((p) => ({ ...p, speed: Number.isFinite(p.speed) ? knotsTo(p.speed, unit) : p.speed }));
  store.add(seg.key, { id: `embedded:${seg.key}`, points: all, base: seg.globalStart, anchor: 'zero' });
}
