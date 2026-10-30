import { useEffect, useRef } from 'react';
import { fmt, usePlayback } from '../app/usePlayback';
import type { PlaybackController } from '../media/PlaybackController';
import type { Trip } from '../recordings/TripBuilder';
import { clock } from './Timeline';

export function RecordingBrowser({ ctrl, trip, gpsCovered }: { ctrl: PlaybackController; trip: Trip; gpsCovered: (i: number) => boolean }) {
  const s = usePlayback(ctrl);
  const list = useRef<HTMLUListElement>(null);
  const cur = useRef<HTMLLIElement>(null);
  // scroll only the list (never the page), so the playing clip is always its first row
  useEffect(() => {
    if (list.current && cur.current) list.current.scrollTo({ top: cur.current.offsetTop, behavior: 'smooth' });
  }, [s.segIndex]);
  return (
    <ul ref={list} className="clips" aria-label="Clips" style={{ paddingBottom: trip.segments.length > 6 ? 300 : 0 }}>
      {trip.segments.map((g) => (
        <li key={g.key} ref={g.index === s.segIndex ? cur : undefined} className={g.index === s.segIndex ? 'current' : ''}>
          <button onClick={() => ctrl.seek(g.globalStart)}>
            <span className="clip-time">{clock(g.entry.startMs)}</span>
            <span className="muted">{fmt(g.globalStart)} · {g.duration.toFixed(0)} s</span>
            <span className="tags">
              <i className={g.entry.front ? 'ok' : 'miss'}>F</i>
              <i className={g.entry.rear ? 'ok' : 'miss'}>R</i>
              <i className={gpsCovered(g.index) ? 'ok' : 'miss'}>GPS</i>
            </span>
            {g.gapBefore > 0 && <span className="clip-warn">{Math.round(g.gapBefore)} s missing before</span>}
            {g.gapBefore < 0 && <span className="clip-warn">overlaps {Math.round(-g.gapBefore)} s</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
