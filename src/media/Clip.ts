import type { ClipEvent, ClipState } from './MseClip';
import type { Probe } from './ts';

/** What PlaybackController needs from a playable file (MPEG-TS via MediaSource, or a repaired MP4). */
export interface Clip {
  readonly name: string;
  readonly blob: Blob;
  readonly video: HTMLVideoElement;
  state: ClipState;
  error?: string;
  readonly events: ClipEvent[];
  readonly duration: number;
  readonly bufferedAhead: number;
  readonly ready: boolean;
  recoveries: number;
  droppedFrames: number;
  totalFrames: number;
  level: 0 | 1 | 2;
  probe?: Probe;
  /** Progress or error text for the viewer. */
  readonly note?: string;
  /** 0..1 while a raw .TS is being converted. */
  readonly progress?: number;
  /** 0..1: how much of this clip (window) is prepared or buffered. */
  readonly loadedFraction: number;
  /** GPS already read from the file as a by-product of opening it. */
  readonly gps?: import('../gps/GpxParser').GpxPoint[];
  open(at?: number, ahead?: number): Promise<void>;
  seek(t: number): Promise<void>;
  setAhead(seconds: number): void;
  dispose(): void;
}
