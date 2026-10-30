/**
 * MPEG-TS helpers for Wolfbox recordings.
 *
 * Finding (real files): the camera writes a few hundred non-TS junk bytes roughly every 64 KB, which
 * shifts 188-byte alignment, and ~2000 video packets per minute are missing (continuity counter
 * jumps). Reading is deterministic (stable checksums), so this is in the files as recorded.
 * We therefore (1) resynchronise on packet boundaries instead of assuming 188-byte alignment and
 * (2) feed only whole packets to the demuxer. We cannot restore the lost packets.
 */
export const PKT = 188;

/**
 * Read a byte range of a file. A read can fail briefly (a slow card, a volume that is busy), so it is tried again a few
 * times; if it still fails the error says what it means instead of the browser's wording.
 */
export async function readBytes(blob: Blob, start: number, end?: number): Promise<Uint8Array> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  throw new Error(`The recording could not be read from the disk (${last instanceof Error ? last.message : String(last)}). Is the SD card still connected, and has the file been moved?`);
}
/** Larger PTS steps between consecutive frames mean a corrupted header, not real time. */
const MAX_PTS_JUMP_S = 2;

/** `junk` = non-packet bytes skipped immediately before this packet. */
type PacketFn = (buf: Uint8Array, pos: number, fileOffset: number, junk: number) => void;

/** Finds valid packets: a sync byte that repeats at +188 and +376 (relaxed at end of input). */
export class TsPacketReader {
  private carry = new Uint8Array(0);
  private carryOffset = 0;
  /** Bytes skipped as non-packet data. */
  skipped = 0;
  private pendingJunk = 0;

  push(chunk: Uint8Array, chunkOffset: number, final: boolean, onPacket: PacketFn) {
    let buf = chunk;
    let base = chunkOffset;
    if (this.carry.length) {
      buf = new Uint8Array(this.carry.length + chunk.length);
      buf.set(this.carry);
      buf.set(chunk, this.carry.length);
      base = this.carryOffset;
    }
    const n = buf.length;
    let p = 0;
    const lim = final ? n - PKT : n - 2 * PKT;
    let junk = this.pendingJunk;
    while (p <= lim) {
      if (buf[p] === 0x47 && (p + PKT >= n || buf[p + PKT] === 0x47) && (p + 2 * PKT >= n || buf[p + 2 * PKT] === 0x47)) {
        onPacket(buf, p, base + p, junk);
        junk = 0;
        p += PKT;
      } else {
        p++;
        junk++;
        this.skipped++;
      }
    }
    this.pendingJunk = junk;
    if (final) {
      this.carry = new Uint8Array(0);
    } else {
      this.carry = buf.slice(p);
      this.carryOffset = base + p;
    }
  }
}

export const pidOf = (b: Uint8Array, p: number) => ((b[p + 1]! & 0x1f) << 8) | b[p + 2]!;
export const isPusi = (b: Uint8Array, p: number) => (b[p + 1]! & 0x40) !== 0;

/** Index of the payload start within the packet, or -1 if no payload. */
export function payloadStart(b: Uint8Array, p: number): number {
  const afc = (b[p + 3]! >> 4) & 3;
  if (!(afc & 1)) return -1;
  const s = afc & 2 ? p + 5 + b[p + 4]! : p + 4;
  return s < p + PKT ? s : -1;
}

/** PTS in seconds from a PES header starting at s, or NaN. */
export function pesPts(b: Uint8Array, s: number): number {
  if (b[s] !== 0 || b[s + 1] !== 0 || b[s + 2] !== 1 || !(b[s + 7]! & 0x80)) return NaN;
  const pts =
    ((b[s + 9]! >> 1) & 7) * 2 ** 30 + (b[s + 10]! << 22) + ((b[s + 11]! >> 1) << 15) + (b[s + 12]! << 7) + (b[s + 13]! >> 1);
  return pts / 90000;
}

