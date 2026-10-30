import mux, { type TransmuxSegment } from 'mux.js';
import type { Clip } from './Clip';
import { patchLastDuration } from './fmp4';
import type { RepairLevel } from './ts';
import { DTS_DELAY_TICKS, DtsFixer, probeTs, readBytes, scanKeyframes, TsBlockSplitter, TsPacketReader, type Keyframe, type Probe } from './ts';

/** Bytes read from the File per step (browser-managed; never the whole file). */
const READ_CHUNK = 1024 * 1024;
const BLOCK_TARGET = 768 * 1024; // ≈0.5 s of video at the camera's ~12 Mbit/s
export const ACTIVE_AHEAD_S = 20;
export const STANDBY_AHEAD_S = 3;
const KEEP_BEHIND_S = 8;

export type ClipState = 'idle' | 'opening' | 'ready' | 'error' | 'disposed';

export interface ClipEvent {
  at: number;
  type: string;
  detail?: string;
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

/**
 * One recording file played through MediaSource: MPEG-TS is resynced, split on frame boundaries,
 * transmuxed to fragmented MP4 by mux.js and appended with bounded look-ahead, so a ~90 MB file is
 * never held in memory. Safari does not play raw .TS in <video>, hence this pipeline.
 */
export class MseClip implements Clip {
  /** Level for newly opened clips (user setting). */
  static defaultLevel: RepairLevel = 0;
  /** Stream raw .TS through MediaSource instead of converting each clip to MP4 first (see tsToMp4.ts). */
  static stream = false;
  /** How aggressively damaged frames are removed; escalated after decode errors (see TsBlockSplitter). */
  level: RepairLevel = MseClip.defaultLevel;
  state: ClipState = 'idle';
  error?: string;
  droppedFrames = 0;
  totalFrames = 0;
  /** Times the decoder aborted on damaged data and we resumed from the next keyframe. */
  recoveries = 0;
  private recovering = false;
  /** Furthest position known to be good; a rebuilt element reports 0, which must never restart a clip. */
  private resumeFrom = 0;
  probe?: Probe;
  readonly events: ClipEvent[] = [];
  /** Seconds; set once probed. */
  get duration() {
    return this.probe?.duration ?? NaN;
  }

  private ms?: MediaSource;
  private sb?: SourceBuffer;
  private url?: string;
  private gen = 0;
  private pumpDone: Promise<void> = Promise.resolve();
  private ahead = STANDBY_AHEAD_S;
  private wakeFn?: () => void;
  private keyframes?: Keyframe[];
  private mime?: string;
  private needInit = true;
  private eof = false;
  private listeners: Array<() => void> = [];

  constructor(
    readonly blob: Blob,
    readonly name: string,
    readonly video: HTMLVideoElement,
  ) {}

  private log(type: string, detail?: string) {
    this.events.push({ at: performance.now(), type, detail });
    if (this.events.length > 60) this.events.shift();
  }

  private on<K extends keyof HTMLMediaElementEventMap>(t: EventTarget, ev: K | string, fn: () => void) {
    t.addEventListener(ev, fn);
    this.listeners.push(() => t.removeEventListener(ev, fn));
  }

  /** Attach to the element and start buffering from `at` seconds. */
  async open(at = 0, ahead = STANDBY_AHEAD_S): Promise<void> {
    if (this.state !== 'idle') return;
    this.state = 'opening';
    this.ahead = ahead;
    try {
      this.probe = await probeTs(this.blob);
      this.log('probed', `${this.probe.duration.toFixed(2)}s`);
      const v = this.video;
      v.preload = 'auto';
      v.playsInline = true;
      for (const e of ['waiting', 'stalled', 'error', 'ended', 'seeking', 'seeked', 'canplay', 'loadeddata', 'playing'])
        this.on(v, e, () => this.log(e, `t=${v.currentTime.toFixed(2)}${v.error ? ` ${v.error.message}` : ''}`));
      this.on(v, 'error', () => void this.recover());
      this.on(v, 'timeupdate', () => {
        if (!this.recovering && v.readyState >= 2) this.resumeFrom = v.currentTime;
      });
      await this.attach();
      this.state = 'ready';
      this.start(at);
    } catch (e) {
      this.fail(e);
    }
  }

  private async attach() {
    this.ms = new MediaSource();
    this.sb = undefined;
    this.url = URL.createObjectURL(this.ms);
    this.video.src = this.url;
    const ms = this.ms;
    await new Promise<void>((res, rej) => {
      ms.addEventListener('sourceopen', () => res(), { once: true });
      setTimeout(() => rej(new Error('MediaSource did not open')), 5000);
    });
    ms.duration = this.probe!.duration;
  }

