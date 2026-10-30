import type { GpxPoint } from '../gps/GpxParser';
import type { Clip } from './Clip';
import { MseClip, type ClipEvent, type ClipState } from './MseClip';
import { probeTs, readBytes, type Probe } from './ts';
import { convert } from './convertAsync';
import type { WindowSpan } from './tsToMp4';

/**
 * A clip played by the browser itself. An .mp4 is used straight from the file (the browser reads and buffers it, so
 * nothing is copied into memory). A raw .TS is converted to a small in-memory MP4 for ONE WINDOW of the recording
 * (see PlaybackController.windowFor), so memory stays bounded however long the recording is. Times given to and
 * returned by this clip are relative to the start of its window.
 */
export class NativeClip implements Clip {
  state: ClipState = 'idle';
  error?: string;
  readonly events: ClipEvent[] = [];
  recoveries = 0;
  droppedFrames = 0;
  totalFrames = 0;
  level: 0 | 1 | 2 = 0;
  probe?: Probe;
  /** Conversion progress of a raw .TS, 0..1. */
  progress = 0;
  /** GPS found inside the part of a raw .TS that was converted. */
  gps?: GpxPoint[];
  private url?: string;
  private fellBack = false;
  private listeners: Array<() => void> = [];

  constructor(
    readonly blob: Blob,
    readonly name: string,
    readonly video: HTMLVideoElement,
    /** The part of a raw .TS this clip plays (seconds into the recording). */
    readonly win?: { start: number; end: number },
  ) {}

  private get isTs() {
    return /\.ts$/i.test(this.name);
  }

  /** What to tell the user while this clip is not playing yet (or why it cannot). */
  get note(): string | undefined {
    if (this.state === 'error') return this.error;
    if (this.state === 'opening') return this.isTs ? `Converting to MP4… ${Math.round(this.progress * 100)}%` : 'Loading…';
    return undefined;
  }

  get loadedFraction(): number {
    if (this.state === 'opening') return this.isTs ? this.progress * 0.97 : 0.02;
    if (this.state !== 'ready') return 0;
    const b = this.video.buffered;
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 && b.length ? Math.min(1, b.end(b.length - 1) / d) : 0.97;
  }

  get duration() {
    if (this.win) return this.win.end - this.win.start;
    return this.probe?.duration ?? this.video.duration;
  }

  get bufferedAhead(): number {
    const t = this.video.currentTime;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 0.25 <= t && t <= b.end(i)) return b.end(i) - t;
    return 0;
  }

  get ready() {
    return this.state === 'ready' && this.video.readyState >= 3 && (this.bufferedAhead >= 3 || this.video.ended || this.bufferedAhead >= this.duration - this.video.currentTime - 0.1);
  }

  private log(type: string, detail?: string) {
    this.events.push({ at: performance.now(), type, detail });
    if (this.events.length > 60) this.events.shift();
  }

  async open(at = 0): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'opening';
    const v = this.video;
    v.preload = 'auto';
    v.playsInline = true;
    for (const e of ['waiting', 'stalled', 'error', 'ended', 'seeking', 'seeked', 'canplay', 'playing']) {
      const f = () => {
        this.log(e, `t=${v.currentTime.toFixed(2)}${v.error ? ` ${v.error.message}` : ''}`);
        if (e === 'error') void this.recoverFromMemory();
      };
      v.addEventListener(e, f);
      this.listeners.push(() => v.removeEventListener(e, f));
    }
    try {
      let src: Blob = this.blob;
      if (this.isTs) {
        this.probe = await probeTs(this.blob);
        const span: WindowSpan = this.win ?? {};
        const r = await convert(this.blob, this.probe, MseClip.defaultLevel, span, () => this.state === 'opening', (f) => (this.progress = f));
        if (!r) return; // released while converting
        src = r.mp4;
        this.gps = r.gps;
        this.droppedFrames = r.dropped;
        this.totalFrames = r.total;
        this.log('converted', `${(src.size / 1048576).toFixed(0)} MB${this.win ? ` for ${this.win.start}–${this.win.end} s` : ''}, ${r.dropped}/${r.total} frames dropped`);
      }
      if ((this.state as ClipState) === 'disposed') return; // released while loading
      const attach = (b: Blob) =>
        new Promise<void>((res, rej) => {
          if (this.url) URL.revokeObjectURL(this.url);
          this.url = URL.createObjectURL(b);
          v.src = this.url;
          v.addEventListener('loadedmetadata', () => res(), { once: true });
          v.addEventListener('error', () => rej(new Error(v.error?.message || 'Cannot decode this MP4')), { once: true });
          setTimeout(() => rej(new Error('MP4 metadata did not load')), 15000);
        });
      try {
        await attach(src);
      } catch (e) {
        // An .mp4 is first played straight from the file. If the browser cannot read it that way (a file on a card, a locked
        // volume), read it into memory in pieces and play that copy instead.
        if (this.isTs || src !== this.blob || src.size > 400 * 1048576) throw e;
        const parts: Uint8Array[] = [];
        for (let pos = 0; pos < src.size; pos += 8 * 1048576) parts.push(await readBytes(src, pos, pos + 8 * 1048576));
        this.fellBack = true;
        this.log('fallback', 'playing a copy held in memory');
        if ((this.state as ClipState) === 'disposed') return;
        await attach(new Blob(parts as BlobPart[], { type: 'video/mp4' }));
      }
      if (at > 0) v.currentTime = at;
      this.state = 'ready';
    } catch (e) {
      this.state = 'error';
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  /** The browser lost its read of the file while playing it straight from disk: carry on from a copy held in memory. */
  private async recoverFromMemory() {
    if (this.fellBack || this.isTs || this.state !== 'ready' || this.blob.size > 400 * 1048576) return;
    this.fellBack = true;
    const v = this.video;
    const t = v.currentTime;
    const wasPlaying = !v.paused;
    try {
      const parts: Uint8Array[] = [];
      for (let pos = 0; pos < this.blob.size; pos += 8 * 1048576) parts.push(await readBytes(this.blob, pos, pos + 8 * 1048576));
      if ((this.state as ClipState) === 'disposed') return;
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: 'video/mp4' }));
      v.src = this.url;
      await new Promise<void>((res, rej) => {
        v.addEventListener('loadedmetadata', () => res(), { once: true });
        v.addEventListener('error', () => rej(new Error(v.error?.message || 'Cannot decode this MP4')), { once: true });
      });
      v.currentTime = t;
      if (wasPlaying) await v.play().catch(() => undefined);
      this.log('fallback', 'recovered from a copy held in memory');
    } catch (e) {
      this.state = 'error';
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  async seek(t: number) {
    if (this.state === 'ready') this.video.currentTime = t;
  }

  setAhead() {
    /* the browser decides how much to buffer */
  }

  dispose() {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.listeners.forEach((f) => f());
    this.listeners = [];
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.gps = undefined;
  }
}
