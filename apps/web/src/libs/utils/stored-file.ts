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

export function fileObjectUrl(file: StoredFile): string {
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
  throw new Error("File preview is unavailable");
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
): Promise<Blob> {
  return file instanceof Blob
    ? file
    : new Response(file.stream()).blob();
}
