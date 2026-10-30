/// <reference lib="webworker" />
import { transmuxToPieces, type WindowSpan } from './tsToMp4';
import type { Probe, RepairLevel } from './ts';

interface Job {
  blob: Blob;
  probe: Probe;
  level: RepairLevel;
  span: WindowSpan;
}

let cancelled = false;

/** One conversion per worker: the page's main thread stays free for the picture, the timeline and the map. */
self.onmessage = async (e: MessageEvent<Job | 'cancel'>) => {
  if (e.data === 'cancel') {
    cancelled = true;
    return;
  }
  const { blob, probe, level, span } = e.data;
  try {
    const r = await transmuxToPieces(blob, probe, level, span, () => !cancelled, (f) => self.postMessage({ progress: f }));
    // hand the bytes over (moved, not copied) and let the page build the Blob: nothing here has to outlive the worker
    const buffers = r ? [...new Set(r.pieces.map((p) => p.buffer))] : [];
    self.postMessage({ done: r }, { transfer: buffers as ArrayBuffer[] });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