  /**
   * Chrome's VideoToolbox path (and possibly others) treats a damaged frame as a fatal media error.
   * Rebuild the MediaSource and continue from the next keyframe after the failure.
   */
  private async recover() {
    if (this.recovering || this.state !== 'ready') return;
    const v = this.video;
    const t = Math.max(v.currentTime, this.resumeFrom);
    const wasPlaying = !v.paused;
    if (++this.recoveries > 80) return this.fail(new Error('Too many decode errors; this clip is too damaged to play.'));
    this.recovering = true;
    this.level = Math.min(2, this.level + 1) as RepairLevel;
    try {
      this.gen++;
      this.wakeFn?.();
      await this.pumpDone;
      if (this.url) URL.revokeObjectURL(this.url);
      await this.attach();
      this.log('recover', `after ${t.toFixed(2)}`);
      this.start(t, true);
      if (wasPlaying) void v.play().catch(() => undefined);
    } catch (e) {
      this.fail(e);
    } finally {
      this.recovering = false;
    }
  }

  private fail(e: unknown) {
    this.state = 'error';
    this.error = e instanceof Error ? e.message : String(e);
    this.log('fatal', this.error);
  }

  setAhead(seconds: number) {
    this.ahead = seconds;
    this.wakeFn?.();
  }

  get loadedFraction(): number {
    const d = this.duration;
    return this.state === 'ready' && d > 0 ? Math.min(1, (this.video.currentTime + this.bufferedAhead) / d) : 0;
  }

