import type {
  BinarySource,
  StoredFile,
} from "@weblink/platform";
import { RangeFile } from "@weblink/platform";
const nativeSources = new Map<
  string,
  { source: WeakRef<StoredFile>; users: number }
>();

export function namedFile(
  file: StoredFile,
  name: string,
  type = file.type,
  lastModified = file.lastModified,
): StoredFile {
  return file instanceof Blob
    ? new File([file], name, { type, lastModified })
    : new RangeFile(
        name,
        file.size,
        type,
        lastModified,
        (offset, length) =>
          file.slice(offset, offset + length).arrayBuffer(),
        file.url,
      );
}

/** Native and Blob URLs are immediate; paged storage is streamed into a preview Blob. */
export function fileObjectUrl(
  file: StoredFile,
  signal?: AbortSignal,
): string | Promise<string> {
  signal?.throwIfAborted();
  if (file instanceof Blob)
    return URL.createObjectURL(file);
  if (file.url) {
    const current = nativeSources.get(file.url);
    nativeSources.set(file.url, {
      source: new WeakRef(file),
      users: (current?.users ?? 0) + 1,
    });
    return file.url;
  }
  return materializeBlob(file, signal).then((blob) => {
    signal?.throwIfAborted();
    return URL.createObjectURL(blob);
  });
}
export function revokeFileUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  else {
    const current = nativeSources.get(url);
    if (current && --current.users <= 0)
      nativeSources.delete(url);
  }
}
export function sourceForFileUrl(
  url: string,
): StoredFile | undefined {
  return nativeSources.get(url)?.source.deref();
}
export async function materializeFile(
  file: StoredFile,
): Promise<File> {
  if (file instanceof File) return file;
  return new File(
    [await new Response(file.stream()).blob()],
    file.name,
    { type: file.type, lastModified: file.lastModified },
  );
}
export async function materializeBlob(
  file: BinarySource,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  if (file instanceof Blob) return file;
  // Keep reads bounded; do not allocate a file-sized ArrayBuffer in JavaScript.
  // The browser owns the resulting Blob until the preview URL is released.
  const stream = signal
    ? file.stream().pipeThrough(new TransformStream(), {
        signal,
      })
    : file.stream();
  return new Response(stream, {
    headers: { "Content-Type": file.type },
  }).blob();
}