/** True when the PES payload starting near s carries an IDR slice (5) start. */
export function startsKeyframe(b: Uint8Array, s: number, end: number): boolean {
  const from = s + 9 + b[s + 8]!;
  for (let i = from; i + 4 < end; i++) {
    if (b[i] === 0 && b[i + 1] === 0 && (b[i + 2] === 1 || (b[i + 2] === 0 && b[i + 3] === 1))) {
      const nal = b[b[i + 2] === 1 ? i + 3 : i + 4]! & 31;
      if (nal === 5) return true;
    }
  }
  return false;
}

/**
 * mux.js takes the FIRST PAT entry as the PMT PID, but Wolfbox lists program 0 (network PID 0x1F)
 * first. Overwrite that entry with the real program in a PAT packet copy (CRC left stale; unchecked).
 */
export function fixPat(pkt: Uint8Array): Uint8Array {
  const s = payloadStart(pkt, 0);
  if (s < 0) return pkt;
  const q = s + 1 + pkt[s]! + 8;
  if (pkt[q] === 0 && pkt[q + 1] === 0 && q + 8 <= PKT) pkt.copyWithin(q, q + 4, q + 8);
  return pkt;
}

export interface Psi {
  videoPid: number;
  audioPid?: number;
  /** One PAT + one PMT packet to prefix a mid-file start. */
  packets: Uint8Array;
}

export interface Probe {
  duration: number;
  firstPts: number;
  frameDuration: number;
  psi: Psi;
}

const sectionStart = (b: Uint8Array, p: number) => {
  const s = payloadStart(b, p);
  return s < 0 ? -1 : s + 1 + b[s]!; // pointer_field
};

/** Cheap probe: read the head and tail of the file only (never the whole 90 MB). */
const probes = new WeakMap<Blob, Promise<Probe>>();
export function probeTs(blob: Blob): Promise<Probe> {
  let p = probes.get(blob);
  if (!p) probes.set(blob, (p = probeTsNow(blob)));
  p.catch(() => probes.delete(blob));
  return p;
}

async function probeTsNow(blob: Blob): Promise<Probe> {
  const HEAD = 768 * 1024;
  const TAIL = 1024 * 1024;
  const head = await readBytes(blob, 0, HEAD);
  let pmtPid = -1;
  let patPkt: Uint8Array | undefined;
  let pmtPkt: Uint8Array | undefined;
  let videoPid = -1;
  let audioPid: number | undefined;
  let firstPts = NaN;
  new TsPacketReader().push(head, 0, true, (b, p) => {
    const pid = pidOf(b, p);
    if (pid === 0 && isPusi(b, p) && !patPkt) {
      const s = sectionStart(b, p);
      if (s > 0 && b[s] === 0) {
        // program 0 is the network PID; the first real program carries the streams
        const end = s + 3 + (((b[s + 1]! & 15) << 8) | b[s + 2]!) - 4;
        for (let q = s + 8; q + 4 <= end; q += 4) {
          if ((b[q]! << 8) | b[q + 1]!) {
            pmtPid = ((b[q + 2]! & 0x1f) << 8) | b[q + 3]!;
            patPkt = fixPat(b.slice(p, p + PKT));
            break;
          }
        }
      }
    } else if (pid === pmtPid && isPusi(b, p) && !pmtPkt) {
      const s = sectionStart(b, p);
      if (s < 0 || b[s] !== 2) return;
      const end = s + 3 + (((b[s + 1]! & 15) << 8) | b[s + 2]!) - 4;
      let q = s + 12 + (((b[s + 10]! & 15) << 8) | b[s + 11]!);
      while (q + 5 <= end) {
        const type = b[q]!;
        const ep = ((b[q + 1]! & 0x1f) << 8) | b[q + 2]!;
        if (type === 0x1b && videoPid < 0) videoPid = ep;
        if ((type === 0x0f || type === 0x03) && audioPid === undefined) audioPid = ep;
        q += 5 + (((b[q + 3]! & 15) << 8) | b[q + 4]!);
      }
      pmtPkt = b.slice(p, p + PKT);
    } else if (pid === videoPid && isPusi(b, p) && Number.isNaN(firstPts)) {
      const s = payloadStart(b, p);
      if (s > 0) firstPts = pesPts(b, s);
    }
  });
  if (!patPkt || !pmtPkt || videoPid < 0 || Number.isNaN(firstPts)) {
    throw new Error('Not a readable MPEG-TS recording (no PAT/PMT/H.264 video found at the start).');
  }
  const start = Math.max(0, blob.size - TAIL);
  const tail = await readBytes(blob, start);
  const pts: number[] = [];
  new TsPacketReader().push(tail, start, true, (b, p) => {
    if (pidOf(b, p) === videoPid && isPusi(b, p)) {
      const s = payloadStart(b, p);
      if (s > 0) {
        const v = pesPts(b, s);
        if (!Number.isNaN(v)) pts.push(v);
      }
    }
  });
  if (pts.length < 2) throw new Error('Recording appears truncated: no video frames found near the end.');
  const last = pts[pts.length - 1]!;
  const frameDuration = Math.max(0.01, Math.min(0.1, (last - pts[pts.length - 2]!) || 1 / 30));
  const packets = new Uint8Array(2 * PKT);
  packets.set(patPkt);
  packets.set(pmtPkt, PKT);
  return {
    duration: Math.max(0, last - firstPts + frameDuration),
    firstPts,
    frameDuration,
    psi: { videoPid, audioPid, packets },
  };
}