  get bufferedAhead(): number {
    const t = this.video.currentTime;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) - 0.25 <= t && t <= b.end(i)) return b.end(i) - t;
    return 0;
  }

  /** True when the player has the data it needs at the current position. */
  get ready(): boolean {
    return this.state === 'ready' && this.video.readyState >= 3 && (this.bufferedAhead >= 1 || this.eof);
  }

  private start(at: number, skipPast = false) {
    const gen = ++this.gen;
    this.eof = false;
    this.pumpDone = this.pump(gen, at, skipPast).catch((e) => {
      if (gen !== this.gen) return;
      void this.recover(); // append failed (decoder died or bad init data): rebuild from the next keyframe
      this.log('pump-error', e instanceof Error ? e.message : String(e));
    });
  }

  /** Seek within this clip; restarts the pump from the nearest keyframe when outside the buffer. */
  async seek(t: number): Promise<void> {
    if (this.state !== 'ready') return;
    this.resumeFrom = t;
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= t + 0.05 && t < b.end(i) - 0.1) {
        this.video.currentTime = t;
        this.wakeFn?.();
        return;
      }
    }
    this.gen++; // cancels the running pump
    this.wakeFn?.();
    await this.pumpDone;
    if (this.state !== 'ready') return;
    this.log('restart', `at ${t.toFixed(2)}`);
    this.start(t);
    this.video.currentTime = t;
  }

  private wait(ms: number) {
    return new Promise<void>((res) => {
      const id = setTimeout(res, ms);
      this.wakeFn = () => {
        clearTimeout(id);
        res();
      };
    });
  }

  private updateEnd(sb: SourceBuffer) {
    return new Promise<void>((res, rej) => {
      const ok = () => {
        sb.removeEventListener('error', bad);
        res();
      };
      const bad = () => {
        sb.removeEventListener('updateend', ok);
        rej(new Error('SourceBuffer error'));
      };
      sb.addEventListener('updateend', ok, { once: true });
      sb.addEventListener('error', bad, { once: true });
    });
  }

  private async append(data: Uint8Array) {
    const sb = this.sb!;
    for (let attempt = 0; ; attempt++) {
      try {
        sb.appendBuffer(data as BufferSource);
        break;
      } catch (e) {
        if ((e as DOMException).name !== 'QuotaExceededError' || attempt > 1) throw e;
        await this.trim(true);
      }
    }
    await this.updateEnd(sb);
  }

  private async trim(force = false) {
    const sb = this.sb;
    if (!sb || sb.updating || !sb.buffered.length) return;
    const keepFrom = this.video.currentTime - (force ? 2 : KEEP_BEHIND_S);
    if (sb.buffered.start(0) < keepFrom - 2) {
      sb.remove(0, keepFrom);
      await this.updateEnd(sb);
    }
  }

  private async pump(gen: number, startAt: number, skipPast: boolean) {
    const probe = this.probe!;
    const live = () => gen === this.gen && this.state === 'ready';

    let offset = 0;
    let baseTime = 0;
    if (startAt > 0.5 || skipPast) {
      this.keyframes ??= await scanKeyframes(this.blob, probe);
      if (!live()) return;
      const kf = skipPast
        ? this.keyframes.find((k) => k.time > startAt + 0.05)
        : ([...this.keyframes].reverse().find((k) => k.time <= startAt) ?? this.keyframes[0]);
      if (!kf) {
        // damage ran to the end of the clip
        this.eof = true;
        this.video.currentTime = Math.max(0, probe.duration - 0.05);
        return;
      }
      offset = kf.offset;
      baseTime = kf.time;
      if (skipPast) this.video.currentTime = this.resumeFrom = kf.time;
    }

    // fresh parser state for the new run (also required after abort())
    if (this.sb) {
      if (this.sb.updating) await this.updateEnd(this.sb).catch(() => undefined);
      try {
        this.sb.abort();
      } catch {
        /* ms may be ended */
      }
      if (this.sb.buffered.length) {
        this.sb.remove(0, Infinity);
        await this.updateEnd(this.sb).catch(() => undefined);
      }
    }
    this.needInit = true;

    const tm = new mux.mp4.Transmuxer({ remux: true });
    tm.setBaseMediaDecodeTime(Math.round(baseTime * 90000));
    const out: TransmuxSegment[] = [];
    tm.on('data', (s) => out.push(s));
    tm.push(probe.psi.packets); // creates mux.js's TS pipeline, which we then patch
    const h264 = (tm as unknown as { transmuxPipeline_: { h264Stream: { push(p: { dts: number; pts: number }): void } } }).transmuxPipeline_.h264Stream;
    const fixer = new DtsFixer();
    const pushPes = h264.push.bind(h264);
    h264.push = (pes) => {
      if (pes && typeof pes.pts === 'number') pes.dts = fixer.fix(pes.pts);
      pushPes(pes);
    };

    const reader = new TsPacketReader();
    const splitter = new TsBlockSplitter(probe.psi.videoPid, probe.psi.audioPid, BLOCK_TARGET, this.level);
    // One fragment is held back so its final sample can be given the real duration (see fmp4.ts).
    let held: { segs: TransmuxSegment[]; lastDts: number } | undefined;
    const appendSegs = async (segs: TransmuxSegment[]) => {
      for (const seg of segs) {
        if (!this.sb) this.createBuffer(seg);
        const body = this.needInit ? concat(seg.initSegment, seg.data) : seg.data;
        this.needInit = false;
        await this.append(body);
        await this.trim();
      }
    };
    const feed = async (blocks: Uint8Array[]) => {
      for (const blk of blocks) {
        if (!live()) return;
        fixer.mark();
        tm.push(blk);
        tm.flush();
        if (held && !Number.isNaN(fixer.first)) for (const sg of held.segs) patchLastDuration(sg.data, probe.psi.videoPid, fixer.first - held.lastDts);
        if (held) await appendSegs(held.segs);
        held = { segs: out.splice(0), lastDts: fixer.last };
      }
    };

    let pos = offset;
    while (live() && pos < this.blob.size) {
      while (live() && this.bufferedAhead >= this.ahead) await this.wait(250);
      if (!live()) return;
      const chunk = await readBytes(this.blob, pos, pos + READ_CHUNK);
      const final = pos + chunk.length >= this.blob.size;
      reader.push(chunk, pos, final, (b, p, _o, junk) => splitter.add(b, p, junk));
      pos += chunk.length;
      if (final) splitter.finish();
      this.droppedFrames = splitter.droppedFrames;
      this.totalFrames = splitter.totalFrames;
      await feed(splitter.take());
    }
    if (!live()) return;
    tm.flush();
    if (held) await appendSegs(held.segs);
    await appendSegs(out.splice(0));
    this.eof = true;
    if (this.ms!.readyState === 'open') {
      while (this.sb?.updating) await this.updateEnd(this.sb);
      this.ms!.endOfStream();
    }
    this.log('eof', `skipped ${reader.skipped} junk bytes`);
  }

  private createBuffer(seg: TransmuxSegment) {
    const i = seg.info;
    const avc = `avc1.${hex(i.profileIdc ?? 77)}${hex(i.profileCompatibility ?? 0)}${hex(i.levelIdc ?? 40)}`;
    // keep the first codec string: SPS constraint flags vary mid-stream and Chrome rejects the variants
    const mime = (this.mime ??= `video/mp4; codecs="${seg.type === 'video' ? avc : `${avc},mp4a.40.2`}"`);
    if (!MediaSource.isTypeSupported(mime)) throw new Error(`Browser cannot play ${mime}`);
    this.sb = this.ms!.addSourceBuffer(mime);
    // DTS runs DTS_DELAY ahead-of-PTS reversed (see dtsFixer); shift so the first frame presents at its own time
    this.sb.timestampOffset = -DTS_DELAY_TICKS / 90000;
    this.log('sourcebuffer', mime);
  }

  /** Release the element, MediaSource, object URL and listeners. */
  dispose() {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.gen++;
    this.wakeFn?.();
    this.listeners.forEach((f) => f());
    this.listeners = [];
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.ms = this.sb = this.url = undefined;
  }
}

function concat(a: Uint8Array, b: Uint8Array) {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
}
