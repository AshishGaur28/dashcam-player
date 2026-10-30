/**
 * mux.js writes the last sample of every flushed fragment with a guessed duration (a copy of the
 * previous one). After dropped frames that guess can run into the next fragment and MSE then evicts
 * frames (a visible hole). Overwrite it with the real DTS delta, in place (sizes unchanged).
 */
export function patchLastDuration(data: Uint8Array, trackId: number, duration: number): boolean {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const type = (o: number) => String.fromCharCode(data[o + 4]!, data[o + 5]!, data[o + 6]!, data[o + 7]!);
  const children = (start: number, end: number) => {
    const out: { o: number; end: number; t: string }[] = [];
    for (let o = start; o + 8 <= end; ) {
      const size = dv.getUint32(o);
      if (size < 8) break;
      out.push({ o, end: o + size, t: type(o) });
      o += size;
    }
    return out;
  };
  for (const moof of children(0, data.length).filter((b) => b.t === 'moof'))
    for (const traf of children(moof.o + 8, moof.end).filter((b) => b.t === 'traf')) {
      const kids = children(traf.o + 8, traf.end);
      const tfhd = kids.find((k) => k.t === 'tfhd');
      const trun = kids.find((k) => k.t === 'trun');
      if (!tfhd || !trun || dv.getUint32(tfhd.o + 12) !== trackId) continue;
      const flags = dv.getUint32(trun.o + 8) & 0xffffff;
      if (!(flags & 0x100)) return false; // no per-sample duration
      const count = dv.getUint32(trun.o + 12);
      const entry = 4 * ((flags & 0x100 ? 1 : 0) + (flags & 0x200 ? 1 : 0) + (flags & 0x400 ? 1 : 0) + (flags & 0x800 ? 1 : 0));
      const first = (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
      const at = trun.o + 16 + first + (count - 1) * entry;
      if (!count || at + 4 > trun.end) return false;
      dv.setUint32(at, Math.max(1, Math.round(duration)));
      return true;
    }
  return false;
}
