import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { File as NodeFile } from "node:buffer";
import type {
  ContentRecord,
  FileLibraryRepository,
  FileReference,
} from "@/libs/domain/file-library";
import type { ChunkCache } from "@/libs/domain/file";
import { FileLibraryService } from "@/libs/application/file-library-service";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import { fakeCache } from "../support/file-transfer";

class MemoryLibrary implements FileLibraryRepository {
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
function setup() {
  const repository = new MemoryLibrary();
  const raw = new Map<
    string,
    ReturnType<typeof fakeCache>
  >();
  const caches = new Map<string, ChunkCache>();
  const storage = async (id: string) => {
    if (!raw.has(id)) raw.set(id, fakeCache(id));
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
beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(() => vi.unstubAllGlobals());

describe("shared file library", () => {
  it("imports equal bytes once, retains aliases, and distinguishes same-sized different content", async () => {
    const f = setup();
    const first = await f.library.importFile(
      new File(["one"], "a.txt", { lastModified: 1 }),
    );
    const duplicate = await f.library.importFile(
      new File(["one"], "b.txt", { lastModified: 2 }),
    );
    expect(duplicate.reused).toBe(true);
    expect(duplicate.cache.id).toBe(first.cache.id);
    expect(
      (await duplicate.cache.getInfo())?.aliases,
    ).toContain("b.txt");
    expect(f.raw.size).toBe(1);
    expect(
      [...f.raw.values()][0].setInfo,
    ).toHaveBeenCalledOnce();
    await f.library.importFile(
      new File(["two"], "a.txt", { lastModified: 1 }),
    );
    expect(f.raw.size).toBe(2);
  });
  it("creates independent room/private references without rehashing library selections", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["abcdef"], "source.txt"),
    );
    const source = {
      kind: "library" as const,
      localFileId: imported.cache.id,
    };
    const room = await f.library.prepare(source, {
      id: "room-file",
      roomAttachment: true,
      roomOfferId: "room-offer",
      from: "alice",
      chunkSize: 2,
      fileName: "room.txt",
    });
    const direct = await f.library.prepare(source, {
      id: "direct-file",
      chunkSize: 4,
      fileName: "private.txt",
    });
    expect(f.hash).toHaveBeenCalledOnce();
    expect(f.raw.size).toBe(1);
    expect((await room.getFile())?.name).toBe("room.txt");
    expect(
      new TextDecoder().decode((await room.getChunk(1))!),
    ).toBe("cd");
    expect(
      new TextDecoder().decode((await direct.getChunk(1))!),
    ).toBe("ef");
    expect(
      (await direct.getInfo())?.roomAttachment,
    ).toBeUndefined();
    await direct.cleanup();
    expect((await room.getFile())?.size).toBe(6);
    expect((await imported.cache.getFile())?.size).toBe(6);
  });
  it("reuses verified content for a new received offer and invalidates all aliases on explicit removal", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["content"], "local.txt"),
    );
    const info = (await imported.cache.getInfo())!;
    const received = await f.library.reuse(
      info.fingerprint!,
      {
        id: "remote-id",
        fileName: "remote.txt",
        fileSize: 7,
        chunkSize: 1024,
        from: "peer",
      },
    );
    expect((await received?.getFile())?.name).toBe(
      "remote.txt",
    );
    expect(f.raw.size).toBe(1);
    await f.library.removeFile(imported.cache.id);
    expect(await received?.getFile()).toBeNull();
    expect(f.repository.blobs.size).toBe(0);
    expect(f.repository.refs.size).toBe(0);
  });
  it("serializes simultaneous imports and never publishes a failed write", async () => {
    const f = setup();
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        f.library.importFile(
          new File(["same"], `${i}.txt`),
        ),
      ),
    );
    expect(
      new Set(results.map((item) => item.cache.id)).size,
    ).toBe(1);
    expect(f.raw.size).toBe(1);
    const broken = setup();
    const storage = broken.storage;
    const library = new FileLibraryService({
      repository: broken.repository,
      fingerprint: (file, options) =>
        fingerprintBlob(
          file,
          options?.onProgress,
          options?.signal,
        ),
      storage: async (id) => {
        const cache = await storage(id);
        cache.setInfo.mockRejectedValue(
          new DOMException("Full", "QuotaExceededError"),
        );
        return cache;
      },
      getCache: () => null,
      publish: vi.fn(),
    });
    await expect(
      library.importFile(new File(["x"], "file")),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(broken.repository.blobs.size).toBe(0);
    expect(broken.repository.refs.size).toBe(0);
  });
  it("rejects corrupt received bytes before adding them to the content index", async () => {
    const f = setup();
    const cache = fakeCache("incoming");
    await cache.setInfo({
      fileName: "wrong",
      fileSize: 3,
      file: new File(["bad"], "wrong"),
      fingerprint: await fingerprintBlob(
        new File(["yes"], "right"),
      ),
    });
    await expect(
      f.library.verifyReceived(cache),
    ).rejects.toThrow("verification failed");
    expect(cache.cleanup).toHaveBeenCalledOnce();
    expect(f.repository.blobs.size).toBe(0);
  });
  it("retains old file IDs while indexing legacy duplicates without another binary write", async () => {
    const f = setup();
    const imported = await f.library.importFile(
      new File(["same"], "imported"),
    );
    const old = await f.storage("old-id");
    await old.setInfo({
      fileName: "old",
      fileSize: 4,
      chunkSize: 2,
      file: new File(["same"], "old"),
    });
    f.caches.set(old.id, old);
    const share = await f.library.prepare(
      { kind: "library", localFileId: old.id },
      { id: "new-id", chunkSize: 3 },
    );
    expect(
      (await f.repository.reference(old.id))?.contentKey,
    ).toBe((await imported.cache.getInfo())?.contentKey);
    expect((await share.getFile())?.name).toBe("old");
    expect(f.raw.size).toBe(2);
    expect(
      f.raw.get("old-id")?.setInfo,
    ).toHaveBeenCalledOnce();
  });
  it("treats an index whose bytes disappeared as a miss", async () => {
    const f = setup();
    const result = await f.library.importFile(
      new File(["same"], "file"),
    );
    const info = (await result.cache.getInfo())!;
    [...f.raw.values()][0].getInfo.mockRejectedValue(
      new Error("Storage missing"),
    );
    expect(
      await f.library.reuse(info.fingerprint!, {
        id: "remote",
        fileName: "remote",
        fileSize: 4,
      }),
    ).toBeNull();
    expect(f.repository.blobs.size).toBe(0);
    expect(f.repository.refs.size).toBe(0);
  });
  it("rolls back an alias if cancellation arrives during publication", async () => {
    const f = setup(),
      controller = new AbortController();
    const library = new FileLibraryService({
      repository: f.repository,
      fingerprint: (file) => fingerprintBlob(file),
      storage: f.storage,
      getCache: () => null,
      publish: async () => {
        controller.abort();
      },
    });
    await expect(
      library.importFile(new File(["data"], "file"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.repository.refs.size).toBe(0);
    expect(f.repository.blobs.size).toBe(0);
  });
  it("rejects a reused attachment ID with different room authorization or metadata", async () => {
    const f = setup();
    const local = await f.library.importFile(
      new File(["data"], "file"),
    );
    const fingerprint = (await local.cache.getInfo())!
      .fingerprint!;
    const info = {
      id: "room",
      fileName: "file",
      fileSize: 4,
      roomAttachment: true,
      roomOfferId: "offer-a",
      from: "alice",
      chunkSize: 2,
    };
    await f.library.reuse(fingerprint, info);
    await expect(
      f.library.reuse(fingerprint, {
        ...info,
        roomOfferId: "offer-b",
      }),
    ).rejects.toThrow("identity conflict");
    await expect(
      f.library.reuse(fingerprint, {
        ...info,
        chunkSize: 4,
      }),
    ).rejects.toThrow("identity conflict");
  });
});
