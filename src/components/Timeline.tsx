import { useRef, useState } from 'react';
import { fmt, usePlayback } from '../app/usePlayback';
import type { PlaybackController } from '../media/PlaybackController';
import type { Trip } from '../recordings/TripBuilder';

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

/** The whole trip as one strip of clips: click or drag anywhere; hover shows the time of day. */
export function Timeline({ ctrl, trip, gpsCovered }: { ctrl: PlaybackController; trip: Trip; gpsCovered: (i: number) => boolean }) {
  const s = usePlayback(ctrl);
  const el = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ f: number; t: number } | null>(null);
  const total = trip.totalDuration || 1;
  const pos = (e: React.PointerEvent) => {
    const r = el.current!.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return { f, t: f * total };
  };
  const label = (t: number) => {
    const g = trip.segments.find((x) => t >= x.globalStart && t < x.globalEnd) ?? trip.segments[trip.segments.length - 1];
    return g ? `${fmt(t)} · ${clock(g.entry.startMs + Math.max(0, t - g.globalStart) * 1000)}` : fmt(t);
  };
  const shown = drag ?? s.t;
  return (
    <div
      ref={el}
      className="tl"
      role="slider"
      tabIndex={0}
      aria-label="Trip timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(total)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={fmt(shown)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pos(e);
        setDrag(p.t);
        ctrl.seek(p.t);
      }}
      onPointerMove={(e) => {
        const p = pos(e);
        setHover(p);
        if (drag !== null) {
          setDrag(p.t);
          ctrl.seek(p.t);
        }
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setHover(null)}
    >
      <div className="tl-track">
        {trip.segments.map((g) => (
          <div
            key={g.key}
            className={`tl-seg ${gpsCovered(g.index) ? 'gps' : ''} ${g.entry.front && g.entry.rear ? '' : 'partial'} ${g.gapBefore > 0 ? 'gap' : ''}`}
            style={{ left: `${(g.globalStart / total) * 100}%`, width: `${(g.duration / total) * 100}%` }}
          />
        ))}
        <div className="tl-done" style={{ width: `${(shown / total) * 100}%` }} />
        <div className={`tl-head ${s.phase === 'buffering' || s.phase === 'seeking' ? 'wait' : ''}`} style={{ left: `${(shown / total) * 100}%` }} />
      </div>
      {s.buffer && (
        <div
          className="tl-buf"
          title={`Ready: ${fmt(s.buffer.ready.from)}–${fmt(s.buffer.ready.to)}${s.buffer.next ? ` · next ${fmt(s.buffer.next.from)}–${fmt(s.buffer.next.to)}: ${s.buffer.next.ready ? 'ready' : `${Math.round(s.buffer.next.fraction * 100)}%`}` : ''}`}
        >
          <i className="b-ready" style={{ left: `${(s.buffer.ready.from / total) * 100}%`, width: `${(Math.max(0, s.buffer.ready.to - s.buffer.ready.from) / total) * 100}%` }} />
          {s.buffer.next && (
            <>
              <i className="b-next" style={{ left: `${(s.buffer.next.from / total) * 100}%`, width: `${((s.buffer.next.to - s.buffer.next.from) / total) * 100}%` }} />
              <i className={`b-fill ${s.buffer.next.ready ? 'done' : 'busy'}`} style={{ left: `${(s.buffer.next.from / total) * 100}%`, width: `${((s.buffer.next.to - s.buffer.next.from) * (s.buffer.next.ready ? 1 : s.buffer.next.fraction) / total) * 100}%` }} />
            </>
          )}
        </div>
      )}
      {hover && (
        <div className="tl-tip" style={{ left: `${hover.f * 100}%` }}>
          {label(hover.t)}
        </div>
      )}
    </div>
  );
}
