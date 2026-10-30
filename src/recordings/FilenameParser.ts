export type Camera = 'F' | 'R';

export interface ParsedName {
  /** Camera-independent key, e.g. "261029-072021". */
  key: string;
  cam: Camera | null;
  ext: 'ts' | 'gpx' | 'mp4';
  /** Local wall-clock start decoded from the name (unverified hypothesis: FILEYYMMDD-HHMMSS). */
  startMs: number;
}

const RE = /^FILE(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})([FR])?\.(ts|gpx|mp4)$/i;

export function parseName(name: string): ParsedName | null {
  const m = RE.exec(name.split('/').pop() ?? name);
  if (!m) return null;
  const [yy, mo, dd, hh, mi, ss] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const d = new Date(2000 + yy, mo - 1, dd, hh, mi, ss);
  if (d.getMonth() !== mo - 1) return null; // e.g. 31 Feb rolled over
  return {
    key: `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}${m[6]}`,
    cam: (m[7]?.toUpperCase() as Camera | undefined) ?? null,
    ext: m[8]!.toLowerCase() as 'ts' | 'gpx' | 'mp4',
    startMs: d.getTime(),
  };
}
