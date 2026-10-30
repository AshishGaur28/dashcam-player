import { useEffect, useState } from 'react';
import { fmt } from '../app/usePlayback';
import type { Loaded } from '../app/loadTrip';
import type { PlaybackController } from '../media/PlaybackController';
import { VERSION_LABEL } from '../version';

type Diag = ReturnType<PlaybackController['diagnostics']>;
type Snap = ReturnType<PlaybackController['snapshot']>;

function browserName(ua: string) {
  const m = /(Edg|Chrome|Firefox|Version)\/([\d.]+)/.exec(ua);
  const name = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${name} ${m?.[2]?.split('.')[0] ?? ''}`.trim();
}

const COUNTERS: Array<[keyof Diag['counters'], string, string]> = [
  ['stalls', 'Stalls', 'Times the picture froze because the data ran out'],
  ['waiting', 'Waits', 'Times the browser reported it was waiting for data'],
  ['driftCorrections', 'Sync corrections', 'Times the rear camera was nudged to match the front'],
  ['seeks', 'Seeks', 'Jumps you made on the timeline'],
  ['gapJumps', 'Gap jumps', 'Holes in the video that were skipped'],
  ['masterSwitches', 'Camera switches', 'Times the other camera had to lead because one froze'],
  ['heals', 'Self-heals', 'Times playback stopped by itself and was restarted automatically'],
  ['overlapFallbacks', 'Overlap fallbacks', 'Times the seamless overlap could not line up and the plain switch was used'],
  ['fallbacks', 'Fallbacks', 'Times the player switched to streaming because the browser showed no picture'],
  ['playRejections', 'Blocked plays', 'Times the browser refused to start playing'],
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="dsec">
      <h4>
        {title}
        {hint && <small>{hint}</small>}
      </h4>
      {children}
    </section>
  );
}

function report(d: Diag, s: Snap, L: Loaded | null, gpsOffset: number): string {
  const lines = [`Dashcam Player report`, `Version: ${VERSION_LABEL}`, `Browser: ${navigator.userAgent}`, `Engine: ${d.engine}`, `Position: ${fmt(s.t)} of ${fmt(s.total)} (clip ${s.segIndex + 1}/${s.segCount})`, `Phase: ${d.phase}`, ``, `Counters`];
  for (const [k, label] of COUNTERS) lines.push(`  ${label}: ${d.counters[k]}`);
  lines.push('', 'Clips in memory');
  for (const sl of d.slots) for (const c of sl.cams) lines.push(`  ${sl.slot} ${c.cam}: ${c.file ?? '–'} · ${c.state}${c.error ? ` (${c.error})` : ''} · window ${sl.window ? sl.window.join('–') + ' s' : '–'} · buffered ${c.bufferedAhead ?? '–'} s · frames ${c.totalFrames ?? '–'} (dropped ${c.dropped ?? '–'})`);
  lines.push('', 'Hand-overs');
  for (const t of d.transitions) lines.push(`  to clip ${t.toSegment + 1}: waited ${t.waitedMs} ms, ready in advance ${t.standbyReadyBeforeEnd ? 'yes' : 'no'}, frame gap ${t.frameGapMs ?? '–'} ms, lined up to ${t.alignMs ?? 'n/a'} ms`);
  if (L) {
    lines.push('', `GPS: ${L.gps.timeline.length} samples, offset ${gpsOffset} s`);
    for (const g of L.gpx) lines.push(`  ${g.name}: ${g.count} points (${g.mode})${g.warnings.length ? ' – ' + g.warnings.join('; ') : ''}`);
    lines.push('', `Trip: ${L.trip.segments.length} clips, ${fmt(L.trip.totalDuration)}`);
    lines.push(...L.warnings.map((w) => `  warning: ${w}`));
  }
  return lines.join('\n');
}

/** Everything the player knows about itself, laid out to read: nothing here is needed for normal use. */
export function DiagnosticsPanel({ ctrl, loaded, gpsOffset }: { ctrl: PlaybackController; loaded: Loaded | null; gpsOffset: number }) {
  const [state, setState] = useState<{ d: Diag; s: Snap }>(() => ({ d: ctrl.diagnostics(), s: ctrl.snapshot() }));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const id = setInterval(() => setState({ d: ctrl.diagnostics(), s: ctrl.snapshot() }), 1000);
    return () => clearInterval(id);
  }, [ctrl]);
  const { d, s } = state;
  const L = loaded;
  const bad = d.counters.stalls + d.counters.fallbacks + d.counters.gapJumps;
  const clips = d.slots.flatMap((sl) => sl.cams.filter((c) => c.state !== 'none').map((c) => ({ ...c, slot: sl.slot, window: sl.window, segment: sl.segment })));

  return (
    <section className="diag" aria-label="Diagnostics">
      <div className="dhead">
        <div className="chips">
          <span>{VERSION_LABEL}</span>
          <span>{browserName(navigator.userAgent)}</span>
          <span>{d.engine}</span>
          <span className={d.phase === 'playing' ? 'ok' : ''}>{d.phase}</span>
          <span className={bad ? 'warn' : 'ok'}>{bad ? 'problems seen' : 'running clean'}</span>
        </div>
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(report(d, s, L, gpsOffset)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
      </div>

      <Section title="Position">
        <dl className="kv">
          <dt>Trip time</dt>
          <dd>{fmt(s.t)} of {fmt(s.total)}</dd>
          <dt>Clip</dt>
          <dd>{s.segIndex + 1} of {s.segCount} · {fmt(s.segLocal)} in</dd>
          <dt>Front ↔ rear</dt>
          <dd>{s.drift === null ? '–' : `${Math.round(s.drift * 1000)} ms apart`}</dd>
          <dt>Next part</dt>
          <dd>{s.buffer?.next ? (s.buffer.next.ready ? 'ready' : `preparing, ${Math.round(s.buffer.next.fraction * 100)}%`) : '–'}</dd>
        </dl>
      </Section>

      <Section title="Playback health" hint="all zero is ideal">
        <dl className="kv counters">
          {COUNTERS.map(([k, label, tip]) => (
            <div key={k} title={tip} className={d.counters[k] && k !== 'seeks' ? 'hot' : ''}>
              <dt>{label}</dt>
              <dd>{d.counters[k]}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="Clips in memory" hint="the current part and the next one">
        <div className="tscroll">
          <table className="dtable">
            <thead>
              <tr>
                <th>Part</th>
                <th>Camera</th>
                <th>Clip</th>
                <th>State</th>
                <th>Window</th>
                <th>Buffered</th>
                <th>Frames shown / dropped</th>
              </tr>
            </thead>
            <tbody>
              {clips.map((c) => (
                <tr key={`${c.slot}${c.cam}`} className={c.state === 'error' ? 'bad' : ''}>
                  <td>{c.slot === 'active' ? 'Playing' : 'Next'}</td>
                  <td>{c.cam === 'front' ? 'Front' : 'Rear'}</td>
                  <td className="mono">{c.segment ?? '–'}</td>
                  <td>
                    {c.state}
                    {c.error && <div className="err">{c.error}</div>}
                  </td>
                  <td>{c.window ? `${c.window[0]}–${c.window[1]} s` : '–'}</td>
                  <td>{c.bufferedAhead === null ? '–' : `${c.bufferedAhead} s`}</td>
                  <td>
                    {c.totalFrames ?? '–'} / {c.dropped ?? '–'}
                  </td>
                </tr>
              ))}
              {!clips.length && (
                <tr>
                  <td colSpan={7} className="muted">Nothing loaded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Hand-overs" hint="between windows and clips; the gap is how long the picture was held">
        {d.transitions.length ? (
          <div className="tscroll">
            <table className="dtable">
              <thead>
                <tr>
                  <th>To clip</th>
                  <th>Ready in advance</th>
                  <th>Waited</th>
                  <th>Picture gap</th>
                  <th>Switch</th>
                  <th>Lined up to</th>
                </tr>
              </thead>
              <tbody>
                {[...d.transitions].reverse().map((t, i) => (
                  <tr key={i}>
                    <td>{t.toSegment + 1}</td>
                    <td>{t.standbyReadyBeforeEnd ? 'yes' : 'no'}</td>
                    <td>{t.waitedMs} ms</td>
                    <td className={t.frameGapMs !== undefined && t.frameGapMs > 120 ? 'warn' : ''}>{t.frameGapMs === undefined ? '–' : `${t.frameGapMs} ms`}</td>
                    <td>{t.mode === 'overlap' ? 'seamless' : t.mode === 'fallback' ? 'overlap failed, plain' : t.mode === 'plain' ? 'plain' : '–'}</td>
                    <td className={t.alignMs !== undefined && Math.abs(t.alignMs) > 70 ? 'warn' : ''}>{t.alignMs === undefined ? 'new clip' : `${t.alignMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">None yet.</p>
        )}
      </Section>

      {L && (
        <>
          <Section title="GPS">
            <dl className="kv">
              <dt>Samples</dt>
              <dd>{L.gps.timeline.length}</dd>
              <dt>Offset</dt>
              <dd>{gpsOffset} s</dd>
              <dt>Source</dt>
              <dd>{L.gpx.length ? `${L.gpx.length} GPX file(s)` : 'the camera’s own GPS, read as each part is prepared'}</dd>
            </dl>
            {L.gpx.length > 0 && (
              <div className="tscroll">
                <table className="dtable">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Points</th>
                      <th>Use</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {L.gpx.map((g) => (
                      <tr key={g.name}>
                        <td className="mono">{g.name}</td>
                        <td>{g.count}</td>
                        <td>{g.mode === 'trip-wide' ? 'whole trip' : 'one clip'}</td>
                        <td>{g.warnings.join(' · ') || '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          <Section title="Trip">
            <dl className="kv">
              <dt>Clips</dt>
              <dd>{L.trip.segments.length}</dd>
              <dt>Total length</dt>
              <dd>{fmt(L.trip.totalDuration)}</dd>
              <dt>Missing footage</dt>
              <dd>{L.trip.segments.filter((g) => g.gapBefore > 0).length ? L.trip.segments.filter((g) => g.gapBefore > 0).map((g) => `${Math.round(g.gapBefore)} s before ${g.key}`).join(' · ') : 'none'}</dd>
            </dl>
          </Section>

          <Section title="Warnings">
            {L.warnings.length ? (
              <ul className="warns">
                {L.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">None.</p>
            )}
          </Section>
        </>
      )}
    </section>
  );
}