export interface Keyframe {
  offset: number;
  /** Seconds from the first video frame. */
  time: number;
}

/** Keyframes found in just `[from, from+len)`: lets a window start mid-file without reading what comes before it. */
export async function scanKeyframesAt(blob: Blob, probe: Probe, from: number, len: number): Promise<Keyframe[]> {
  const out: Keyframe[] = [];
  const end = Math.min(blob.size, from + len);
  const chunk = await readBytes(blob, from, end);
  new TsPacketReader().push(chunk, from, end >= blob.size, (b, p, off) => {
    if (pidOf(b, p) !== probe.psi.videoPid || !isPusi(b, p)) return;
    const s = payloadStart(b, p);
    if (s > 0 && startsKeyframe(b, s, p + PKT)) out.push({ offset: off, time: pesPts(b, s) - probe.firstPts });
  });
  return out.filter((k, i) => i === 0 || k.time - out[i - 1]!.time > 0.2);
}

/**
 * The last keyframe at or before `t`, found by interpolating the byte position from the time (the bit rate is
 * roughly even) and refining with a few small reads: ~2-4 MB read instead of the whole file.
 */
export async function locateKeyframe(blob: Blob, probe: Probe, t: number): Promise<Keyframe> {
  if (t <= 0.05) return { offset: 0, time: 0 };
  let a: Keyframe = { offset: 0, time: 0 };
  let b: Keyframe = { offset: blob.size, time: probe.duration };
  for (let i = 0; i < 10; i++) {
    const f = (t - a.time) / Math.max(1e-6, b.time - a.time);
    const guess = Math.max(0, Math.floor(a.offset + f * (b.offset - a.offset) - 512 * 1024));
    const kfs = await scanKeyframesAt(blob, probe, guess, 3 * 1024 * 1024);
    if (!kfs.length) break;
    const before = kfs.filter((k) => k.time <= t);
    const after = kfs.find((k) => k.time > t);
    if (before.length && after) return before[before.length - 1]!;
    if (!before.length) {
      if (guess === 0) return kfs[0]!;
      b = kfs[0]!;
    } else a = before[before.length - 1]!;
  }
  // did not converge (very uneven bit rate): fall back to one full scan
  const all = await scanKeyframes(blob, probe);
  return [...all].reverse().find((k) => k.time <= t) ?? all[0] ?? { offset: 0, time: 0 };
}

