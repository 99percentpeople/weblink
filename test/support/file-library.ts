import { vi } from "vitest";
import type {
  ContentRecord,
  FileLibraryRepository,
  FileReference,
} from "@/libs/domain/file-library";
import type { ChunkCache } from "@/libs/domain/file";
import { FileLibraryService } from "@/libs/application/file-library-service";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import { fakeCache } from "./file-transfer";
export class MemoryLibrary implements FileLibraryRepository {
  blobs = new Map<string, ContentRecord>();
  refs = new Map<string, FileReference>();
  async contents() {
    return [...this.blobs.values()].map((value) =>
      structuredClone(value),
    );
  }
  async content(key: string) {
    return structuredClone(this.blobs.get(key));
  }
  async claim(record: ContentRecord) {
    if (this.blobs.has(record.key)) return false;
    this.blobs.set(record.key, structuredClone(record));
    return true;
  }
  async commit(record: ContentRecord, ref: FileReference) {
    this.blobs.set(record.key, {
      ...record,
      state: "ready",
    });
    this.refs.set(ref.id, structuredClone(ref));
  }
  async references(key?: string) {
    return [...this.refs.values()]
      .filter((ref) => !key || ref.contentKey === key)
      .map((value) => structuredClone(value));
  }
  async reference(id: string) {
    return structuredClone(this.refs.get(id));
  }
  async putReference(ref: FileReference) {
    if (this.blobs.get(ref.contentKey)?.state !== "ready")
      throw new Error("Missing content");
    this.refs.set(ref.id, structuredClone(ref));
  }
  async removeReference(id: string) {
    this.refs.delete(id);
  }
  async removeContent(key: string) {
    this.blobs.delete(key);
    for (const [id, ref] of this.refs)
      if (ref.contentKey === key) this.refs.delete(id);
  }
}
export function setupLibrary() {
  const repository = new MemoryLibrary();
  const raw = new Map<
    string,
    ReturnType<typeof fakeCache>
  >();
  const caches = new Map<string, ChunkCache>();
  const storage = async (id: string) => {
    if (!raw.has(id)) {
      const cache = fakeCache(id);
      raw.set(id, cache);
      cache.addEventListener("cleanup", () => {
        if (raw.get(id) === cache) raw.delete(id);
        if (caches.get(id) === cache) caches.delete(id);
      });
    }
    return raw.get(id)!;
  };
  const hash = vi.fn((file: Blob) => fingerprintBlob(file));
  const library = new FileLibraryService({
    repository,
    fingerprint: hash,
    storage,
    getCache: (id) => caches.get(id) ?? null,
    publish: async (cache) => {
      caches.set(cache.id, cache);
      cache.addEventListener("cleanup", () => {
        if (caches.get(cache.id) === cache)
          caches.delete(cache.id);
      });
      await cache.initialize();
    },
  });
  return {
    library,
    repository,
    raw,
    caches,
    hash,
    storage,
  };
}
