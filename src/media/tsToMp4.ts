import mux, { type TransmuxSegment } from 'mux.js';
import { EmbeddedGpsCollector } from '../gps/embedded';
import type { GpxPoint } from '../gps/GpxParser';
import { patchLastDuration } from './fmp4';
import { toPlainMp4 } from './mp4File';
import { DtsFixer, locateKeyframe, readBytes, TsBlockSplitter, TsPacketReader, type Probe, type RepairLevel } from './ts';

const READ_CHUNK = 1024 * 1024;
const BLOCK_TARGET = 1024 * 1024;
/** Frames are read this far past the window's end, so the last frames of the window are complete whatever the B-frame order. */
const TAIL_S = 2.2;
/** A window plays this long past its end, so the next window can start underneath it before the picture is switched. */
export const OVERLAP_S = 1.5;

export interface WindowSpan {
  /** Seconds into the recording where the window starts / ends. Omit both for the whole clip. */
  start?: number;
  end?: number;
}

export interface ConvertedPieces {
  /** The MP4 as pieces (not yet a Blob). A worker hands these over as transferable buffers: a Blob made in a worker can become unreadable in some browsers once the worker is gone. */
  pieces: Uint8Array[];
  dropped: number;
  total: number;
  gps: GpxPoint[];
}

export interface Converted {
  mp4: Blob;
  dropped: number;
  total: number;
  /** GPS fixes found in the part that was read (clip-relative seconds). */
  gps: GpxPoint[];
}

/**
 * MPEG-TS → ordinary MP4, in memory, for ONE WINDOW of a recording (or all of it). Only the bytes of the window are
 * read and held (plus ~1 s), so a 5-minute recording costs the same as a 20-second one. The conversion starts at the
 * keyframe at or before `start`; the edit list in the file hides the lead-in, so the player sees exactly [start, end].
 * Same resync / frame filter / DTS rebuild / last-duration patch as the MediaSource path.
 */
export async function transmuxToMp4(blob: Blob, probe: Probe, level: RepairLevel, span: WindowSpan = {}, isLive: () => boolean = () => true, onProgress?: (fraction: number) => void): Promise<Converted | null> {
  const r = await transmuxToPieces(blob, probe, level, span, isLive, onProgress);
  return r && { mp4: new Blob(r.pieces as BlobPart[], { type: 'video/mp4' }), dropped: r.dropped, total: r.total, gps: r.gps };
}

export async function transmuxToPieces(blob: Blob, probe: Probe, level: RepairLevel, span: WindowSpan = {}, isLive: () => boolean = () => true, onProgress?: (fraction: number) => void): Promise<ConvertedPieces | null> {
  const start = span.start ?? 0;
  const end = span.end ?? Infinity;
  const kf = start > 0.05 ? await locateKeyframe(blob, probe, start) : { offset: 0, time: 0 };
  if (!isLive()) return null;

  const tm = new mux.mp4.Transmuxer({ remux: true });
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

  const parts: Uint8Array[] = [];
  let init: Uint8Array | undefined;
  const keep = (segs: TransmuxSegment[]) => {
    for (const s of segs) {
      init ??= s.initSegment;
      parts.push(s.data);
    }
  };
  const reader = new TsPacketReader();
  const gpsFix = new EmbeddedGpsCollector(probe); // the GPS rides along in this same pass: no second read of the file
  const splitter = new TsBlockSplitter(probe.psi.videoPid, probe.psi.audioPid, BLOCK_TARGET, level);
  // one fragment is held back so its final sample can get the real duration
  let held: { segs: TransmuxSegment[]; lastDts: number } | undefined;
  const feed = (blocks: Uint8Array[]) => {
    for (const blk of blocks) {
      fixer.mark();
      tm.push(blk);
      tm.flush();
      if (held && !Number.isNaN(fixer.first)) for (const sg of held.segs) patchLastDuration(sg.data, probe.psi.videoPid, fixer.first - held.lastDts);
      if (held) keep(held.segs);
      held = { segs: out.splice(0), lastDts: fixer.last };
    }
  };

  // read the next chunk while this one is being transmuxed: the file and the CPU are busy at the same time
  const read = (pos: number) => (pos < blob.size ? readBytes(blob, pos, pos + READ_CHUNK) : undefined);
  let pending = read(kf.offset);
  const span1 = Math.max(1, Math.min(end, probe.duration) - kf.time);
  for (let pos = kf.offset; pending; pos += READ_CHUNK) {
    if (!isLive()) return null;
    const chunk = await pending;
    const last = pos + chunk.length >= blob.size;
    const done = gpsFix.lastTime >= end + TAIL_S; // the window and its tail have been read
    pending = last || done ? undefined : read(pos + READ_CHUNK);
    reader.push(chunk, pos, last, (b, p, _o, junk) => {
      gpsFix.feed(b, p);
      splitter.add(b, p, junk);
    });
    if (!pending) splitter.finish();
    feed(splitter.take());
    onProgress?.(Math.min(1, Math.max(0, (gpsFix.lastTime - kf.time) / span1)));
    await new Promise((r) => setTimeout(r)); // let the page breathe between chunks
  }
  tm.flush();
  if (held) keep((held as { segs: TransmuxSegment[] }).segs);
  keep(out.splice(0));
  if (!init) throw new Error('No playable video found in this recording.');
  const pieces = toPlainMp4(init, parts, { skip: Math.max(0, start - kf.time), length: Number.isFinite(end) ? end - start + OVERLAP_S : Infinity });
  return { pieces, dropped: splitter.droppedFrames, total: splitter.totalFrames, gps: gpsFix.points };
}