/** Full-file scan for seek points (~one pass over the file; only done on demand). */
export async function scanKeyframes(blob: Blob, probe: Probe, onChunk?: () => Promise<void> | void): Promise<Keyframe[]> {
  const CHUNK = 4 * 1024 * 1024;
  const out: Keyframe[] = [];
  const reader = new TsPacketReader();
  for (let pos = 0; pos < blob.size; pos += CHUNK) {
    const chunk = await readBytes(blob, pos, pos + CHUNK);
    reader.push(chunk, pos, pos + CHUNK >= blob.size, (b, p, off) => {
      if (pidOf(b, p) !== probe.psi.videoPid || !isPusi(b, p)) return;
      const s = payloadStart(b, p);
      if (s > 0 && startsKeyframe(b, s, p + PKT)) out.push({ offset: off, time: pesPts(b, s) - probe.firstPts });
    });
    await onChunk?.();
  }
  // consecutive SPS+IDR hits belong to one GOP start; keep the first of each cluster
  return out.filter((k, i) => i === 0 || k.time - out[i - 1]!.time > 0.2);
}

/**
 * Groups clean packets into blocks that end right BEFORE a video PES start, so that flushing the
 * demuxer between blocks never splits a video frame (mux.js treats flush as end-of-PES).
 * Audio PES in flight are tracked by declared length so a block does not end mid audio frame.
 *
 * Damaged frames: the recordings lose video packets (continuity-counter gaps) and have junk bytes
 * inside the stream. Measured on one clip: level 1 removes ~34% of frames (13% lost-packet frames, the
 * rest GOPs behind a damaged IDR) and still leaves ~1.5% corrupt for ffmpeg; level 2 decodes cleanly in
 * ffmpeg. Chrome's VideoToolbox path aborts on any corrupt frame, so MseClip escalates 0 → 1 → 2 after
 * decode errors; a decoder that conceals (QuickTime, maybe Safari) looks best at level 0.
 */
/**
 * 0 keep every frame (only garbage-PTS frames are removed) · 1 drop frames that lost packets, and the
 * rest of a GOP whose IDR was damaged · 2 also drop every frame containing junk bytes.
 */
export type RepairLevel = 0 | 1 | 2;

export class TsBlockSplitter {
  private parts: Uint8Array[] = [];
  private size = 0;
  private audioLeft = 0;
  private lastCc = -1;
  private pes: Uint8Array[] = [];
  private pesDamaged = false;
  private lastVideoPts = NaN;
  private lastAudioPts = NaN;
  private skipAudio = false;
  private junkPending = false;
  private curKey = false;
  private dropUntilKey = true;
  readonly blocks: Uint8Array[] = [];
  droppedFrames = 0;
  totalFrames = 0;
  constructor(
    private videoPid: number,
    private audioPid: number | undefined,
    private target: number,
    private level: RepairLevel = 0,
  ) {}

