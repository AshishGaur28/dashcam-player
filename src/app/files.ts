/** Only what the player can use; everything else on an SD card (Event/, DATA/, dot-files) is ignored silently. */
export const wanted = (f: File) => !f.name.startsWith('.') && /\.(ts|mp4|gpx)$/i.test(f.name);

const key = (f: File) => `${f.name}|${f.size}`;

/** Adding is cumulative: the same file picked twice is kept once. */
export function mergeFiles(prev: File[], next: File[]): File[] {
  const m = new Map(prev.map((f) => [key(f), f]));
  for (const f of next) m.set(key(f), f);
  return [...m.values()];
}

/**
 * Files and folders from a drag-and-drop. The entries must be taken synchronously, before any await.
 * Only files the player can use are opened (the rest of an SD card is skipped by name), and folders are read in parallel.
 */
export async function filesFromDrop(dt: DataTransfer, onCount?: (found: number) => void): Promise<File[]> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return Array.from(dt.files);
  const out: File[] = [];
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.name.startsWith('.')) return;
    if (e.isFile) {
      if (!/\.(ts|mp4|gpx)$/i.test(e.name)) return;
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)));
      onCount?.(out.length);
    } else {
      const r = (e as FileSystemDirectoryEntry).createReader();
      const kids: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));
        if (!batch.length) break;
        kids.push(...batch);
      }
      await Promise.all(kids.map(walk));
    }
  };
  await Promise.all(entries.map(walk));
  return out;
}
