import type { SpeedUnit } from '../gps/units';

export interface Prefs {
  view: 'pip' | 'front' | 'rear';
  gpsOn: boolean;
  unit: SpeedUnit;
  rate: number;
  audio: 'front' | 'rear' | 'off';
  volume: number;
  /** The corner panel (speed, time, date) over the camera's own burned-in text. */
  panel: boolean;
  /** Seamless overlap between windows (off = simple switch). */
  overlap: boolean;
}

const KEY = 'dashcam-player-prefs-v1';

/** Preferences live in this browser only. Everything is guarded: private windows and blocked storage just mean "defaults". */
export function loadPrefs(): Partial<Prefs> {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}

export function savePrefs(p: Partial<Prefs>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    /* not saved */
  }
}
