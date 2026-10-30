export interface GpxPoint {
  /** Seconds since epoch as written in the file (NOT trusted as absolute; see warnings). NaN if missing. */
  t: number;
  lat: number;
  lon: number;
  /** Raw <speed> value in the file's unit (see units.ts). NaN if missing. */
  speed: number;
  ele: number;
}

export interface ParsedGpx {
  points: GpxPoint[];
  warnings: string[];
  trackName?: string;
}

const num = (el: Element | null | undefined): number => {
  const s = el?.textContent?.trim();
  return s ? Number(s) : NaN;
};

/**
 * Parses with DOMParser (not regex). Drops invalid coordinates, keeps points with missing time
 * (callers decide), sorts by time, and resolves duplicate timestamps deterministically:
 * exact duplicates collapse, conflicting duplicates keep the LAST one in file order.
 */
export function parseGpx(xml: string): ParsedGpx {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    return { points: [], warnings: ['Invalid GPX XML: could not be parsed.'] };
  }
  const trackName = doc.getElementsByTagName('trk')[0]?.getElementsByTagName('name')[0]?.textContent?.trim();
  const raw: GpxPoint[] = [];
  let badCoord = 0;
  for (const el of Array.from(doc.getElementsByTagName('trkpt'))) {
    const lat = Number(el.getAttribute('lat'));
    const lon = Number(el.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      badCoord++;
      continue;
    }
    const timeText = el.getElementsByTagName('time')[0]?.textContent?.trim();
    const t = timeText ? Date.parse(timeText) / 1000 : NaN;
    raw.push({
      t,
      lat,
      lon,
      speed: num(el.getElementsByTagName('speed')[0]),
      ele: num(el.getElementsByTagName('ele')[0]),
    });
  }
  if (badCoord) warnings.push(`${badCoord} track point(s) with invalid coordinates were dropped.`);

  const timed = raw.filter((p) => Number.isFinite(p.t));
  if (timed.length < raw.length) warnings.push(`${raw.length - timed.length} point(s) without a valid time were dropped.`);

  // stable sort keeps file order among equal timestamps
  const indexed = timed.map((p, i) => ({ p, i })).sort((a, b) => a.p.t - b.p.t || a.i - b.i);
  const points: GpxPoint[] = [];
  let conflicts = 0;
  let exact = 0;
  for (const { p } of indexed) {
    const last = points[points.length - 1];
    if (last && last.t === p.t) {
      if (last.lat === p.lat && last.lon === p.lon && (last.speed === p.speed || (isNaN(last.speed) && isNaN(p.speed)))) exact++;
      else conflicts++;
      points[points.length - 1] = p;
    } else points.push(p);
  }
  if (exact) warnings.push(`${exact} exact duplicate point(s) collapsed.`);
  if (conflicts) warnings.push(`${conflicts} timestamp(s) had conflicting points; kept the last in file order.`);
  return { points, warnings, trackName };
}
