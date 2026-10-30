import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';
import type { PlaybackController } from '../media/PlaybackController';
import type { GpsTimeline } from '../gps/GpsTimeline';
import { ARROW_PATH } from './arrow';

/** Map is fed by its own subscription and never touches the media path. */
/** `ctrl` is absent on the loading page: just the route, no car, no seeking. */
export function RouteMap({ ctrl, gps, gpsOffset, tall = false }: { ctrl?: PlaybackController; gps: GpsTimeline; gpsOffset: number; tall?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | undefined>(undefined);
  const marker = useRef<L.Marker | undefined>(undefined);
  const bounds = useRef<L.LatLngBounds | undefined>(undefined);
  const offset = useRef(gpsOffset);
  const [tilesFailed, setTilesFailed] = useState(false);
  const [follow, setFollow] = useState(!tall && !!ctrl); // the map-only screen starts on the whole route
  const followRef = useRef(follow);
  const zoomed = useRef(false);
  offset.current = gpsOffset;
  followRef.current = follow;

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true }).setView([0, 0], 2);
    const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap contributors',
    });
    let errs = 0;
    tiles.on('tileerror', () => ++errs > 3 && setTilesFailed(true));
    tiles.on('tileload', () => {
      errs = 0;
      setTilesFailed(false);
    });
    tiles.addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = undefined;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const layers: L.Layer[] = [];
    const segs = gps.routeSegments();
    for (const s of segs) {
      const line = L.polyline(s, { color: '#4da3ff', weight: 4, opacity: 0.85 }).addTo(m);
      line.on('click', (e: L.LeafletMouseEvent) => {
        const t = gps.nearestTime(e.latlng.lat, e.latlng.lng);
        if (t !== null) ctrl?.seek(t + offset.current);
      });
      layers.push(line);
    }
    if (gps.length) {
      const dot = (c: string) => L.divIcon({ className: '', html: `<div class="dot" style="background:${c}"></div>`, iconSize: [14, 14] });
      layers.push(L.marker([gps.lat[0]!, gps.lon[0]!], { icon: dot('#3ddc84'), interactive: false }).addTo(m));
      const n = gps.length - 1;
      layers.push(L.marker([gps.lat[n]!, gps.lon[n]!], { icon: dot('#ff5d5d'), interactive: false }).addTo(m));
      const first = !bounds.current;
      bounds.current = L.latLngBounds(segs.flat());
      // the route only grows: fit once, never snap the view back when a later clip is appended
      // map-only screen: keep the whole route in view while more of it is being read
      if ((first || tall || !ctrl) && !followRef.current) m.fitBounds(bounds.current.pad(0.15));
    }
    if (ctrl) marker.current = L.marker([0, 0], {
      icon: L.divIcon({ className: '', html: `<div class="car"><span class="car-dot"></span><svg class="arrow" viewBox="0 0 40 40" width="24" height="24"><path d="${ARROW_PATH}" /></svg></div>`, iconSize: [24, 24] }),
      opacity: 0,
      interactive: false,
      zIndexOffset: 1000,
    }).addTo(m);
    if (marker.current) layers.push(marker.current);
    return () => layers.forEach((l) => l.remove());
  }, [gps, ctrl, tall]);

  useEffect(
    () =>
      ctrl?.subscribe((s) => {
        const mk = marker.current;
        if (!mk) return;
        const fix = gps.at(s.t - offset.current);
        if (fix.state !== 'ok') return void mk.setOpacity(0);
        mk.setLatLng([fix.lat!, fix.lon!]).setOpacity(1);
        const m = map.current;
        if (m && followRef.current) {
          if (!zoomed.current) {
            zoomed.current = true;
            m.setView(mk.getLatLng(), Math.max(m.getZoom(), 16), { animate: false });
          } else if (!m.getBounds().pad(-0.3).contains(mk.getLatLng())) m.panTo(mk.getLatLng(), { animate: true, duration: 0.5 });
        }
        const arrow = mk.getElement()?.querySelector<HTMLElement>('.arrow');
        const dot = mk.getElement()?.querySelector<HTMLElement>('.car-dot');
        if (arrow) arrow.style.transform = fix.heading === undefined ? 'none' : `rotate(${fix.heading}deg)`;
        if (arrow) arrow.style.opacity = fix.heading === undefined ? '0' : '1';
        if (dot) dot.style.opacity = fix.heading === undefined ? '1' : '0';
      }),
    [ctrl, gps],
  );

  return (
    <section className="card map-panel" aria-label="Route map">
      <header>
        <h2>Route</h2>
        {ctrl && (
        <label className="check">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => {
              zoomed.current = false;
              setFollow(e.target.checked);
            }}
          />{' '}
          Follow car
        </label>
        )}
        <button className="ghost" onClick={() => bounds.current && map.current?.fitBounds(bounds.current.pad(0.15))} disabled={!gps.length}>
          Fit route
        </button>
      </header>
      <div ref={el} className={`map ${tall ? 'tall' : ''}`} />
      {!gps.length && <p className="map-note">No GPS yet: it appears as soon as a clip with GPS data is prepared.</p>}
      {tilesFailed && <p className="notice">Map tiles unavailable (offline?). OpenStreetMap tiles need a network connection; playback and telemetry continue.</p>}
    </section>
  );
}
