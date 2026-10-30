import { usePlayback } from '../app/usePlayback';
import type { GpsTimeline } from '../gps/GpsTimeline';
import type { PlaybackController } from '../media/PlaybackController';
import type { Trip } from '../recordings/TripBuilder';
import { ARROW_CENTER, ARROW_PATH } from './arrow';
import { clock } from './Timeline';

const cardinal = (h: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((h % 360) + 360) % 360) / 45) % 8]!;

/** Speed / position card (sidebar) and the compact on-video readout (HUD) share one lookup. */
export function Telemetry({ ctrl, gps, gpsOffset, hud = false, trip, showGps = true }: { ctrl: PlaybackController; gps: GpsTimeline; gpsOffset: number; hud?: boolean; trip?: Trip; showGps?: boolean }) {
  const s = usePlayback(ctrl);
  const fix = gps.at(s.t - gpsOffset);
  const ok = fix.state === 'ok';
  const speed = fix.speedKmh === undefined ? '–' : String(Math.round(fix.speedKmh));
  if (hud) {
    // speed, time of day and date of the moment on screen (the clip's start from its file name + how far into it we are)
    const seg = trip?.segments[s.segIndex];
    const ms = seg ? seg.entry.startMs + s.segLocal * 1000 : NaN;
    if (!Number.isFinite(ms)) return null; // nothing to show: no panel
    const moving = ok && (fix.speedKmh ?? 0) >= 1;
    return (
      <div className="hud" aria-hidden="true">
        {showGps && ok && (
          <div className={`hud-speed ${moving ? 'moving' : ''}`}>
            <b>{speed}</b>
            <span>km/h</span>
          </div>
        )}
        <div className="hud-when">
          <time className="hud-time">{clock(ms)}</time>
          <span className="hud-date">{new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span>
        </div>
      </div>
    );
  }
  const state = !gps.length ? 'No GPS data' : ok ? 'GPS locked' : 'No GPS signal here';
  const stateTip = !gps.length ? 'No position data has been read from these recordings yet.' : ok ? 'GPS fix: the camera’s receiver had a valid satellite position at this moment, so speed, position and heading are real.' : 'The camera had no valid GPS position at this moment (for example in a tunnel or just after starting).';
  return (
    <section className="card tele" aria-label="GPS telemetry">
      <div className="tele-info">
        <div className="tele-speed">
          <b>{speed}</b>
          <span>km/h</span>
        </div>
        <dl>
          <dt>Heading</dt>
          <dd>{fix.heading === undefined ? '–' : `${cardinal(fix.heading)} ${Math.round(fix.heading)}°`}</dd>
          <dt>Latitude</dt>
          <dd>{fix.lat === undefined ? '–' : fix.lat.toFixed(6)}</dd>
          <dt>Longitude</dt>
          <dd>{fix.lon === undefined ? '–' : fix.lon.toFixed(6)}</dd>
        </dl>
        <span className={`pill ${ok ? 'pill-ok' : 'pill-warn'}`} title={stateTip}>{state}</span>
      </div>
      <div className="compass" title={fix.heading === undefined ? 'Heading unknown' : `Heading ${Math.round(fix.heading)}°`}>
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="46" className="c-ring" />
          {[0, 90, 180, 270].map((a) => (
            <line key={a} x1="50" y1="5" x2="50" y2="11" className="c-tick" transform={`rotate(${a} 50 50)`} />
          ))}
          <text x="50" y="26" className="c-n">N</text>
          <text x="78" y="54" className="c-l">E</text>
          <text x="50" y="82" className="c-l">S</text>
          <text x="22" y="54" className="c-l">W</text>
          <g className="c-needle" style={{ transform: `rotate(${fix.heading ?? 0}deg)`, opacity: fix.heading === undefined ? 0.25 : 1 }}>
            <path d={ARROW_PATH} transform={`translate(50 50) scale(0.85) translate(${-ARROW_CENTER.x} ${-ARROW_CENTER.y})`} />
          </g>
        </svg>
      </div>
    </section>
  );
}
