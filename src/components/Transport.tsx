import { useEffect, useRef } from 'react';
import { fmt, usePlayback } from '../app/usePlayback';
import type { PlaybackController } from '../media/PlaybackController';
import type { Trip } from '../recordings/TripBuilder';
import { IconBack10, IconFullscreen, IconFwd10, IconNext, IconPause, IconPlay, IconPrev, IconVolume } from './icons';
import { Timeline } from './Timeline';

const RATES = [0.5, 1, 1.5, 2, 4];

export function Transport({ ctrl, trip, gpsCovered, mapOnly = false }: { ctrl: PlaybackController; trip: Trip; gpsCovered: (i: number) => boolean; mapOnly?: boolean }) {
  const s = usePlayback(ctrl);

  // the source to come back to when un-muting
  const lastSource = useRef<'front' | 'rear'>('front');
  if (s.audio !== 'off') lastSource.current = s.audio;
  const muted = s.audio === 'off' || s.volume === 0;
  const toggleMute = () => {
    if (s.audio === 'off') ctrl.setAudio(lastSource.current);
    else if (s.volume === 0) ctrl.setVolume(0.8);
    else ctrl.setAudio('off');
  };
  const fullscreen = () => {
    const el = document.querySelector<HTMLElement & { webkitRequestFullscreen?: () => void }>('.stage');
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen();
    else el?.webkitRequestFullscreen?.();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Element | null;
      if ((target && 'closest' in target && target.closest('input,select,textarea')) || e.metaKey || e.ctrlKey || e.altKey) return;
      const step = (dir: 1 | -1) => ctrl.setRate(RATES[Math.min(RATES.length - 1, Math.max(0, RATES.indexOf(s.rate) + dir))]!);
      switch (e.key) {
        case ' ':
          e.preventDefault();
          void (s.wantPlay ? ctrl.pause() : ctrl.play());
          break;
        case 'ArrowLeft':
          ctrl.seekBy(e.shiftKey ? -30 : -5);
          break;
        case 'ArrowRight':
          ctrl.seekBy(e.shiftKey ? 30 : 5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          ctrl.setVolume(Math.min(1, s.volume + 0.1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          ctrl.setVolume(Math.max(0, s.volume - 0.1));
          break;
        case '[':
          ctrl.jumpSegment(-1);
          break;
        case ']':
          ctrl.jumpSegment(1);
          break;
        case ',':
          step(-1);
          break;
        case '.':
          step(1);
          break;
        case 'Home':
          ctrl.seek(0);
          break;
        case 'End':
          ctrl.seek(trip.totalDuration);
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'f':
        case 'F':
          if (!mapOnly) fullscreen();
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="transport">
      <Timeline ctrl={ctrl} trip={trip} gpsCovered={gpsCovered} />
      <div className="tp-row">
        <div className="tp-btns">
          <button className="icon" onClick={() => ctrl.jumpSegment(-1)} aria-label="Previous clip" title="Previous clip ([)">
            <IconPrev />
          </button>
          <button className="icon" onClick={() => ctrl.seekBy(-10)} aria-label="Back 10 seconds" title="Back 10 seconds (←: 5)">
            <IconBack10 />
          </button>
          <button className="play" onClick={() => void (s.wantPlay ? ctrl.pause() : ctrl.play())} aria-label={s.wantPlay ? 'Pause' : 'Play'} title="Play / pause (space)">
            {s.wantPlay ? <IconPause /> : <IconPlay />}
          </button>
          <button className="icon" onClick={() => ctrl.seekBy(10)} aria-label="Forward 10 seconds" title="Forward 10 seconds (→: 5)">
            <IconFwd10 />
          </button>
          <button className="icon" onClick={() => ctrl.jumpSegment(1)} aria-label="Next clip" title="Next clip (])">
            <IconNext />
          </button>
        </div>
        <div className="tp-time">
          <span>
            {fmt(s.t)} / {fmt(s.total)} · clip {s.segIndex + 1}/{s.segCount}
          </span>
        </div>
        <span className={`pill phase-${s.phase}`}>{s.phase}</span>
        <div className="tp-opts">
          <div className="seg-control small" role="group" aria-label="Playback speed">
            {RATES.map((r) => (
              <button key={r} className={s.rate === r ? 'on' : ''} onClick={() => ctrl.setRate(r)} title={`Speed ${r}×${r === 1 ? ' (normal)' : ''}`}>
                {r}×
              </button>
            ))}
          </div>
          {!mapOnly && (
            <>
              <button className="icon" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
                <IconVolume muted={muted} />
              </button>
              <input className="vol" type="range" min={0} max={1} step={0.05} value={s.audio === 'off' ? 0 : s.volume} aria-label="Volume" title="Volume (↑ ↓)" onChange={(e) => {
                if (s.audio === 'off' && +e.target.value > 0) ctrl.setAudio(lastSource.current);
                ctrl.setVolume(+e.target.value);
              }} />
              <div className="seg-control small" role="group" aria-label="Sound from">
                {(['front', 'rear'] as const).map((c) => (
                  <button key={c} className={s.audio === c ? 'on' : ''} onClick={() => ctrl.setAudio(c)} title={`Hear the ${c} camera`}>
                    {c === 'front' ? 'Front' : 'Rear'}
                  </button>
                ))}
              </div>
              <button className="icon" onClick={fullscreen} aria-label="Full screen" title="Full screen (F)">
                <IconFullscreen />
              </button>
            </>
          )}
        </div>
      </div>
      {s.message && <p className="notice" role="status">{s.message}</p>}
    </div>
  );
}
