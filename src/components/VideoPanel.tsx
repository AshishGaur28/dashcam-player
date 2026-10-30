import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePlayback } from '../app/usePlayback';
import type { Cam, PlaybackController } from '../media/PlaybackController';
import { IconPause, IconPlay, IconSwap } from './icons';

const LABEL: Record<Cam, string> = { front: 'Front', rear: 'Rear' };
export type PanelRole = 'main' | 'mini' | 'hidden';

export function VideoPanel({ ctrl, cam, role, onPick, hud }: { ctrl: PlaybackController; cam: Cam; role: PanelRole; onPick?: () => void; hud?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const snap = usePlayback(ctrl);
  useEffect(() => {
    if (host.current) ctrl.mount(cam, host.current);
  }, [ctrl, cam]);
  const status = snap.cams[cam];
  // a click on the picture plays / pauses it; the icon flashes briefly to confirm
  const [flash, setFlash] = useState<{ id: number; kind: 'play' | 'pause' } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toggle = () => {
    const playing = snap.wantPlay;
    void (playing ? ctrl.pause() : ctrl.play());
    // the id only changes on a click, so the animation plays once (a key that changed on every refresh made it blink)
    setFlash((f) => ({ id: (f?.id ?? 0) + 1, kind: playing ? 'pause' : 'play' }));
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 650);
  };
  const fullscreen = () => {
    const el = panel.current as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen();
    else el?.webkitRequestFullscreen?.();
  };
  return (
    <section ref={panel} className={`vp vp-${role}`} hidden={role === 'hidden'} aria-label={`${LABEL[cam]} camera`}>
      <div ref={host} className="stack" />
      {/* opaque corner panel over the text the camera burned into the picture's bottom-left; absent when it has nothing to show or is switched off */}
      {role !== 'mini' && (
        <button className="vp-click" onClick={toggle} aria-label={snap.wantPlay ? 'Pause' : 'Play'} title={snap.wantPlay ? 'Click to pause' : 'Click to play'} />
      )}
      {flash && (
        <div className="vp-flash" key={flash.id} aria-hidden="true">
          {flash.kind === 'play' ? <IconPlay /> : <IconPause />}
        </div>
      )}
      {hud && role !== 'mini' && <div className="vp-hud">{hud}</div>}
      <span className="vp-label">{LABEL[cam]}</span>
      {role === 'mini' ? (
        <button className="vp-hit" onClick={onPick} aria-label={`Show ${LABEL[cam]} large`} title="Click to swap with the big picture">
          <span className="vp-swap">
            <IconSwap />
          </span>
        </button>
      ) : (
        <button className="vp-fs" onClick={fullscreen} aria-label={`Full screen ${LABEL[cam]}`} title="Full screen">
          ⛶
        </button>
      )}
      {status !== 'ok' && (
        <div className="vp-note">
          {status === 'missing' && `No ${cam} footage for this clip`}
          {status === 'loading' && (
            <span className="prep">
              <span className="spin" aria-label="Preparing" />
              {snap.progress[cam] !== undefined && snap.progress[cam]! > 0 ? (
                <span className="bar" role="progressbar" aria-valuenow={Math.round(snap.progress[cam]! * 100)}>
                  <i style={{ width: `${Math.round(snap.progress[cam]! * 100)}%` }} />
                </span>
              ) : null}
              <small>{snap.notes[cam] ?? 'Preparing…'}</small>
            </span>
          )}
          {status === 'error' && `${LABEL[cam]} clip could not be played${snap.notes[cam] ? `: ${snap.notes[cam]}` : ''}`}
        </div>
      )}
      {snap.phase === 'buffering' && role !== 'mini' && <div className="vp-badge">Buffering…</div>}
    </section>
  );
}
