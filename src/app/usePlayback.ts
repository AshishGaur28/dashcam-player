import { useEffect, useState } from 'react';
import type { PlaybackController, Snapshot } from '../media/PlaybackController';

/** Subscribes a leaf component to the controller; keep it out of App so the tree does not re-render at 10 Hz. */
export function usePlayback(ctrl: PlaybackController): Snapshot {
  const [s, setS] = useState(() => ctrl.snapshot());
  useEffect(() => ctrl.subscribe(setS), [ctrl]);
  return s;
}

export function fmt(sec: number): string {
  if (!Number.isFinite(sec)) return '–:––';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
