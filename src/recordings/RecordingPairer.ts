import { parseName, type ParsedName } from './FilenameParser';

export interface SourceFile {
  name: string;
  size: number;
  blob: Blob;
}

export interface PairedEntry {
  key: string;
  startMs: number;
  /** What is played: the repaired MP4 when one was loaded, otherwise the original TS. */
  front?: SourceFile;
  rear?: SourceFile;
  /** The original recordings (the only place the embedded GPS lives). */
  frontTs?: SourceFile;
  rearTs?: SourceFile;
  /** Per-clip GPX matched by name. */
  gpx?: SourceFile;
}

export interface PairResult {
  entries: PairedEntry[];
  /** GPX files whose name matches no clip: candidates for a trip-wide track. */
  looseGpx: SourceFile[];
  warnings: string[];
}

/** Front/rear files whose name times differ by at most this are treated as the same moment. */
export const PAIR_TOLERANCE_MS = 2000;

/**
 * Pairs by parsed name/time, never by list order. Nonstandard names are reported, not guessed.
 */
export function pairRecordings(files: SourceFile[]): PairResult {
  const warnings: string[] = [];
  const fronts = new Map<string, { f: SourceFile; p: ParsedName }>();
  const rears = new Map<string, { f: SourceFile; p: ParsedName }>();
  const mp4s = new Map<string, SourceFile>(); // `${key}${cam}` -> repaired clip
  const gpx = new Map<string, SourceFile>();
  const looseGpx: SourceFile[] = [];

  const put = (map: Map<string, { f: SourceFile; p: ParsedName }>, f: SourceFile, p: ParsedName) => {
    const prev = map.get(p.key);
    if (prev) {
      const keep = f.size > prev.f.size ? f : prev.f;
      warnings.push(`Duplicate ${p.cam} clip for ${p.key}: keeping ${keep.name} (larger).`);
      if (keep === prev.f) return;
    }
    map.set(p.key, { f, p });
  };

  for (const f of files) {
    if (f.name.startsWith('.')) continue; // macOS AppleDouble ._ files and other hidden files
    const p = parseName(f.name);
    if (!p) {
      if (/\.gpx$/i.test(f.name)) looseGpx.push(f);
      else warnings.push(`Ignored "${f.name}": name does not match FILEYYMMDD-HHMMSS[F|R].`);
      continue;
    }
    if (p.ext === 'gpx') gpx.set(p.key, f);
    else if (p.ext === 'mp4') {
      if (p.cam) mp4s.set(p.key + p.cam, f);
      else warnings.push(`Ignored "${f.name}": no F/R camera suffix.`);
    }
    else if (p.cam === 'F') put(fronts, f, p);
    else if (p.cam === 'R') put(rears, f, p);
    else warnings.push(`Ignored "${f.name}": no F/R camera suffix.`);
  }

  const entries = new Map<string, PairedEntry>();
  for (const [key, { f, p }] of fronts) entries.set(key, { key, startMs: p.startMs, front: f, frontTs: f });

  for (const [key, { f, p }] of rears) {
    let e = entries.get(key);
    if (!e) {
      // tolerate small filename-time offsets between cameras
      const near = [...entries.values()].find(
        (x) => !x.rear && Math.abs(x.startMs - p.startMs) <= PAIR_TOLERANCE_MS,
      );
      if (near) {
        warnings.push(`Rear ${f.name} paired to ${near.key} by time tolerance.`);
        e = near;
      }
    }
    if (e) e.rear = e.rearTs = f;
    else entries.set(key, { key, startMs: p.startMs, rear: f, rearTs: f });
  }

  // repaired MP4s replace the playback source; MP4-only clips still count as a segment (but have no GPS)
  for (const [k, f] of mp4s) {
    const key = k.slice(0, -1);
    const cam = k.slice(-1) as 'F' | 'R';
    const p = parseName(f.name)!;
    const e = entries.get(key) ?? (entries.set(key, { key, startMs: p.startMs }), entries.get(key)!);
    if (cam === 'F') e.front = f;
    else e.rear = f;
  }

  // after the MP4 pass: an MP4-only clip (remuxed copy) keeps its sidecar GPX
  for (const [key, g] of gpx) {
    const e = entries.get(key);
    if (e) e.gpx = g;
    else looseGpx.push(g);
  }

  const out = [...entries.values()].sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key));
  for (const e of out) {
    if (!e.front) warnings.push(`Missing front clip for ${e.key}.`);
    if (!e.rear) warnings.push(`Missing rear clip for ${e.key}.`);
  }
  return { entries: out, looseGpx, warnings };
}
