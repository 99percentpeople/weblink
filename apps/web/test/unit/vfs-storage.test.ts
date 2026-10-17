// @vitest-environment node
import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FileStorageService } from "@/libs/application/file-storage-service";
import {
  VfsDatabase,
  type StoredVfsFile,
} from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import { DirectoryVolume } from "@/libs/infrastructure/vfs/directory-volume";
import { VfsChunkCache } from "@/libs/infrastructure/vfs/chunk-cache";
import { legacyDatabase } from "../helpers/legacy-indexeddb";
import { vfsPath } from "@/libs/domain/vfs";
import {
  RangeFile,
  type NativeFileSystem,
  type VfsVolume,
} from "@weblink/platform";

const resources: { dispose(): void }[] = [];
const databases: VfsDatabase[] = [];
beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(async () => {
  resources
    .splice(0)
    .forEach((resource) => resource.dispose());
  await Promise.all(
    databases.splice(0).map((database) => database.close()),
  );
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function database() {
  const db = new VfsDatabase(
    `vfs-test-${crypto.randomUUID()}`,
  );
  databases.push(db);
  return db;
}
async function fixture(native?: NativeFileSystem) {
  const db = database();
  const storage = new FileStorageService(native, db);
  resources.push(storage);
  await storage.initialize();
  const cache = await storage.createCache(
    `file-${crypto.randomUUID()}`,
    { memoryChunks: 4, isRetained: () => false },
  );
  resources.push({ dispose: () => cache.dispose?.() });
  await cache.initialize();
  await cache.setInfo({
    fileName: "test.bin",
    fileSize: 10,
    chunkSize: 4,
  });
  const record = (await db.get<StoredVfsFile>(
    "files",
    cache.id,
  )) ?? {
    id: cache.id,
    mountId: storage.defaultMountId,
    path: "test.bin.part",
    info: null,
    chunks: {},
    complete: false,
  };
  const volume = await storage.getVolume(record.mountId);
  return { db, storage, cache, record, volume };
}
const bytes = (...values: number[]) =>
  new Uint8Array(values).buffer;

describe("VFS checkpoints and legacy storage", () => {
  it("keeps a retained cache's missing state and makes release idempotent after external metadata deletion", async () => {
    const f = await fixture();
    const retained = new VfsChunkCache(
      f.cache.id,
      f.db,
      (id) => f.storage.getVolume(id),
      () => true,
    );
    resources.push(retained);
    await retained.initialize();
    await f.storage.removeSource(f.cache.id);
    for (let pass = 0; pass < 2; pass++) {
      expect(await retained.getInfo()).toMatchObject({
        storageMountId: "indexeddb",
        storageMissing: true,
        isComplete: false,
        capabilities: { save: "download", reveal: false },
      });
      expect((await retained.storageInfo())?.mountId).toBe(
        "indexeddb",
      );
    }
    await expect(
      f.cache.cleanup(),
    ).resolves.toBeUndefined();
    await expect(
      f.cache.cleanup(),
    ).resolves.toBeUndefined();
    await expect(
      retained.cleanup({ deleteSource: true }),
    ).resolves.toBeUndefined();
    expect(await retained.getInfo()).toBeNull();
    expect(await f.db.all("files")).toEqual([]);
    expect(await f.db.all("checkpoints")).toEqual([]);
    expect(await f.db.all("pages")).toEqual([]);
  });

  it("reports IndexedDB import progress only after payload bytes are written", async () => {
    const f = await fixture();
    const file = new File(["0123456789"], "test.bin");
    const onProgress = vi.fn();
    await f.cache.setInfo(
      {
        fileName: file.name,
        fileSize: file.size,
        chunkSize: 4,
        file,
      },
      undefined,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({
      phase: "writing",
      bytes: file.size,
    });
    expect(
      await f.volume.read(f.record.path, 0, file.size),
    ).toEqual(await file.arrayBuffer());
    expect(await f.cache.isTransferComplete()).toBe(true);
  });

  it("snapshots mutable metadata and bytes before queued storage work", async () => {
    const f = await fixture();
    const info = {
      fileName: "test.bin",
      fileSize: 10,
      chunkSize: 4,
      aliases: ["original"],
    };
    const setting = f.cache.setInfo(info);
    info.aliases[0] = "changed";
    await setting;
    expect((await f.cache.getInfo())?.aliases).toEqual([
      "original",
    ]);
    const buffer = new Uint8Array([1, 2, 3, 4]);
    const writing = f.cache.storeChunk(0, buffer.buffer);
    buffer.fill(99);
    await writing;
    expect([
      ...new Uint8Array((await f.cache.getChunk(0))!),
    ]).toEqual([1, 2, 3, 4]);
  });
  it("preallocates logical length without treating holes as received data; resumes exact ranges", async () => {
    const f = await fixture();
    expect((await f.volume.stat(f.record.path))?.size).toBe(
      10,
    );
    expect(await f.cache.isTransferComplete()).toBe(false);
    expect(await f.cache.getReqRanges()).toEqual([[0, 2]]);
    await f.cache.storeChunk(2, bytes(9, 10));
    await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
    await f.cache.storeChunk(0, bytes(99, 99, 99, 99));
    await f.cache.flush();
    expect(await f.cache.calcCachedBytes()).toBe(6);
    expect(await f.cache.getReqRanges()).toEqual([1]);
    const resumed = new VfsChunkCache(
      f.cache.id,
      f.db,
      (id) => f.storage.getVolume(id),
    );
    resources.push(resumed);
    await resumed.initialize();
    expect(await resumed.getReqRanges()).toEqual([1]);
    await resumed.storeChunk(1, bytes(5, 6, 7, 8));
    expect([
      ...new Uint8Array(
        await (await resumed.getFile())!.arrayBuffer(),
      ),
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await resumed.getReqRanges()).toEqual([]);
    await expect(
      resumed.storeChunk(3, bytes(1, 2)),
    ).rejects.toThrow();
  });
  it("does not checkpoint rejected volume writes and retries their bytes", async () => {
    const f = await fixture();
    const updates = vi.fn();
    f.cache.addEventListener("update", ({ detail }) =>
      updates(detail),
    );
    await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
    expect(updates).not.toHaveBeenCalled();
    vi.spyOn(f.volume, "commit").mockRejectedValueOnce(
      new Error("Disk full"),
    );
    await expect(f.cache.flush()).rejects.toThrow(
      "Disk full",
    );
    expect((await f.db.file(f.cache.id))!.chunks).toEqual(
      {},
    );
    expect(updates).not.toHaveBeenCalled();
    await f.cache.flush();
    expect(await f.cache.getCachedKeys()).toEqual([0]);
    expect(updates).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cachedBytes: 4,
        chunkCount: 1,
      }),
    );
  });
  it("combines concurrent writers' committed ranges without losing checkpoints", async () => {
    const f = await fixture();
    const second = new VfsChunkCache(
      f.cache.id,
      f.db,
      (id) => f.storage.getVolume(id),
    );
    resources.push(second);
    await second.initialize();
    await Promise.all([
      f.cache.storeChunk(0, bytes(1, 2, 3, 4)),
      second.storeChunk(1, bytes(5, 6, 7, 8)),
    ]);
    await Promise.all([f.cache.flush(), second.flush()]);
    expect(await f.cache.getCachedKeys()).toEqual([0, 1]);
    await f.cache.storeChunk(2, bytes(9, 10));
    await f.cache.flush();
    expect(await second.getReqRanges()).toEqual([]);
    expect([
      ...new Uint8Array(
        await (await second.getFile())!.arrayBuffer(),
      ),
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Checkpoints remain independent rows; the small metadata record contains no growing bitmap.
    expect(
      (await f.db.get<StoredVfsFile>("files", f.cache.id))
        ?.chunks,
    ).toBeUndefined();
    expect(await f.db.all("checkpoints")).toHaveLength(3);
  });
  it("retries failed preallocation at its original path and handles empty files", async () => {
    const f = await fixture();
    const cache = await f.storage.createCache(
      "empty-file",
      { memoryChunks: 4, isRetained: () => false },
    );
    resources.push({ dispose: () => cache.dispose?.() });
    vi.spyOn(f.volume, "commit").mockRejectedValueOnce(
      new Error("Directory offline"),
    );
    const info = {
      fileName: "empty.bin",
      fileSize: 0,
      chunkSize: 4,
    };
    await expect(cache.setInfo(info)).rejects.toThrow(
      "Directory offline",
    );
    const failed = await f.db.file(cache.id);
    expect(failed?.revision).toBeUndefined();
    await cache.setInfo(info);
    expect((await f.db.file(cache.id))?.path).toBe(
      failed?.path,
    );
    expect((await cache.getFile())?.size).toBe(0);
    expect(await cache.getReqRanges()).toEqual([]);
  });
  it("does not overwrite content completed by another cache while chunks were pending", async () => {
    const f = await fixture();
    await f.cache.storeChunk(0, bytes(99, 99, 99, 99));
    const second = new VfsChunkCache(
      f.cache.id,
      f.db,
      (id) => f.storage.getVolume(id),
    );
    resources.push(second);
    await second.setInfo({
      fileName: "test.bin",
      fileSize: 10,
      chunkSize: 4,
      file: new File(
        [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)],
        "test.bin",
      ),
    });
    await f.cache.flush();
    expect([
      ...new Uint8Array(
        await (await f.cache.getFile())!.arrayBuffer(),
      ),
    ]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("rejects a completed file changed between validation and opening", async () => {
    const f = await fixture();
    await f.cache.setInfo({
      fileName: "test.bin",
      fileSize: 10,
      chunkSize: 4,
      file: new File(
        [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)],
        "test.bin",
      ),
    });
    const open = f.volume.file.bind(f.volume);
    vi.spyOn(f.volume, "file").mockImplementationOnce(
      async (path, metadata) => {
        const file = await open(path, metadata);
        await f.volume.commit(path, [
          { offset: 0, data: new Uint8Array([99]) },
        ]);
        return file;
      },
    );
    const second = new VfsChunkCache(
      f.cache.id,
      f.db,
      (id) => f.storage.getVolume(id),
    );
    resources.push(second);
    await expect(second.getFile()).rejects.toThrow(
      "File changed while opening",
    );
  });
  it("recovers a crash after byte commit but before checkpoint commit", async () => {
    const f = await fixture();
    await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
    await f.cache.flush();
    await f.cache.storeChunk(1, bytes(5, 6, 7, 8));
    const put = vi.spyOn(f.db, "checkpoint");
    put.mockRejectedValueOnce(
      new Error("Checkpoint failed"),
    );
    await expect(f.cache.flush()).rejects.toThrow(
      "Checkpoint failed",
    );
    f.cache.dispose?.();
    const resumed = new VfsChunkCache(
      f.cache.id,
      f.db,
      (id) => f.storage.getVolume(id),
    );
    resources.push(resumed);
    await resumed.initialize();
    expect(await resumed.getCachedKeys()).toEqual([0]);
    expect(await resumed.getReqRanges()).toEqual([[1, 2]]);
    expect([
      ...new Uint8Array((await resumed.getChunk(0))!),
    ]).toEqual([1, 2, 3, 4]);
  });
  it("invalidates externally modified partial chunks while retaining valid chunks", async () => {
    const f = await fixture();
    await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
    await f.cache.storeChunk(2, bytes(9, 10));
    await f.cache.flush();
    await f.volume.commit(f.record.path, [
      { offset: 0, data: new Uint8Array([4, 3, 2, 1]) },
    ]);
    expect(await f.cache.getCachedKeys()).toEqual([2]);
    expect(await f.cache.getReqRanges()).toEqual([[0, 1]]);
  });
  it("keeps metadata when a completed file disappears or changes", async () => {
    const f = await fixture();
    await f.cache.setInfo({
      fileName: "test.bin",
      fileSize: 10,
      chunkSize: 4,
      file: new File(
        [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)],
        "test.bin",
      ),
    });
    await f.volume.commit(f.record.path, [
      { offset: 0, data: new Uint8Array([99]) },
    ]);
    expect(
      (await f.cache.getInfo())?.storageUnavailable,
    ).toMatch(/changed/);
    await expect(f.cache.getFile()).rejects.toThrow(
      /changed/,
    );
    expect(
      await f.db.get("files", f.cache.id),
    ).toBeDefined();
    await f.volume.remove(f.record.path);
    expect(
      (await f.cache.getInfo())?.storageUnavailable,
    ).toMatch(/missing/);
    expect(
      await f.db.get("files", f.cache.id),
    ).toBeDefined();
  });
  it("pins each file to its original volume when the default changes", async () => {
    const backing = new IndexedDbVolume(database());
    const native: VfsVolume = Object.assign(
      Object.create(backing),
      {
        id: "native-default",
        name: "Disk",
        kind: "native",
      },
    );
    const openDirectory = vi.fn(async (_id: string) => {});
    const f = await fixture({
      volumes: async () => [native],
      pickDirectory: async () => null,
      openDirectory,
    });
    expect(f.storage.defaultMountId).toBe("native-default");
    expect(f.record.mountId).toBe("native-default");
    expect(f.storage.mounts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "native-default",
          canOpen: true,
        }),
        expect.objectContaining({
          id: "indexeddb",
          canOpen: false,
        }),
      ]),
    );
    await f.storage.openDirectory("native-default");
    expect(openDirectory).toHaveBeenCalledWith(
      "native-default",
    );
    await expect(
      f.storage.openDirectory("indexeddb"),
    ).rejects.toThrow("unavailable");
    expect(openDirectory).toHaveBeenCalledOnce();
    await f.storage.setDefault("indexeddb");
    const next = await f.storage.createCache("next-file", {
      memoryChunks: 4,
      isRetained: () => false,
    });
    resources.push({ dispose: () => next.dispose?.() });
    expect(
      (await f.db.get<StoredVfsFile>("files", next.id))
        ?.mountId,
    ).toBe("indexeddb");
    expect(
      await f.db.get("files", f.cache.id),
    ).toBeUndefined();
    await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
    await f.cache.flush();
    expect([
      ...new Uint8Array(
        await native.read(f.record.path, 0, 4),
      ),
    ]).toEqual([1, 2, 3, 4]);
  });
  it("discovers legacy chunk databases and retains their partial bytes", async () => {
    const id = `legacy-${crypto.randomUUID()}`;
    (
      await legacyDatabase(
        id,
        {
          fileName: "old.bin",
          fileSize: 6,
          chunkSize: 4,
        },
        [{ chunkIndex: 0, data: bytes(1, 2, 3, 4) }],
      )
    ).close();
    const storage = new FileStorageService(
      undefined,
      database(),
    );
    resources.push(storage);
    await storage.initialize();
    expect(await storage.list()).toContain(id);
    const reopened = await storage.createCache(id, {
      memoryChunks: 4,
      isRetained: () => false,
    });
    expect(reopened).toBeInstanceOf(VfsChunkCache);
    await reopened.initialize();
    expect(await reopened.getReqRanges()).toEqual([1]);
    expect([
      ...new Uint8Array((await reopened.getChunk(0))!),
    ]).toEqual([1, 2, 3, 4]);
    await reopened.cleanup();
  });
  it("preserves sparse pages, truncation, and transactions across page boundaries", async () => {
    const volume = new IndexedDbVolume(database());
    await volume.commit("folder/file", [], 600_000);
    await volume.commit("folder/file", [
      { offset: 262_143, data: new Uint8Array([1, 2, 3]) },
    ]);
    expect([
      ...new Uint8Array(
        await volume.read("folder/file", 262_142, 5),
      ),
    ]).toEqual([0, 1, 2, 3, 0]);
    await volume.commit("folder/file", [], 262_144);
    await volume.commit("folder/file", [], 600_000);
    expect([
      ...new Uint8Array(
        await volume.read("folder/file", 262_142, 5),
      ),
    ]).toEqual([0, 1, 0, 0, 0]);
    expect((await volume.list(""))[0].kind).toBe(
      "directory",
    );
    expect((await volume.list("folder"))[0].name).toBe(
      "file",
    );
  });
  it("reads native-like files in bounded ranges and slices relative to their parent", async () => {
    const reads: number[] = [];
    const file = new RangeFile(
      "large.bin",
      3 * 1024 * 1024,
      "",
      0,
      async (offset, length) => {
        reads.push(length);
        return new Uint8Array(length).fill(offset % 251)
          .buffer;
      },
    );
    const slice = file.slice(20, 40).slice(2, 5);
    expect([
      ...new Uint8Array(await slice.arrayBuffer()),
    ]).toEqual([22, 22, 22]);
    await new Response(file.stream()).arrayBuffer();
    expect(Math.max(...reads)).toBeLessThanOrEqual(
      1024 * 1024,
    );
    for (const path of [
      "../x",
      "/x",
      "a\\b",
      "file:stream",
      "a//b",
    ])
      expect(() => vfsPath(path)).toThrow();
  });
});

it("detects a deleted browser directory even while its permission is still granted", async () => {
  const next = vi
    .fn()
    .mockRejectedValue(
      new DOMException(
        "Directory deleted",
        "NotFoundError",
      ),
    );
  const close = vi.fn().mockResolvedValue({ done: true });
  const handle = {
    queryPermission: vi.fn().mockResolvedValue("granted"),
    entries: () => ({ next, return: close }),
  } as unknown as FileSystemDirectoryHandle;
  const volume = new DirectoryVolume(
    "directory-test",
    "Files",
    handle,
  );
  expect(await volume.stat("")).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  next.mockResolvedValue({ done: true, value: undefined });
  expect(await volume.stat("")).toMatchObject({
    kind: "directory",
  });
});

it("invalidates directory state on focus even if the poll snapshot has not changed", async () => {
  const window = new EventTarget();
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", { visibilityState: "visible" });
  const volume = new DirectoryVolume(
    "directory-focus",
    "Files",
    {} as FileSystemDirectoryHandle,
  );
  vi.spyOn(volume, "list").mockResolvedValue([]);
  const changed = vi.fn();
  const stop = await volume.watch(changed);
  try {
    window.dispatchEvent(new Event("focus"));
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});