  add(b: Uint8Array, p: number, junk = 0) {
    const pid = pidOf(b, p);
    const pkt = b.slice(p, p + PKT);
    // bytes of junk where a packet should be = lost/overwritten data, even if the continuity counter hides it
    if (junk) this.junkPending = true;
    if (pid === this.videoPid) {
      const pusi = isPusi(b, p);
      const hasPayload = ((b[p + 3]! >> 4) & 1) === 1;
      let gap = false;
      if (hasPayload) {
        const cc = b[p + 3]! & 15;
        gap = this.lastCc >= 0 && cc !== this.lastCc && cc !== ((this.lastCc + 1) & 15);
        this.lastCc = cc;
      }
      if (pusi) {
        // a gap right at a frame start means the PREVIOUS frame lost its tail
        if (this.hurt(gap)) this.pesDamaged = true;
        this.junkPending = false;
        // a damaged IDR leaves the rest of its GOP without a reference: drop that too
        if (this.pesDamaged && this.curKey) this.dropUntilKey = true;
        this.commitPes();
        // in-place corruption can leave a garbage PTS that would throw the whole timeline off
        const s = payloadStart(b, p);
        const pts = s > 0 ? pesPts(b, s) : NaN;
        const key = s > 0 && startsKeyframe(b, s, p + PKT);
        // cut only at an IDR: otherwise mux.js re-sends the previous GOP at the head of the next fragment
        if (key && this.size >= this.target && this.audioLeft <= 0) this.cut();
        if (key) this.dropUntilKey = false;
        let bad = Number.isNaN(pts) || (!Number.isNaN(this.lastVideoPts) && Math.abs(pts - this.lastVideoPts) > MAX_PTS_JUMP_S);
        if (!bad) this.lastVideoPts = pts;
        if (this.dropUntilKey) bad = true;
        this.curKey = key;
        this.pesDamaged = bad;
      } else if (this.hurt(gap)) {
        this.pesDamaged = true;
        this.junkPending = false;
      }
      this.pes.push(pkt);
      return;
    }
    if (this.level >= 2 && this.junkPending) {
      this.pesDamaged = true;
      this.junkPending = false;
    }
    if (pid === this.audioPid) {
      const s = payloadStart(b, p);
      if (s > 0) {
        if (isPusi(b, p)) {
          const pts = pesPts(b, s);
          // audio PTS never goes back: a repeat is a duplicated frame (the recordings carry ~5 % of them), and keeping it stretches the audio against the video
          const bad = Number.isNaN(pts) || (!Number.isNaN(this.lastAudioPts) && (Math.abs(pts - this.lastAudioPts) > MAX_PTS_JUMP_S || pts <= this.lastAudioPts));
          if (!bad) this.lastAudioPts = pts;
          this.skipAudio = bad;
          const len = (b[s + 4]! << 8) | b[s + 5]!;
          this.audioLeft = len > 0 ? len + 6 : 0;
        }
        this.audioLeft -= p + PKT - s;
      }
      if (this.skipAudio) return;
    }
    this.parts.push(pid === 0 ? fixPat(pkt) : pkt);
    this.size += PKT;
  }

  /** Is this packet evidence of damage, at the current repair level? */
  private hurt(gap: boolean) {
    return (gap && this.level >= 1) || (this.level >= 2 && this.junkPending);
  }

  private commitPes() {
    if (!this.pes.length) return;
    this.totalFrames++;
    if (this.pesDamaged) this.droppedFrames++;
    else {
      for (const x of this.pes) this.parts.push(x);
      this.size += this.pes.length * PKT;
    }
    this.pes = [];
  }

  private cut() {
    if (!this.size) return;
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const x of this.parts) {
      out.set(x, o);
      o += x.length;
    }
    this.blocks.push(out);
    this.parts = [];
    this.size = 0;
  }

  /** Emit the remainder (call at end of file only). */
  finish() {
    this.commitPes();
    this.cut();
  }

  take(): Uint8Array[] {
    return this.blocks.splice(0);
  }
}

/**
 * The recordings use B-frames but PES headers carry only a PTS, so mux.js (which falls back to
 * DTS=PTS) sees decode time going backwards. Rebuild a monotonic DTS: PTS minus a fixed reorder
 * delay (2 frames at 25 fps = 7200 ticks of 90 kHz; the observed worst backward PTS step is 1.5 frames),
 * forced strictly increasing. Presentation times still come from PTS.
 */
export const DTS_DELAY_TICKS = 7200;
export class DtsFixer {
  /** Last DTS handed out (90 kHz ticks). */
  last = -Infinity;
  /** First DTS handed out since the last mark(). */
  first = NaN;
  fix = (pts: number): number => {
    this.last = Math.max(pts - DTS_DELAY_TICKS, this.last + 1);
    if (Number.isNaN(this.first)) this.first = this.last;
    return this.last;
  };
  mark() {
    this.first = NaN;
  }
}
