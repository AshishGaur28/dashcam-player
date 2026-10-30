import { isPusi, payloadStart, pesPts, pidOf, readBytes, TsPacketReader, PKT, type Probe } from '../media/ts';
import type { GpxPoint } from './GpxParser';

/**
 * The camera writes `$GPRMC` (and `$GSENSORD`) sentences into every .TS on PID 0x0E1B / 0x0E1A, about
 * once a second, so a clip carries its own GPS. Speed is knots, time/date are UTC (date is really 2026).
 * Positions are NOT plain ddmm.mmmm: they are an obfuscated affine transform of it. Coefficients below
 * were fitted on FILE261029-072021F against the official player's GPX (max residual 0.07 m) and validated
 * on all 47 clips of the card: implied speed from consecutive positions / reported speed has median
 * 1.010 and consecutive clips join up. They come from ONE device/session: treat positions as inferred,
 * and prefer an official GPX when one is supplied.
 */
export const GPS_PID = 0x0e1b;
export const AFFINE = { latA: 0.007248169013596988, latB: -8.576185190954563, lonA: 0.011905514666877344, lonB: -52.26137609642548 };

/** One `$GPRMC` sentence → decoded fix, or null (void fix, bad checksum, malformed). `t` is left NaN. */
export function parseRmc(sentence: string): GpxPoint | null {
  // The NMEA checksum is not usable: it fails on every sentence, i.e. it was computed before the
  // coordinates were obfuscated. Validity comes from the status flag and sane decoded ranges instead.
  if (!sentence.startsWith('$GPRMC')) return null;
  const f = sentence.split('*')[0]!.split(',');
  if (f.length < 10) return null;
  if (f[2] !== 'A') return null;
  const rawLat = Number(f[3]);
  const rawLon = Number(f[5]);
  const speed = f[7] === '' ? NaN : Number(f[7]);
  if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon)) return null;
  const lat = AFFINE.latA * rawLat + AFFINE.latB;
  const lon = AFFINE.lonA * rawLon + AFFINE.lonB;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { t: NaN, lat, lon, speed, ele: NaN };
}

/** Picks the `$GPRMC` sentences out of a TS packet stream; feed it the same packets you are reading anyway. */
export class EmbeddedGpsCollector {
  readonly points: GpxPoint[] = [];
  private seen = new Set<string>();
  private pts = NaN;
  constructor(private probe: Probe) {}

  /** Clip-relative time of the newest video frame seen (NaN before the first). */
  get lastTime() {
    return this.pts - this.probe.firstPts;
  }

  feed(b: Uint8Array, p: number) {
    const pid = pidOf(b, p);
    if (pid === this.probe.psi.videoPid && isPusi(b, p)) {
      const s = payloadStart(b, p);
      if (s > 0) this.pts = pesPts(b, s);
    } else if (pid === GPS_PID) {
      const s = payloadStart(b, p);
      if (s < 0 || Number.isNaN(this.pts) || b[s] !== 0x24) return;
      let e = s;
      while (e < p + PKT && b[e] !== 0 && b[e] !== 0x0d) e++;
      const text = String.fromCharCode(...b.subarray(s, e));
      const fix = parseRmc(text);
      const key = text.split(',')[1] ?? '';
      if (!fix || this.seen.has(key)) return;
      this.seen.add(key);
      fix.t = Math.max(0, this.pts - this.probe.firstPts);
      this.points.push(fix);
    }
  }
}

/**
 * Reads the whole clip once (4 MB steps, never held in memory) and returns fixes with `t` = seconds from
 * the clip's first video frame, taken from the PTS of the video frame preceding each sentence.
 */
export async function scanEmbeddedGps(blob: Blob, probe: Probe): Promise<GpxPoint[]> {
  const STEP = 4 * 1024 * 1024;
  const gps = new EmbeddedGpsCollector(probe);
  const reader = new TsPacketReader();
  for (let pos = 0; pos < blob.size; pos += STEP) {
    const chunk = await readBytes(blob, pos, pos + STEP);
    reader.push(chunk, pos, pos + STEP >= blob.size, (b, p) => gps.feed(b, p));
  }
  return gps.points;
}
