import { locate, type Segment, type Trip } from '../recordings/TripBuilder';
import type { Clip } from './Clip';
import { ACTIVE_AHEAD_S, MseClip, STANDBY_AHEAD_S } from './MseClip';
import { NativeClip } from './NativeClip';

export type Cam = 'front' | 'rear';
export const CAMS: Cam[] = ['front', 'rear'];
export type AudioSource = Cam | 'off';
export type Phase = 'idle' | 'loading' | 'paused' | 'playing' | 'seeking' | 'buffering' | 'ended' | 'error';
export type CamStatus = 'missing' | 'loading' | 'ok' | 'error';

/** Two slots, each holding a front+rear clip pair; one is active, the other is the preloaded standby. */
interface Slot {
  seg?: Segment;
  /** The part of the clip this slot holds, seconds into the clip (a raw .TS is played as short windows; anything else as a whole). */
  win: { start: number; end: number };
  /** Seconds of the previous window held in front of `win.start` (element time 0 = win.start - lead). */
  lead: number;
  clips: Partial<Record<Cam, Clip>>;
  videos: Record<Cam, HTMLVideoElement>;
}

export interface Transition {
  toSegment: number;
  /** ms spent waiting for the standby pair after the previous one ran out (0 = it was ready). */
  waitedMs: number;
  /** ms between the last frame presented by the old clip and the first by the new one (rVFC), if measurable. */
  frameGapMs?: number;
  standbyReadyBeforeEnd: boolean;
  /** How the switch was made. */
  mode?: 'overlap' | 'plain' | 'fallback';
  /** How far the new picture was from the old one at the switch, ms (positive = new ahead); ~0 when they were lined up. */
  alignMs?: number;
}

/** Where the data is, in trip seconds: what is ready to play, and the next part being prepared. */
export interface BufferInfo {
  ready: { from: number; to: number };
  next?: { from: number; to: number; fraction: number; ready: boolean };
}

export interface Snapshot {
  phase: Phase;
  message?: string;
  /** Global trip time, seconds. */
  t: number;
  total: number;
  segIndex: number;
  segLocal: number;
  segCount: number;
  wantPlay: boolean;
  rate: number;
  audio: AudioSource;
  volume: number;
  cams: Record<Cam, CamStatus>;
  /** Per camera: progress while preparing, or the reason it cannot play. */
  notes: Partial<Record<Cam, string>>;
  /** Per camera, 0..1: how far the clip being prepared has got. */
  progress: Partial<Record<Cam, number>>;
  /** front minus rear media time after offset, seconds. */
  drift: number | null;
  buffer: BufferInfo | null;
}

type Listener = (s: Snapshot) => void;

const READY_TIMEOUT_MS = 12000;
const DRIFT_LIMIT_S = 0.2;
const DRIFT_COOLDOWN_MS = 1500;
const END_EPSILON_S = 0.05;
/** Raw .TS recordings are converted and played in windows this long, so memory stays bounded however long the recording is. */
const WINDOW_S = 15;
/** A last window shorter than this is merged into the one before it. */
const MIN_TAIL_S = 5;
/** Every window after the first also holds this much of the one before it, so the next window can already be playing, lined up on the same frame, before the picture is switched. */
const WINDOW_LEAD_S = 2.5;
/** The hand-over starts this many seconds of picture before a window ends (more at higher speeds). Above 2× the overlap is skipped. */
const HANDOVER_LEAD_S = 1.0;
const MAX_OVERLAP_RATE = 2;
const MAX_GAP_JUMP_S = 2.5;
const STALL_SWITCH_MS = 1500;

export class PlaybackController {
  private slots: [Slot, Slot];
  private active = 0;
  private trip?: Trip;
  private t = 0;
  private wantPlay = false;
  private rate = 1;
  private audio: AudioSource = 'front';
  private volume = 1;
  private camOffset = 0; // rear time = front time + camOffset
  private phase: Phase = 'idle';
  private message?: string;
  private drift: number | null = null;
  private pendingSeek: number | null = null;
  private seeking = false;
  private advancing = false;
  private advanceStartedAt = 0;
  /** Seamless overlap between windows. Off = simple switch (also turned off by itself after two failed overlaps). */
  overlap = true;
  private overlapFailures = 0;
  /** How long (picture seconds) this browser takes from play() to showing the new frame; learned at each hand-over and used to aim the next. */
  private startLatency = 0.08;
  private stuckSince = 0;
  private lastDriftFix = 0;
  private timer?: ReturnType<typeof setInterval>;
  private listeners = new Set<Listener>();
  private lastEmit = 0;
  private lastFrameAt = 0;
  private frameWatch = new WeakSet<HTMLVideoElement>();
  /** Called whenever a segment's clips are opened (active or standby): the hook for per-segment GPS. */
  onPrepare?: (seg: Segment, clip: Clip) => void;
  private complete = true;
  /** Per camera: last position and when it last moved (stall watchdog). */
  private moved: Record<Cam, { t: number; at: number }> = { front: { t: -1, at: 0 }, rear: { t: -1, at: 0 } };
  private masterOverride: Cam | null = null;
  readonly transitions: Transition[] = [];
  readonly counters = { stalls: 0, waiting: 0, driftCorrections: 0, seeks: 0, playRejections: 0, gapJumps: 0, masterSwitches: 0, fallbacks: 0, heals: 0, overlapFallbacks: 0 };

