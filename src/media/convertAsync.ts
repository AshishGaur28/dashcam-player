import ConvertWorker from './convert.worker?worker&inline';
import type { Probe, RepairLevel } from './ts';
import { transmuxToMp4, type Converted, type ConvertedPieces, type WindowSpan } from './tsToMp4';

/**
 * Runs the conversion in a Web Worker so it cannot make the page stutter. If a worker cannot be started
 * (some locked-down browsers), it runs on the page instead: slower to respond, same result.
 */
export function convert(blob: Blob, probe: Probe, level: RepairLevel, span: WindowSpan, isLive: () => boolean, onProgress: (f: number) => void): Promise<Converted | null> {
  let worker: Worker;
  try {
    worker = new ConvertWorker();
  } catch {
    return transmuxToMp4(blob, probe, level, span, isLive, onProgress);
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    const end = () => {
      finished = true;
      clearInterval(watch);
      worker.terminate();
    };
    // the clip may be released while converting: tell the worker to stop, then drop it
    const watch = setInterval(() => {
      if (!finished && !isLive()) {
        worker.postMessage('cancel');
        end();
        resolve(null);
      }
    }, 100);
    const onPage = () => transmuxToMp4(blob, probe, level, span, isLive, onProgress);
    worker.onmessage = (e: MessageEvent<{ progress?: number; done?: ConvertedPieces | null; error?: string }>) => {
      if (e.data.progress !== undefined) onProgress(e.data.progress);
      else if (e.data.error !== undefined) {
        end();
        // a read that failed in the worker is tried once more here before giving up
        onPage().then(resolve, () => reject(new Error(e.data.error)));
      } else if ('done' in e.data) {
        end();
        const r = e.data.done;
        resolve(r ? { mp4: new Blob(r.pieces as BlobPart[], { type: 'video/mp4' }), dropped: r.dropped, total: r.total, gps: r.gps } : null);
      }
    };
    worker.onerror = () => {
      if (finished) return;
      end();
      // the worker itself failed to start or crashed: do it here instead
      onPage().then(resolve, reject);
    };
    worker.postMessage({ blob, probe, level, span });
  });
}
