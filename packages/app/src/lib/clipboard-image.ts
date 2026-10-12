/**
 * Collect image `File`s from a paste or drop, preferring the browser's FileList:
 *
 *  - `data.files` (a FileList) — the reliable path for an image **file copied
 *    from the OS file manager** (Windows Explorer / macOS Finder). There the
 *    matching `items` entry frequently has a blank `.type`, so an items-only
 *    check misses it entirely. This is the same FileList an `<input type="file">`
 *    produces, so paste/drop end up behaving exactly like the file picker.
 *  - `data.items` — needed for **screenshots** and images copied from another
 *    app, where the bitmap is exposed as an item rather than landing in `files`.
 *
 * `getAsFile()` is called synchronously here; callers must invoke this before any
 * `await`, since the underlying clipboard/drag data is neutered afterwards.
 * Use items only when the FileList has no images. Browsers can expose the same
 * bitmap in both places as separate File objects with different timestamps;
 * merging the sources would attach that image twice.
 *
 * Works for both `ClipboardEvent.clipboardData` and `DragEvent.dataTransfer`
 * (both are `DataTransfer`).
 */
export function getImageFilesFromTransfer(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];

  const files = Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (files.length) return files;

  return Array.from(data.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null && file.type.startsWith("image/"));
}
