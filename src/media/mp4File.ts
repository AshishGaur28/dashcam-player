/**
 * mux.js only writes FRAGMENTED mp4 (moov with no sample tables + many moof/mdat). Chrome plays that from a blob,
 * Safari plays the audio and shows black video. This rewrites it as an ordinary MP4 (ftyp, one moov with real
 * sample tables, one mdat): the same structure ffmpeg's files have, which every browser plays.
 */

interface Box {
  type: string;
  start: number;
  end: number;
}
interface Track {
  id: number;
  timescale: number;
  handler: string;
  trak: Uint8Array; // original trak bytes (tkhd/mdia/hdlr/minf kept; stbl rebuilt)
  stsd: Uint8Array;
  startTime: number; // first tfdt, media units
  dur: number[];
  size: number[];
  sync: boolean[];
  cts: number[];
  chunks: { count: number; data: Uint8Array }[];
  /** raw samples as read from the fragments; filtered into the arrays above */
  raw: { dur: number; sync: boolean; cts: number; data: Uint8Array; run: number }[];
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const cat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of a) {
    o.set(x, p);
    p += x.length;
  }
  return o;
};
const box = (type: string, ...p: Uint8Array[]) => {
  const body = cat(...p);
  return cat(u32(body.length + 8), new Uint8Array([...type].map((c) => c.charCodeAt(0))), body);
};
const full = (type: string, version: number, flags: number, ...p: Uint8Array[]) => box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...p);

function kids(b: Uint8Array, start: number, end: number): Box[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  for (let o = start; o + 8 <= end; ) {
    const size = dv.getUint32(o);
    if (size < 8) break;
    out.push({ type: String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!), start: o, end: Math.min(o + size, end) });
    o += size;
  }
  return out;
}
const find = (b: Uint8Array, parent: Box, type: string) => kids(b, parent.start + 8, parent.end).find((k) => k.type === type);

/** `init` = ftyp+moov of the fragmented file, `fragments` = every moof/mdat after it, in order. */
export interface Window {
  /** Seconds of the converted timeline to start presenting at (the converter starts at a keyframe, a little earlier). */
  skip: number;
  /** Seconds to present; the rest of the converted data is ignored by the player. */
  length: number;
}

