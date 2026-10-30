import type { Loaded } from '../app/loadTrip';

export function FilesPanel({ loaded, count, onFiles, onFolder, onClear }: { loaded: Loaded; count: number; onFiles: () => void; onFolder: () => void; onClear: () => void }) {
  const e = loaded.pair.entries;
  const mp4 = e.filter((x) => /\.mp4$/i.test(x.front?.name ?? x.rear?.name ?? '')).length;
  return (
    <div className="files">
      <div className="files-actions">
        <button onClick={onFiles}>＋ Add files</button>
        <button onClick={onFolder}>＋ Add folder</button>
        <button className="danger" onClick={onClear}>Clear all</button>
      </div>
      <p className="muted">
        {count} file(s) added · {e.length} clips ({e.filter((x) => x.front).length} front, {e.filter((x) => x.rear).length} rear
        {mp4 ? `, ${mp4} as MP4` : ''}) · {e.filter((x) => x.gpx).length} with GPX
        {loaded.pair.looseGpx.length ? ` · ${loaded.pair.looseGpx.length} loose GPX` : ''}
      </p>
      <p className="muted">Adding more files merges them into the same trip, so you can add the rear cameras, a GPX or more clips at any time. The playing position is kept.</p>
      {loaded.warnings.length > 0 && (
        <details>
          <summary>{loaded.warnings.length} warning(s)</summary>
          <ul>
            {loaded.warnings.slice(0, 100).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