  constructor() {
    const mk = (): Slot => ({ clips: {}, win: { start: 0, end: 0 }, lead: 0, videos: { front: this.video('front'), rear: this.video('rear') } });
    this.slots = [mk(), mk()];
    this.showActive();
    this.timer = setInterval(() => this.tick(), 50);
  }

  private get cur() {
    return this.slots[this.active]!;
  }
  private get other() {
    return this.slots[1 - this.active]!;
  }

  private video(cam: Cam) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.dataset.cam = cam;
    v.addEventListener('waiting', () => this.counters.waiting++);
    v.addEventListener('stalled', () => this.counters.stalls++);
    return v;
  }

  /** Adds both slot elements for a camera to a React-owned container (elements stay stable). */
  mount(cam: Cam, container: HTMLElement) {
    for (const s of this.slots) container.appendChild(s.videos[cam]);
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => void this.listeners.delete(fn);
  }

  private emit(force = false) {
    const now = performance.now();
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    const s = this.snapshot();
    this.listeners.forEach((f) => f(s));
  }

  private set(phase: Phase, message?: string) {
    this.phase = phase;
    this.message = message;
    this.emit(true);
  }

  private bufferInfo(slot: Slot): BufferInfo | null {
    const seg = slot.seg;
    if (!seg || this.medialess) return null;
    const m = this.master(slot);
    const base = seg.globalStart + slot.win.start - slot.lead;
    let to = 0;
    if (m)
      for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= m.currentTime + 0.5 && m.currentTime <= m.buffered.end(i) + 0.5) to = Math.max(to, m.buffered.end(i));
    const info: BufferInfo = { ready: { from: base, to: base + Math.min(Math.max(to, m?.currentTime ?? 0), slot.win.end - slot.win.start + slot.lead) } };
    const sb = this.other;
    if (sb.seg && (sb.clips.front || sb.clips.rear)) {
      const fr = CAMS.map((c) => sb.clips[c]?.loadedFraction).filter((x): x is number => x !== undefined);
      info.next = { from: sb.seg.globalStart + sb.win.start - sb.lead, to: sb.seg.globalStart + sb.win.end, fraction: fr.length ? Math.min(...fr) : 0, ready: this.slotReady(sb) };
    }
    return info;
  }

  snapshot(): Snapshot {
    const slot = this.cur;
    const seg = slot.seg;
    const prep = slot.clips.front || slot.clips.rear ? slot : this.other;
    const status = (cam: Cam): CamStatus => {
      if (!seg) return this.trip?.segments.length ? 'loading' : 'missing'; // clips are being opened: not "no footage"
      const src = cam === 'front' ? seg.entry.front : seg.entry.rear;
      if (!src) return 'missing';
      const c = slot.clips[cam];
      if (!c || c.state === 'idle' || c.state === 'opening') return 'loading';
      return c.state === 'error' ? 'error' : 'ok';
    };
    return {
      phase: this.phase,
      message: this.message,
      t: this.t,
      total: this.trip?.totalDuration ?? 0,
      segIndex: seg?.index ?? 0,
      segLocal: seg ? this.t - seg.globalStart : 0,
      segCount: this.trip?.segments.length ?? 0,
      wantPlay: this.wantPlay,
      rate: this.rate,
      audio: this.audio,
      volume: this.volume,
      cams: { front: status('front'), rear: status('rear') },
      // the first clip is prepared in the standby slot and swapped in when ready: report on whichever one is being opened
      notes: { front: prep.clips.front?.note, rear: prep.clips.rear?.note },
      progress: { front: prep.clips.front?.progress, rear: prep.clips.rear?.progress },
      drift: this.drift,
      buffer: this.bufferInfo(slot),
    };
  }

  diagnostics() {
    const dump = (name: string, slot: Slot) => ({
      slot: name,
      segment: slot.seg?.key ?? null,
      window: slot.seg ? ([+slot.win.start.toFixed(1), +slot.win.end.toFixed(1)] as [number, number]) : null,
      cams: CAMS.map((cam) => {
        const c = slot.clips[cam];
        const v = slot.videos[cam];
        const q = v.getVideoPlaybackQuality?.();
        return {
          cam,
          file: c?.name ?? null,
          state: c?.state ?? 'none',
          error: c?.error,
          readyState: v.readyState,
          currentTime: +v.currentTime.toFixed(3),
          duration: c?.duration ?? null,
          bufferedAhead: c ? +c.bufferedAhead.toFixed(2) : null,
          recoveries: c?.recoveries ?? 0,
          droppedByRepair: c ? `${c.droppedFrames}/${c.totalFrames}` : null,
          repairLevel: c?.level ?? 0,
          size: v.videoWidth ? `${v.videoWidth}x${v.videoHeight}` : null,
          dropped: q?.droppedVideoFrames ?? null,
          totalFrames: q?.totalVideoFrames ?? null,
          lastEvents: c?.events.slice(-6) ?? [],
        };
      }),
    });
    return {
      phase: this.phase,
      slots: [dump(this.active === 0 ? 'active' : 'standby', this.slots[0]!), dump(this.active === 1 ? 'active' : 'standby', this.slots[1]!)],
      transitions: this.transitions.slice(-8),
      counters: { ...this.counters },
      standbyReady: this.slotReady(this.other),
      engine: MseClip.stream ? 'streaming (MediaSource)' : `converted windows of ${WINDOW_S} s`,
    };
  }

  // ---- loading -------------------------------------------------------------------------

  /**
   * Map-only mode: no clip is opened, so no audio or video is read or decoded. The trip clock runs on its own
   * (GPS and the timeline still work); leaving the mode re-opens the clips at the current position.
   */
  medialess = false;
  private lastTick = 0;

  async setMedialess(on: boolean) {
    if (this.medialess === on) return;
    this.medialess = on;
    if (!this.trip?.segments.length) return;
    if (!on) return this.reload();
    this.pauseSlot(this.cur);
    this.release(this.slots[0]!);
    this.release(this.slots[1]!);
    this.advancing = false;
    this.cur.seg = locate(this.trip, this.t)?.segment;
    this.set(this.wantPlay ? 'playing' : 'paused');
  }

  async load(trip: Trip, complete = true) {
    this.release(this.slots[0]!);
    this.release(this.slots[1]!);
    this.trip = trip;
    this.complete = complete;
    this.t = 0;
    this.active = 0;
    this.wantPlay = false;
    this.transitions.length = 0;
    this.showActive();
    if (!trip.segments.length) return this.set('idle');
    this.set('loading');
    await this.goTo(0);
  }

  /**
   * The trip grows while the remaining files are still being probed. Earlier segments never change,
   * so the playing pair is simply re-pointed at the new segment objects.
   */
  updateTrip(trip: Trip, complete: boolean) {
    this.trip = trip;
    this.complete = complete;
    for (const slot of this.slots) if (slot.seg) slot.seg = trip.segments[slot.seg.index] ?? slot.seg;
    if (this.cur.seg) this.ensureStandby();
    this.emit(true);
  }

  /** Re-open the current position with a new repair level (existing clips keep theirs until re-opened). */
  async setStream(on: boolean) {
    MseClip.stream = on;
    await this.reload();
  }

  private async reload() {
    if (!this.trip?.segments.length) return;
    const t = this.t;
    this.pauseSlot(this.cur);
    this.release(this.slots[0]!);
    this.release(this.slots[1]!);
    this.active = 0;
    this.showActive();
    await this.goTo(t);
    if (this.wantPlay) await this.resume();
  }

  private release(slot: Slot) {
    for (const cam of CAMS) slot.clips[cam]?.dispose();
    slot.clips = {};
    slot.seg = undefined;
    slot.win = { start: 0, end: 0 };
    slot.lead = 0;
  }

  private windowed(seg: Segment): boolean {
    const srcs = [seg.entry.front, seg.entry.rear].filter(Boolean);
    return !MseClip.stream && srcs.length > 0 && srcs.every((f) => /\.ts$/i.test(f!.name));
  }

  /** The window of `seg` that contains `local`: fixed 20 s steps, the last one absorbing a short tail. */
  private windowAt(seg: Segment, local: number): { start: number; end: number } {
    if (!this.windowed(seg)) return { start: 0, end: seg.duration };
    const starts: number[] = [];
    for (let s = 0; ; s += WINDOW_S) {
      starts.push(s);
      if (seg.duration - s <= WINDOW_S + MIN_TAIL_S) break;
    }
    let i = starts.length - 1;
    while (i > 0 && starts[i]! > local) i--;
    return { start: starts[i]!, end: starts[i + 1] ?? seg.duration };
  }

  private prepare(slot: Slot, seg: Segment, local: number, ahead: number) {
    this.release(slot);
    slot.seg = seg;
    const win = this.windowAt(seg, local);
    slot.win = win;
    const windowed = this.windowed(seg);
    const lead = windowed && win.start > 0 ? Math.min(WINDOW_LEAD_S, win.start) : 0;
    slot.lead = lead;
    for (const cam of CAMS) {
      const src = cam === 'front' ? seg.entry.front : seg.entry.rear;
      if (!src) continue;
      const at = Math.max(0, local - win.start + lead + (cam === 'rear' ? this.camOffset : 0));
      const clip: Clip = /\.mp4$/i.test(src.name) || (!MseClip.stream && /\.ts$/i.test(src.name)) ? new NativeClip(src.blob, src.name, slot.videos[cam], windowed ? { start: win.start - lead, end: win.end } : undefined) : new MseClip(src.blob, src.name, slot.videos[cam]);
      slot.clips[cam] = clip;
      void clip.open(at, ahead).then(() => clip.state === 'ready' && this.onPrepare?.(seg, clip));
    }
    this.applyAudio(slot);
    this.applyRate(slot);
  }

  private ensureStandby() {
    if (this.medialess) return;
    const seg = this.cur.seg;
    if (!seg) return;
    // the next window of this clip, or the first window of the next clip
    const more = this.cur.win.end < seg.duration - 0.05;
    const target = more ? seg : this.trip?.segments[seg.index + 1];
    if (!target) return;
    const local = more ? this.cur.win.end : 0;
    const sb = this.other;
    if (sb.seg?.index !== target.index || sb.win.start !== this.windowAt(target, local).start) this.prepare(sb, target, local, STANDBY_AHEAD_S);
  }

  private slotReady(slot: Slot): boolean {
    const clips = Object.values(slot.clips);
    if (!clips.length) return false;
    const live = clips.filter((c) => c.state !== 'error');
    // one camera failing must not block the other
    return live.length > 0 && live.every((c) => c.ready);
  }

  private async waitReady(slot: Slot, ms = READY_TIMEOUT_MS): Promise<boolean> {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      if (this.slotReady(slot)) return true;
      if (Object.values(slot.clips).length && Object.values(slot.clips).every((c) => c.state === 'error')) return false;
      await new Promise((r) => setTimeout(r, 40));
    }
    // Slow to buffer is not broken: go on with whatever opened and let the normal buffering state cover the rest.
    return Object.values(slot.clips).some((c) => c.state === 'ready');
  }

  // ---- transport ------------------------------------------------------------------------

  async play() {
    if (!this.trip?.segments.length) return;
    this.wantPlay = true;
    if (this.t >= this.trip.totalDuration - 0.1) await this.goTo(0);
    await this.resume();
  }

  pause() {
    this.wantPlay = false;
    this.pauseSlot(this.cur);
    if (this.phase === 'playing' || this.phase === 'buffering') this.set('paused');
    else this.emit(true);
  }

  private pauseSlot(slot: Slot) {
    for (const cam of CAMS) slot.videos[cam].pause();
  }

  private async resume() {
    const slot = this.cur;
    for (const clip of Object.values(slot.clips)) clip.setAhead(ACTIVE_AHEAD_S);
    const plays = CAMS.filter((c) => slot.clips[c]?.state !== 'error' && slot.clips[c]).map((c) => slot.videos[c].play());
    const res = await Promise.allSettled(plays);
    const rej = res.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (rej && (rej.reason as DOMException).name === 'NotAllowedError') {
      this.counters.playRejections++;
      this.wantPlay = false;
      this.set('paused', 'The browser blocked playback. Press Play again.');
    } else if (this.wantPlay) this.set('playing');
  }

  seek(t: number) {
    const total = this.trip?.totalDuration ?? 0;
    this.pendingSeek = Math.min(Math.max(t, 0), Math.max(total - 0.001, 0));
    this.t = this.pendingSeek;
    this.emit(true);
    if (!this.seeking) void this.runSeeks();
  }

  seekBy(d: number) {
    this.seek(this.t + d);
  }

  jumpSegment(delta: number) {
    const seg = this.cur.seg;
    if (!seg || !this.trip) return;
    const i = Math.min(Math.max(seg.index + delta, 0), this.trip.segments.length - 1);
    this.seek(this.trip.segments[i]!.globalStart);
  }

  /** Coalesces rapid seeks: only the last requested position is executed after the one in flight. */
  private async runSeeks() {
    this.seeking = true;
    try {
      while (this.pendingSeek !== null) {
        const t = this.pendingSeek;
        this.pendingSeek = null;
        this.counters.seeks++;
        await this.goTo(t);
      }
    } finally {
      this.seeking = false;
    }
    if (this.wantPlay) await this.resume();
    else this.set('paused');
  }

  /** One goTo at a time: a seek made while the first clip is still loading must wait for it, not race it for the slots. */
  private goToChain: Promise<void> = Promise.resolve();
  private goTo(t: number): Promise<void> {
    const run = this.goToChain.then(() => this.goToNow(t));
    this.goToChain = run.catch(() => undefined);
    return run;
  }

  private async goToNow(t: number) {
    const loc = this.trip && locate(this.trip, t);
    if (!loc || !this.trip) return;
    const { segment, local } = loc;
    if (this.medialess) {
      this.cur.seg = segment;
      this.t = segment.globalStart + local;
      return this.set(this.wantPlay ? 'playing' : 'paused');
    }
    this.set('seeking');
    this.advancing = false;
    this.masterOverride = null;
    this.pauseSlot(this.cur);
    let slot = this.cur;
    const want = this.windowAt(segment, local);
    const holds = (s: Slot) => s.seg?.index === segment.index && s.win.start === want.start;
    if (!holds(slot)) {
      const other = this.other;
      if (!holds(other)) this.prepare(other, segment, local, ACTIVE_AHEAD_S);
      slot = other;
      await this.seekSlot(slot, local);
      await this.waitReady(slot);
      if (this.pendingSeek !== null) return; // superseded; the loop will run the newer seek
      this.swapTo(1 - this.active);
    } else {
      await this.seekSlot(slot, local);
      await this.waitReady(slot);
    }
    if (this.pendingSeek !== null) return;
    this.t = segment.globalStart + local;
    this.ensureStandby();
    const bad = CAMS.filter((c) => slot.clips[c]?.state === 'error');
    this.set(this.wantPlay ? 'playing' : 'paused', bad.length ? `${bad.join(' & ')} clip could not be played: ${slot.clips[bad[0]!]?.error}` : undefined);
  }

  private async seekSlot(slot: Slot, local: number) {
    await Promise.all(
      CAMS.map(async (cam) => {
        const clip = slot.clips[cam];
        if (!clip) return;
        while (clip.state === 'idle' || clip.state === 'opening') await new Promise((r) => setTimeout(r, 30));
        clip.setAhead(ACTIVE_AHEAD_S);
        await clip.seek(Math.max(0, local - slot.win.start + slot.lead + (cam === 'rear' ? this.camOffset : 0)));
      }),
    );
  }

  private swapTo(idx: number) {
    this.masterOverride = null;
    const old = this.cur;
    this.pauseSlot(old);
    this.active = idx;
    this.showActive();
    const nw = this.slots[idx]!;
    this.applyAudio(nw);
    this.applyRate(nw);
    for (const clip of Object.values(nw.clips)) clip.setAhead(ACTIVE_AHEAD_S);
    this.watchFrames(this.master(nw));
    // the retired pair becomes free for the next standby
    this.release(old);
  }

  private showActive() {
    // Both pictures stay "visible" to the browser and only one is shown (opacity, stacking): a hidden element may not be painted, and
    // switching to it would then flash a blank frame before the first paint.
    this.slots.forEach((s, i) =>
      CAMS.forEach((c) => {
        const st = s.videos[c].style;
        st.visibility = 'visible';
        st.opacity = '1'; // the waiting picture stays fully opaque, just underneath: a transparent video may stop being painted (or played) by a browser
        st.zIndex = i === this.active ? '2' : '1';
        st.pointerEvents = i === this.active ? 'auto' : 'none';
      }),
    );
  }

  // ---- continuous playback ---------------------------------------------------------------

  private master(slot: Slot): HTMLVideoElement | undefined {
    const seg = slot.seg;
    if (!seg) return undefined;
    const f = slot.clips.front?.state !== 'error' && slot.clips.front;
    const r = slot.clips.rear?.state !== 'error' && slot.clips.rear;
    if (f && r && this.masterOverride) return slot.videos[this.masterOverride];
    if (f && r) return (seg.frontDuration ?? 0) >= (seg.rearDuration ?? 0) ? slot.videos.front : slot.videos.rear;
    return f ? slot.videos.front : r ? slot.videos.rear : undefined;
  }

  private watchFrames(v?: HTMLVideoElement) {
    if (!v || this.frameWatch.has(v) || !('requestVideoFrameCallback' in v)) return;
    this.frameWatch.add(v);
    const loop = (now: number) => {
      this.lastFrameAt = now;
      v.requestVideoFrameCallback(loop);
    };
    v.requestVideoFrameCallback(loop);
  }

  private tick() {
    const trip = this.trip;
    const slot = this.cur;
    const seg = slot.seg;
    if (this.medialess && trip) {
      const now = performance.now();
      const dt = Math.min((now - this.lastTick) / 1000, 0.5);
      this.lastTick = now;
      if (this.wantPlay) {
        this.t = Math.min(this.t + dt * this.rate, trip.totalDuration);
        const loc = locate(trip, this.t);
        if (loc && loc.segment.index !== slot.seg?.index) slot.seg = loc.segment;
        if (this.t >= trip.totalDuration - 0.05) {
          this.wantPlay = false;
          this.set('ended');
        }
      }
      return this.emit();
    }
    if (trip && seg && this.advancing && !this.seeking && performance.now() - this.advanceStartedAt > 4000) {
      // a hand-over that has not finished in 4 s is stuck: drop it and start again from where we are
      this.advancing = false;
      this.heal('hand-over did not finish');
    }
    if (trip && seg && this.advancing && !this.seeking) {
      const m = this.master(slot);
      if (m) this.t = seg.globalStart + Math.min(Math.max(this.clipTime(slot, m), 0), seg.duration); // the old picture is still playing
      return this.emit();
    }
    if (!trip || !seg || this.seeking || this.advancing) return this.emit();
    let master = this.master(slot);
    if (!master) return this.emit();

    this.watchFrames(master);
    const now = performance.now();
    for (const cam of CAMS) {
      const v = slot.videos[cam];
      if (v.paused || Math.abs(v.currentTime - this.moved[cam].t) > 0.01) this.moved[cam] = { t: v.currentTime, at: now };
      // a rebuilt MediaSource (decode-error recovery) resets `paused`; keep the user's intent for the master
      if (v === master && this.wantPlay && v.paused && v.readyState >= 2 && !v.ended && slot.clips[cam]?.state === 'ready') void v.play().catch(() => undefined);
      this.jumpGap(v);
    }
    this.checkNoPicture(master, now);
    // self-heal: it should be playing but the picture has been stopped for over a second, and no hand-over or seek explains it
    if (this.wantPlay && (master.paused || master.ended) && !master.seeking && this.phase !== 'error') {
      this.stuckSince ||= now;
      if (now - this.stuckSince > 1200) {
        this.stuckSince = 0;
        this.heal('playback stopped by itself');
      }
    } else this.stuckSince = 0;
    this.checkMasterStall(slot, master, now);
    master = this.master(slot) ?? master;
    const local = this.clipTime(slot, master);
    this.t = seg.globalStart + Math.min(Math.max(local, 0), seg.duration);

    if (this.wantPlay) {
      const end = Math.min(slot.win.end, Number.isFinite(master.duration) ? master.duration - slot.lead + slot.win.start : slot.win.end);
      // inside a clip, with the next window ready and holding the lead-in, the hand-over starts early and overlaps
      const nxt = this.other;
      const overlap = this.overlap && this.rate <= MAX_OVERLAP_RATE && slot.win.end < seg.duration - 0.05 && nxt.seg?.index === seg.index && nxt.win.start === slot.win.end && nxt.lead > 0 && this.slotReady(nxt);
      if (master.ended || local >= end - (overlap ? Math.min(HANDOVER_LEAD_S * this.rate, WINDOW_LEAD_S - 0.5) : END_EPSILON_S)) void this.advance(seg);
      else {
        this.syncSlaves(slot, master);
        const stalled = master.readyState < 3 && !master.seeking;
        if (stalled && this.phase === 'playing') this.set('buffering');
        else if (!stalled && this.phase === 'buffering') this.set('playing');
      }
    }
    this.emit();
  }

  /**
   * Safety net: a browser that plays the clock and the sound of a converted MP4 but decodes no picture
   * (Safari did this with fragmented MP4) is switched, once, to MediaSource streaming, which it renders.
   */
  private noPictureSince = 0;
  private checkNoPicture(v: HTMLVideoElement, now: number) {
    const q = v.getVideoPlaybackQuality?.();
    const stuck = this.wantPlay && !v.paused && v.readyState >= 3 && v.currentTime > 1 && q && q.totalVideoFrames === 0 && !MseClip.stream;
    if (!stuck) return void (this.noPictureSince = 0);
    this.noPictureSince ||= now;
    if (now - this.noPictureSince < 2000) return;
    this.noPictureSince = 0;
    this.counters.fallbacks++;
    void this.setStream(true).then(() => this.set(this.wantPlay ? 'playing' : 'paused', 'This browser could not show the converted video, so streaming playback is used instead.'));
  }

  /**
   * Damaged GOPs are dropped (see TsBlockSplitter), which leaves holes in the buffer that browsers do
   * not skip on their own. Hop over a short hole to the next buffered data.
   */
  private jumpGap(v: HTMLVideoElement) {
    if (!this.wantPlay || v.seeking || v.paused || v.readyState >= 3) return;
    const t = v.currentTime;
    for (let i = 0; i < v.buffered.length; i++) {
      const start = v.buffered.start(i);
      if (start > t && start - t < MAX_GAP_JUMP_S) {
        v.currentTime = start + 0.02;
        this.counters.gapJumps++;
        return;
      }
    }
  }

  /**
   * If the master camera stops advancing (a bad frame can stall one decoder) while the other keeps going,
   * make the moving one the master. Otherwise the stuck camera would drag the clock, and the other camera,
   * with it.
   */
  private checkMasterStall(slot: Slot, master: HTMLVideoElement, now: number) {
    if (!this.wantPlay) return;
    const mc: Cam = master === slot.videos.front ? 'front' : 'rear';
    const oc: Cam = mc === 'front' ? 'rear' : 'front';
    const other = slot.videos[oc];
    if (slot.clips[oc]?.state !== 'ready' || other.paused || other.ended) return;
    if (now - this.moved[mc].at > STALL_SWITCH_MS && now - this.moved[oc].at < 400) {
      this.masterOverride = oc;
      this.counters.masterSwitches++;
    }
  }

  /**
   * The follower never goes backwards to chase the master (that replays the same seconds): if it is ahead
   * it waits, if it is behind it jumps forward to already-buffered data.
   */
  private syncSlaves(slot: Slot, master: HTMLVideoElement) {
    for (const cam of CAMS) {
      const v = slot.videos[cam];
      const clip = slot.clips[cam];
      if (v === master || !clip || clip.state !== 'ready') continue;
      const want = cam === 'rear' ? master.currentTime + this.camOffset : master.currentTime - this.camOffset;
      if (want >= clip.duration - 0.05) continue; // this camera's clip is shorter: hold its last frame
      const drift = (this.drift = v.currentTime - want);
      if (drift > DRIFT_LIMIT_S) {
        if (!v.paused) v.pause();
        continue;
      }
      if (v.paused && drift < 0.05 && v.readyState >= 2 && !v.ended) void v.play().catch(() => undefined);
      if (drift < -DRIFT_LIMIT_S && !v.seeking && performance.now() - this.lastDriftFix > DRIFT_COOLDOWN_MS) {
        const inBuffer = Array.from({ length: v.buffered.length }, (_, i) => i).some((i) => v.buffered.start(i) <= want && want < v.buffered.end(i) - 0.1);
        if (inBuffer) {
          this.lastDriftFix = performance.now();
          this.counters.driftCorrections++;
          v.currentTime = want;
        }
      }
    }
  }

  /** Position in the clip (seconds) shown by `v`, a video of `slot`. */
  private clipTime(slot: Slot, v: HTMLVideoElement): number {
    return (v === slot.videos.rear ? v.currentTime - this.camOffset : v.currentTime) - slot.lead + slot.win.start;
  }

  /**
   * Make-before-break: put the next window on the frame the current one WILL be showing a moment from now (one seek, paused, so the
   * frame is decoded and waiting), start it at exactly that instant, trim any small difference by running it slightly faster or
   * slower (never by seeking again), and only then switch the picture. Returns how far apart they were at the end (seconds).
   */
  private async alignStandby(sb: Slot, old: Slot): Promise<number | undefined> {
    try {
      const drift = await this.alignInner(sb, old);
      if (drift === undefined || Math.abs(drift) > 0.15 || sb.videos.front.paused) this.noteOverlapFailure();
      return drift;
    } catch {
      this.noteOverlapFailure();
      return undefined;
    }
  }

  /** Two failed overlaps (a browser that will not play the hidden picture, say): stop trying and use the plain switch. */
  private noteOverlapFailure() {
    this.counters.overlapFallbacks++;
    if (++this.overlapFailures >= 2) this.overlap = false;
  }

  private async alignInner(sb: Slot, old: Slot): Promise<number | undefined> {
    const om = this.master(old);
    const cams = CAMS.filter((c) => sb.clips[c]?.state === 'ready');
    if (!om || !cams.length) {
      await this.startStandby(sb);
      return undefined;
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const ref = sb.videos[cams.includes('front') ? 'front' : cams[0]!];
    const oldNow = () => this.clipTime(old, this.master(old) ?? om);
    const place = (clipTime: number) => cams.forEach((c) => (sb.videos[c].currentTime = Math.max(0, clipTime - sb.win.start + sb.lead + (c === 'rear' ? this.camOffset : 0))));
    cams.forEach((c) => (sb.videos[c].muted = true)); // un-muted by swapTo
    this.applyRate(sb);

    // 1. one seek to where the old picture will be in a moment, and wait until the frame is there
    const target = oldNow() + 0.4 * this.rate;
    const seeked = Promise.all(cams.map((c) => new Promise<void>((r) => sb.videos[c].addEventListener('seeked', () => r(), { once: true }))));
    place(target + this.startLatency);
    await Promise.race([seeked, sleep(600)]);

    // 2. start at that instant
    const t0 = performance.now();
    while (oldNow() < target - 0.012 && oldNow() < old.win.end + 0.6 && performance.now() - t0 < 1500) await sleep(6);
    await Promise.race([Promise.allSettled(cams.map((c) => sb.videos[c].play())), sleep(700)]);

    // 3. once it is presenting frames, correct the difference: a big one with one more (hidden) seek that allows for the start-up
    // time just seen, a small one by running slightly faster or slower. The old picture keeps playing meanwhile.
    const base = this.rate;
    const deadline = performance.now() + 1500;
    let good = 0;
    let reseeks = 0;
    let learned = false;
    while (performance.now() < deadline && oldNow() < old.win.end + 0.9) {
      await sleep(25);
      if (ref.paused || ref.seeking || ref.readyState < 3 || ref.currentTime === 0) {
        good = 0;
        continue;
      }
      const drift = this.clipTime(sb, ref) - oldNow(); // + = the new picture is ahead
      if (!learned) {
        learned = true;
        this.startLatency = Math.min(0.6, Math.max(0, this.startLatency - drift * 0.8));
      }
      if (Math.abs(drift) < 0.03) {
        if (++good >= 2) break;
        cams.forEach((c) => (sb.videos[c].playbackRate = base));
      } else if (Math.abs(drift) > 0.1 && reseeks < 3) {
        reseeks++;
        good = 0;
        place(oldNow() + 0.12 + this.startLatency);
      } else {
        good = 0;
        cams.forEach((c) => (sb.videos[c].playbackRate = base * (drift > 0 ? 0.8 : 1.25)));
      }
    }
    cams.forEach((c) => (sb.videos[c].playbackRate = base));
    return this.clipTime(sb, ref) - oldNow();
  }

  /** Playback stopped when it should not have: start again from the current position (a short blip, never a dead stop). */
  private heal(why: string) {
    this.counters.heals++;
    console.warn(`[dashcam] self-heal: ${why} at ${this.t.toFixed(1)} s`);
    const wasPlaying = this.wantPlay;
    void this.goTo(this.t).then(() => {
      if (wasPlaying && this.wantPlay) return this.resume();
    });
  }

  private async startStandby(sb: Slot) {
    const vids = CAMS.filter((c) => sb.clips[c]?.state === 'ready').map((c) => sb.videos[c]);
    if (!vids.length) return;
    vids.forEach((v) => (v.muted = true)); // un-muted by swapTo
    this.applyRate(sb);
    await Promise.race([Promise.allSettled(vids.map((v) => v.play())), new Promise((r) => setTimeout(r, 700))]);
    const lead = vids[0]!;
    const t0 = performance.now();
    while (lead.currentTime < 0.05 && !lead.paused && performance.now() - t0 < 350) await new Promise((r) => setTimeout(r, 6));
  }

  /** Promote the standby pair exactly once per boundary. */
  private async advance(from: Segment) {
    if (this.advancing || !this.trip) return;
    this.advancing = true;
    this.advanceStartedAt = performance.now();
    const t0 = performance.now();
    const slot = this.cur;
    const more = slot.win.end < from.duration - 0.05; // the same clip has another window
    const next = more ? from : this.trip.segments[from.index + 1];
    const nextLocal = more ? slot.win.end : 0;
    try {
      if (!next && !this.complete) return; // still probing later files: try again on the next tick
      if (!next) {
        this.pauseSlot(this.cur);
        this.wantPlay = false;
        this.t = this.trip.totalDuration;
        return this.set('ended');
      }
      const sb = this.other;
      if (sb.seg?.index !== next.index || sb.win.start !== this.windowAt(next, nextLocal).start) this.prepare(sb, next, nextLocal, ACTIVE_AHEAD_S);
      const readyBefore = this.slotReady(sb);
      if (!readyBefore) this.set('buffering', `Waiting for ${next.key}…`);
      if (!(await this.waitReady(sb))) {
        this.wantPlay = false;
        this.pauseSlot(this.cur);
        return this.set('error', `Could not prepare ${next.key}. Press Play to retry, or use Next segment to skip.`);
      }
      // Start the next part underneath the current one (muted, hidden) and switch the picture only once it has shown
      // a frame: the old picture keeps playing (a window runs a little past its end) so there is never a blank or frozen moment.
      const overlapped = this.overlap && more && sb.lead > 0 && this.rate <= MAX_OVERLAP_RATE;
      const align = overlapped ? await this.alignStandby(sb, slot) : (await this.startStandby(sb), undefined);
      const oldMaster = this.master(this.cur);
      const lastFrame = this.lastFrameAt;
      this.swapTo(1 - this.active);
      const nw = this.cur;
      const rec: Transition = { toSegment: next.index, waitedMs: readyBefore ? 0 : Math.round(performance.now() - t0), standbyReadyBeforeEnd: readyBefore, mode: overlapped ? (align !== undefined && Math.abs(align) <= 0.15 ? 'overlap' : 'fallback') : 'plain', alignMs: align === undefined ? undefined : Math.round(align * 1000) };
      const m = this.master(nw);
      if (m && 'requestVideoFrameCallback' in m && oldMaster) {
        m.requestVideoFrameCallback((now) => {
          rec.frameGapMs = Math.round(now - lastFrame);
        });
      }
      this.transitions.push(rec);
      if (!overlapped) this.t = next.globalStart + nextLocal; // an overlapped hand-over keeps the time the pictures were already at
      await this.resume();
      this.ensureStandby();
    } finally {
      this.advancing = false;
    }
  }

  // ---- settings --------------------------------------------------------------------------

  setRate(r: number) {
    this.rate = r;
    this.slots.forEach((s) => this.applyRate(s));
    this.emit(true);
  }
  private applyRate(s: Slot) {
    CAMS.forEach((c) => (s.videos[c].playbackRate = this.rate));
  }

  setAudio(a: AudioSource) {
    this.audio = a;
    this.slots.forEach((s) => this.applyAudio(s));
    this.emit(true);
  }
  setVolume(v: number) {
    this.volume = v;
    this.slots.forEach((s) => this.applyAudio(s));
    this.emit(true);
  }
  private applyAudio(s: Slot) {
    CAMS.forEach((c) => {
      s.videos[c].muted = this.audio !== c;
      s.videos[c].volume = this.volume;
    });
  }

  /** Rear media time = front media time + seconds. Applied by re-seeking the current position. */
  setCameraOffset(sec: number) {
    this.camOffset = sec;
    this.seek(this.t);
  }

  dispose() {
    clearInterval(this.timer);
    this.slots.forEach((s) => {
      this.release(s);
      CAMS.forEach((c) => s.videos[c].remove());
    });
    this.listeners.clear();
  }
}