/** Returns the file as pieces (nothing is concatenated), so a Blob can be built from them with one copy. */
export function toPlainMp4(init: Uint8Array, fragments: Uint8Array[], win: Window = { skip: 0, length: Infinity }): Uint8Array[] {
  const idv = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const moov = kids(init, 0, init.length).find((b) => b.type === 'moov');
  if (!moov) throw new Error('No moov in the converted video.');
  const mvhd = find(init, moov, 'mvhd')!;
  const mvhdBytes = init.slice(mvhd.start, mvhd.end);
  const mvTimescale = idv.getUint32(mvhd.start + (init[mvhd.start + 8] === 1 ? 28 : 20));

  const tracks = new Map<number, Track>();
  for (const trak of kids(init, moov.start + 8, moov.end).filter((b) => b.type === 'trak')) {
    const tkhd = find(init, trak, 'tkhd')!;
    const id = idv.getUint32(tkhd.start + (init[tkhd.start + 8] === 1 ? 28 : 20));
    const mdia = find(init, trak, 'mdia')!;
    const mdhd = find(init, mdia, 'mdhd')!;
    const hdlr = find(init, mdia, 'hdlr')!;
    const minf = find(init, mdia, 'minf')!;
    const stbl = find(init, minf, 'stbl')!;
    const stsd = find(init, stbl, 'stsd')!;
    tracks.set(id, {
      id,
      timescale: idv.getUint32(mdhd.start + (init[mdhd.start + 8] === 1 ? 28 : 20)),
      handler: String.fromCharCode(...init.subarray(hdlr.start + 16, hdlr.start + 20)),
      trak: init.slice(trak.start, trak.end),
      stsd: init.slice(stsd.start, stsd.end),
      startTime: -1,
      dur: [],
      size: [],
      sync: [],
      cts: [],
      chunks: [],
      raw: [],
    });
  }

  // ---- read the fragments
  let runs = 0;
  for (const frag of fragments) {
    const dv = new DataView(frag.buffer, frag.byteOffset, frag.byteLength);
    for (const moof of kids(frag, 0, frag.length).filter((b) => b.type === 'moof')) {
      for (const traf of kids(frag, moof.start + 8, moof.end).filter((b) => b.type === 'traf')) {
        const k = kids(frag, traf.start + 8, traf.end);
        const tfhd = k.find((x) => x.type === 'tfhd')!;
        const tfdt = k.find((x) => x.type === 'tfdt');
        const tf = dv.getUint32(tfhd.start + 8) & 0xffffff;
        const t = tracks.get(dv.getUint32(tfhd.start + 12));
        if (!t) continue;
        let p = tfhd.start + 16;
        let base = moof.start;
        if (tf & 1) {
          base = Number(dv.getBigUint64(p));
          p += 8;
        }
        if (tf & 2) p += 4;
        const defDur = tf & 8 ? dv.getUint32(p) : 0;
        if (tf & 8) p += 4;
        const defSize = tf & 16 ? dv.getUint32(p) : 0;
        if (tf & 16) p += 4;
        const defFlags = tf & 32 ? dv.getUint32(p) : 0;
        if (t.startTime < 0 && tfdt) t.startTime = dv.getUint8(tfdt.start + 8) === 1 ? Number(dv.getBigUint64(tfdt.start + 12)) : dv.getUint32(tfdt.start + 12);
        for (const trun of k.filter((x) => x.type === 'trun')) {
          const version = dv.getUint8(trun.start + 8);
          const fl = dv.getUint32(trun.start + 8) & 0xffffff;
          const n = dv.getUint32(trun.start + 12);
          let q = trun.start + 16;
          let at = base;
          if (fl & 1) {
            at = base + dv.getInt32(q);
            q += 4;
          }
          let firstFlags = -1;
          if (fl & 4) {
            firstFlags = dv.getUint32(q);
            q += 4;
          }
          const run = ++runs;
          for (let i = 0; i < n; i++) {
            const dur = fl & 0x100 ? dv.getUint32(q) : defDur;
            if (fl & 0x100) q += 4;
            const size = fl & 0x200 ? dv.getUint32(q) : defSize;
            if (fl & 0x200) q += 4;
            let flags = fl & 0x400 ? dv.getUint32(q) : defFlags;
            if (fl & 0x400) q += 4;
            if (i === 0 && firstFlags >= 0) flags = firstFlags;
            const cts = fl & 0x800 ? (version === 1 ? dv.getInt32(q) : dv.getUint32(q)) : 0;
            if (fl & 0x800) q += 4;
            t.raw.push({ dur, sync: (flags & 0x10000) === 0, cts, data: frag.subarray(at, at + size), run });
            at += size;
          }
        }
      }
    }
  }

  // ---- clean up: the camera sometimes puts a frame's picture in the PES after its header, which leaves a tiny
  // picture-less sample (an access-unit delimiter only). Drop it and give its time to the sample before it, and
  // never leave a zero duration (a repeated timestamp makes players reject the file).
  for (const t of tracks.values()) {
    let prev: (typeof t.raw)[number] | undefined;
    let carry = 0;
    let last = -1;
    let broke = false; // a dropped sample sits between the previous kept one and the next
    for (const r of t.raw) {
      if (t.handler === 'vide' && r.data.length <= 64) {
        if (prev) prev.dur += r.dur;
        else carry += r.dur;
        broke = true;
        continue;
      }
      r.dur += carry;
      carry = 0;
      if (broke || r.run !== last || !prev) t.chunks.push({ count: 0, data: r.data });
      broke = false;
      const c = t.chunks[t.chunks.length - 1]!;
      // consecutive samples of one run are contiguous in the fragment: extend the chunk
      if (c.count > 0) c.data = new Uint8Array(c.data.buffer, c.data.byteOffset, c.data.length + r.data.length);
      c.count++;
      last = r.run;
      prev = r;
      t.dur.push(0);
      t.size.push(r.data.length);
      t.sync.push(r.sync);
      t.cts.push(r.cts);
    }
    // durations are final only now (a dropped sample adds to the previous one)
    let k = 0;
    for (const r of t.raw) {
      if (t.handler === 'vide' && r.data.length <= 64) continue;
      t.dur[k++] = Math.max(1, r.dur);
    }
  }

  const list = [...tracks.values()].filter((t) => t.size.length);
  if (!list.length) throw new Error('The converted video has no samples.');

  const total = (t: Track) => t.dur.reduce((a, b) => a + b, 0);
  // edit list per track: where in the media it starts presenting and for how long (movie timescale); a late-starting track
  // gets an empty edit first, and the video's composition lead is trimmed so video and audio line up at 0
  const plan = new Map<Track, { dur: number; media: number }[]>();
  for (const t of list) {
    const lead = (t.handler === 'vide' ? t.cts[0] ?? 0 : 0) / t.timescale;
    const delay = t.startTime > 0 ? t.startTime / t.timescale : 0;
    const mediaSec = total(t) / t.timescale;
    const entries: { secs: number; media: number }[] = [];
    let remaining = win.length;
    let mediaStart: number;
    if (delay > win.skip) {
      const e = Math.min(delay - win.skip, remaining);
      entries.push({ secs: e, media: -1 });
      remaining -= e;
      mediaStart = lead;
    } else mediaStart = lead + (win.skip - delay);
    const avail = Math.max(0, mediaSec - mediaStart);
    if (remaining > 0 && avail > 0) entries.push({ secs: Math.min(remaining, avail), media: mediaStart });
    if (!entries.length) entries.push({ secs: 0, media: 0 });
    plan.set(t, entries.map((e) => ({ dur: Math.round(e.secs * mvTimescale), media: e.media < 0 ? -1 : Math.round(e.media * t.timescale) })));
  }
  const trackLen = (t: Track) => plan.get(t)!.reduce((a, e) => a + e.dur, 0);
  const movieDur = Math.max(...list.map(trackLen));

  const ftyp = box('ftyp', new Uint8Array([...'isom'].map((c) => c.charCodeAt(0))), u32(512), ...['isom', 'iso2', 'avc1', 'mp41'].map((s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)))));

  const build = (offsets: number[][]) => {
    const parts: Uint8Array[] = [];
    // movie header: copy and set duration
    const mv = mvhdBytes.slice();
    new DataView(mv.buffer).setUint32(mv[8] === 1 ? 32 : 24, movieDur);
    parts.push(mv);
    list.forEach((t, ti) => {
      const stts: number[] = [];
      for (let i = 0; i < t.dur.length; ) {
        let j = i;
        while (j < t.dur.length && t.dur[j] === t.dur[i]) j++;
        stts.push(j - i, t.dur[i]!);
        i = j;
      }
      const ctts: number[] = [];
      const hasCts = t.cts.some((c) => c !== 0);
      const signed = t.cts.some((c) => c > 0x7fffffff);
      if (hasCts)
        for (let i = 0; i < t.cts.length; ) {
          let j = i;
          while (j < t.cts.length && t.cts[j] === t.cts[i]) j++;
          ctts.push(j - i, t.cts[i]!);
          i = j;
        }
      const syncIdx = t.sync.flatMap((s, i) => (s ? [i + 1] : []));
      const stsc: number[] = [];
      let prev = -1;
      t.chunks.forEach((c, i) => {
        if (c.count !== prev) stsc.push(i + 1, c.count, 1);
        prev = c.count;
      });
      const stbl = box(
        'stbl',
        t.stsd,
        full('stts', 0, 0, u32(stts.length / 2), ...stts.map(u32)),
        ...(hasCts && !signed ? [full('ctts', 0, 0, u32(ctts.length / 2), ...ctts.map(u32))] : []),
        ...(t.handler === 'vide' && syncIdx.length < t.sync.length ? [full('stss', 0, 0, u32(syncIdx.length), ...syncIdx.map(u32))] : []),
        full('stsc', 0, 0, u32(stsc.length / 3), ...stsc.map(u32)),
        full('stsz', 0, 0, u32(0), u32(t.size.length), ...t.size.map(u32)),
        full('stco', 0, 0, u32(t.chunks.length), ...offsets[ti]!.map(u32)),
      );
      // keep the original trak, swapping its (empty) stbl for the real one and fixing the durations
      const trak = t.trak.slice();
      const kd = new DataView(trak.buffer);
      const tk = kids(trak, 8, trak.length);
      const tkhd = tk.find((b) => b.type === 'tkhd')!;
      const mdia = tk.find((b) => b.type === 'mdia')!;
      const mdhd = find(trak, mdia, 'mdhd')!;
      const mediaDur = total(t);
      const trackDur = trackLen(t);
      kd.setUint32(tkhd.start + (trak[tkhd.start + 8] === 1 ? 36 : 28), trackDur);
      kd.setUint32(mdhd.start + (trak[mdhd.start + 8] === 1 ? 32 : 24), mediaDur);
      const minf = find(trak, mdia, 'minf')!;
      const oldStbl = find(trak, minf, 'stbl')!;
      const minfNew = box('minf', trak.slice(minf.start + 8, oldStbl.start), stbl);
      const mdiaNew = box('mdia', trak.slice(mdia.start + 8, minf.start), minfNew);
      const edits = plan.get(t)!;
      const edts = box('edts', full('elst', 0, 0, u32(edits.length), ...edits.flatMap((e) => [u32(e.dur), u32(e.media < 0 ? 0xffffffff : e.media), u32(1 << 16)])));
      parts.push(box('trak', trak.slice(tkhd.start, tkhd.end), edts, mdiaNew));
    });
    return box('moov', ...parts);
  };

  const first = build(list.map((t) => t.chunks.map(() => 0)));
  const dataStart = ftyp.length + first.length + 8;
  // chunk offsets: tracks interleave per fragment (video chunk, audio chunk, …) in file order
  const offsets = list.map((t) => t.chunks.map(() => 0));
  const order: { t: number; c: number }[] = [];
  const maxChunks = Math.max(...list.map((t) => t.chunks.length));
  for (let c = 0; c < maxChunks; c++) list.forEach((t, ti) => c < t.chunks.length && order.push({ t: ti, c }));
  let pos = dataStart;
  for (const o of order) {
    offsets[o.t]![o.c] = pos;
    pos += list[o.t]!.chunks[o.c]!.data.length;
  }
  const moovFinal = build(offsets);
  if (moovFinal.length !== first.length) throw new Error('moov size changed while building');
  const mdatHead = cat(u32(pos - dataStart + 8), new Uint8Array([0x6d, 0x64, 0x61, 0x74]));
  return [ftyp, moovFinal, mdatHead, ...order.map((o) => list[o.t]!.chunks[o.c]!.data)];
}
