// @vitest-environment node
import "fake-indexeddb/auto";
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { VfsVolume } from "@weblink/platform";
import { FileStorageService } from "@/libs/application/file-storage-service";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import {
  readPartialHeader,
  PARTIAL_CHUNK_BYTES,
  PARTIAL_SLOT_BYTES,
} from "@/libs/infrastructure/vfs/partial-file";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import { scanDirectory } from "@/libs/infrastructure/vfs/directory-index";

const resources: { dispose(): void }[] = [];
const databases: VfsDatabase[] = [];
beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(async () => {
  resources
    .splice(0)
    .forEach((resource) => resource.dispose());
  await Promise.all(
    databases.splice(0).map((db) => db.close()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function database() {
  const db = new VfsDatabase(crypto.randomUUID());
  databases.push(db);
  return db;
}
function service(volume: VfsVolume) {
  const storage = new FileStorageService(
    {
      volumes: async () => [volume],
      pickDirectory: async () => null,
      openDirectory: async () => {},
    },
    database(),
  );
  resources.push(storage);
  return storage;
}
async function fixture() {
  const backing = new IndexedDbVolume(database());
  const volume: VfsVolume = Object.assign(
    Object.create(backing),
    { id: "native-default", name: "Disk", kind: "native" },
  );
  const storage = service(volume);
  await storage.initialize();
  const cache = await storage.createCache("receive", {
    memoryChunks: 4,
    isRetained: () => false,
  });
  resources.push({ dispose: () => cache.dispose?.() });
  const info = {
    fileName: "file.bin",
    fileSize: 10,
    chunkSize: 4,
  };
  await cache.setInfo(info);
  const path = "file.bin.part";
  const finalPath = "file.bin";
  return { storage, volume, cache, path, finalPath, info };
}
const bytes = (...values: number[]) =>
  new Uint8Array(values).buffer;

it("preallocates a 643 MiB DLL as a resumable partial without treating its length as received data", async () => {
  const f = await fixture();
  const cache = await f.storage.createCache(
    "large-receive",
    {
      memoryChunks: 4,
      isRetained: () => false,
    },
  );
  resources.push({ dispose: () => cache.dispose?.() });
  const fileSize = 643 * 1024 * 1024;
  const chunkSize = 256 * 1024;
  await cache.setInfo({
    fileName: "cublasLt64_12.dll",
    fileSize,
    chunkSize,
  });
  expect(
    (await f.volume.stat("cublasLt64_12.dll.part"))!.size,
  ).toBeGreaterThan(fileSize);
  expect(
    await f.volume.stat("cublasLt64_12.dll"),
  ).toBeNull();
  expect(await cache.calcCachedBytes()).toBe(0);
  expect(await cache.getReqRanges()).toEqual([
    [0, fileSize / chunkSize - 1],
  ]);
  expect(await cache.getFile()).toBeNull();
  await cache.storeChunk(
    0,
    new Uint8Array(chunkSize).fill(42).buffer,
  );
  await cache.flush();
  const restored = await reopen(f.volume, "large-receive");
  expect(await restored.cache.calcCachedBytes()).toBe(
    chunkSize,
  );
  expect(await restored.cache.getReqRanges()).toEqual([
    [1, fileSize / chunkSize - 1],
  ]);
});
async function fill(
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
  await f.cache.storeChunk(1, bytes(5, 6, 7, 8));
  await f.cache.storeChunk(2, bytes(9, 10));
  await f.cache.flush();
}
async function reopen(volume: VfsVolume, id = "receive") {
  const storage = service(volume);
  await storage.initialize();
  const cache = await storage.createCache(id, {
    memoryChunks: 4,
    isRetained: () => false,
    existingOnly: true,
  });
  resources.push({ dispose: () => cache.dispose?.() });
  return { storage, cache };
}
it("recovers out-of-order zero-filled chunks from the file alone and removes its trailer on completion", async () => {
  const f = await fixture();
  expect((await f.cache.getInfo())?.storageKind).toBe(
    "native",
  );
  expect(await f.cache.storageLocation?.()).toEqual({
    kind: "native",
    mountId: "native-default",
    path: f.path,
  });
  expect(
    (await f.volume.stat(f.path))!.size,
  ).toBeGreaterThan(10);
  expect(await f.storage.database.all("files")).toEqual([]);
  expect(
    await f.storage.database.all("checkpoints"),
  ).toEqual([]);
  await f.cache.storeChunk(0, bytes(0, 0, 0, 0));
  await f.cache.storeChunk(2, bytes(9, 10));
  await f.cache.flush();
  const restored = await reopen(f.volume);
  expect(await restored.cache.getReqRanges()).toEqual([1]);
  expect(await restored.cache.calcCachedBytes()).toBe(6);
  await restored.cache.storeChunk(1, bytes(5, 6, 7, 8));
  const complete = await restored.cache.getFile();
  expect([
    ...new Uint8Array(await complete!.arrayBuffer()),
  ]).toEqual([0, 0, 0, 0, 5, 6, 7, 8, 9, 10]);
  expect(await f.volume.stat(f.path)).toBeNull();
  expect((await f.volume.stat(f.finalPath))!.size).toBe(10);
  expect(await restored.cache.storageLocation?.()).toEqual({
    kind: "native",
    mountId: "native-default",
    path: f.finalPath,
  });
  const completedId =
    await restored.cache.storageIdentity!();
  const again = await reopen(f.volume, completedId);
  expect(
    await (await again.cache.getFile())!.arrayBuffer(),
  ).toEqual(await complete!.arrayBuffer());
  expect(await again.storage.database.all("files")).toEqual(
    [],
  );
  expect(
    (await f.volume.list("")).map((entry) => entry.name),
  ).toEqual(["file.bin"]);
});
it("does not count payload writes whose in-file checkpoint failed", async () => {
  const f = await fixture();
  await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
  await f.cache.flush();
  const commit = f.volume.commit.bind(f.volume);
  vi.spyOn(f.volume, "commit").mockImplementation(
    async (path, writes, size) => {
      if (
        writes.some(
          (write) =>
            write.offset === 10 + PARTIAL_CHUNK_BYTES,
        )
      )
        throw new Error("Checkpoint interrupted");
      return commit(path, writes, size);
    },
  );
  await f.cache.storeChunk(1, bytes(5, 6, 7, 8));
  await expect(f.cache.flush()).rejects.toThrow(
    "Checkpoint interrupted",
  );
  f.cache.dispose?.();
  vi.restoreAllMocks();
  const restored = await reopen(f.volume);
  expect(await restored.cache.getReqRanges()).toEqual([
    [1, 2],
  ]);
  expect(await restored.cache.getChunk(0)).toEqual(
    bytes(1, 2, 3, 4),
  );
});

it("keeps original root files and reserves distinct names for concurrent uploads without an index", async () => {
  const f = await fixture();
  await f.cache.storeChunk(2, bytes(9, 10));
  await f.cache.flush();
  const caches = await Promise.all(
    ["second", "third"].map((id) =>
      f.storage.createCache(id, {
        memoryChunks: 4,
        isRetained: () => false,
      }),
    ),
  );
  resources.push(
    ...caches.map((cache) => ({
      dispose: () => cache.dispose?.(),
    })),
  );
  await Promise.all(
    caches.map((cache, index) =>
      cache.setInfo({
        fileName: "file.bin",
        fileSize: 4,
        chunkSize: 4,
        file: new File([bytes(index, 2, 3, 4)], "file.bin"),
      }),
    ),
  );
  expect(
    (await f.volume.list("")).map((entry) => entry.name),
  ).toEqual([
    "file (1).bin",
    "file (2).bin",
    "file.bin.part",
  ]);
  expect(
    await (await reopen(f.volume)).cache.getReqRanges(),
  ).toEqual([[0, 1]]);
  expect(await f.volume.read("file (1).bin", 0, 4)).toEqual(
    bytes(0, 2, 3, 4),
  );
  expect(await f.volume.read("file (2).bin", 0, 4)).toEqual(
    bytes(1, 2, 3, 4),
  );
  expect(await f.storage.database.all("files")).toEqual([]);
});
it("merges independent writers' checkpoints and finalizes a fully checkpointed file on reopen", async () => {
  const f = await fixture();
  const second = await reopen(f.volume);
  await Promise.all([
    f.cache.storeChunk(0, bytes(1, 2, 3, 4)),
    second.cache.storeChunk(2, bytes(9, 10)),
  ]);
  await Promise.all([
    f.cache.flush(),
    second.cache.flush(),
  ]);
  expect(await f.cache.getReqRanges()).toEqual([1]);
  await second.cache.storeChunk(1, bytes(5, 6, 7, 8));
  await second.cache.flush();
  expect(
    (await f.volume.stat(f.path))!.size,
  ).toBeGreaterThan(10);
  const restarted = await reopen(f.volume);
  const info = await restarted.cache.getInfo();
  expect(info?.isComplete).toBe(true);
  expect(await f.volume.stat(f.path)).toBeNull();
  expect((await f.volume.stat(f.finalPath))!.size).toBe(10);
  expect(await info!.file!.arrayBuffer()).toEqual(
    bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
  );
});
it("rechecks committed chunks when metadata is set before cache initialization", async () => {
  const f = await fixture();
  await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
  await f.cache.storeChunk(2, bytes(9, 10));
  await f.cache.flush();
  await f.volume.commit(f.path, [
    { offset: 0, data: new Uint8Array([99]) },
  ]);
  const restarted = await reopen(f.volume);
  await restarted.cache.setInfo(f.info);
  expect(await restarted.cache.getCachedKeys()).toEqual([
    2,
  ]);
});
it("follows a renamed partial file in the mounted root without writing an index", async () => {
  const f = await fixture();
  await f.cache.storeChunk(2, bytes(9, 10));
  await f.cache.flush();
  const size = (await f.volume.stat(f.path))!.size;
  const renamed = "renamed.bin.part";
  await f.volume.commit(
    renamed,
    [
      {
        offset: 0,
        data: new Uint8Array(
          await f.volume.read(f.path, 0, size),
        ),
      },
    ],
    size,
  );
  await f.volume.remove(f.path);
  expect(
    (await f.storage.synchronizeDirectories()).files,
  ).toEqual(["receive"]);
  expect(await f.cache.getReqRanges()).toEqual([[0, 1]]);
  await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
  await f.cache.storeChunk(1, bytes(5, 6, 7, 8));
  expect(
    await (await f.cache.getFile())!.arrayBuffer(),
  ).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
  expect(await f.volume.stat(renamed)).toBeNull();
  expect((await f.volume.stat("renamed.bin"))!.size).toBe(
    10,
  );
  expect(await f.storage.database.all("files")).toEqual([]);
});
it("rejects torn checkpoint slots and corrupted payload while preserving valid ranges", async () => {
  const f = await fixture();
  await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
  await f.cache.storeChunk(2, bytes(9, 10));
  await f.cache.flush();
  await f.volume.commit(f.path, [
    { offset: 0, data: new Uint8Array([99]) },
    {
      offset: 10 + PARTIAL_CHUNK_BYTES,
      data: new Uint8Array([0x43, 0x50, 0x4c, 0x57, 9]),
    },
  ]);
  const restored = await reopen(f.volume);
  expect(await restored.cache.getCachedKeys()).toEqual([2]);
  expect(await restored.cache.getReqRanges()).toEqual([
    [0, 1],
  ]);
});
it("discovers completed renamed files without reusing the stale path", async () => {
  const f = await fixture();
  await f.cache.setInfo({
    ...f.info,
    file: new File(
      [bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)],
      "file.bin",
    ),
  });
  const before = await f.cache.getFile();
  const revision = (await f.volume.stat(f.finalPath))!
    .revision;
  const renamed = "renamed.bin";
  await f.volume.commit(
    renamed,
    [
      {
        offset: 0,
        data: new Uint8Array(await before!.arrayBuffer()),
      },
    ],
    10,
  );
  await f.volume.remove(f.finalPath);
  const stat = f.volume.stat.bind(f.volume);
  const list = f.volume.list.bind(f.volume);
  vi.spyOn(f.volume, "stat").mockImplementation(
    async (path) => {
      const value = await stat(path);
      return path === renamed && value
        ? { ...value, revision }
        : value;
    },
  );
  vi.spyOn(f.volume, "list").mockImplementation(
    async (path) =>
      (await list(path)).map((entry) =>
        entry.name === "renamed.bin"
          ? { ...entry, revision }
          : entry,
      ),
  );
  const listing = await f.storage.synchronizeDirectories();
  expect(
    (await f.cache.getInfo())?.storageUnavailable,
  ).toBeTruthy();
  const renamedCache = await f.storage.createCache(
    listing.files[0],
    {
      memoryChunks: 4,
      isRetained: () => false,
      existingOnly: true,
    },
  );
  resources.push({
    dispose: () => renamedCache.dispose?.(),
  });
  expect((await renamedCache.getFile())?.name).toBe(
    "renamed.bin",
  );
});
it("uses the previous metadata slot after an interrupted metadata update", async () => {
  const f = await fixture();
  await f.cache.storeChunk(0, bytes(1, 2, 3, 4));
  await f.cache.flush();
  const header = await readPartialHeader(
    f.volume,
    f.path,
    (await f.volume.stat(f.path))!.size,
  );
  await f.cache.setInfo({
    ...f.info,
    aliases: ["new alias"],
  });
  const newest = await readPartialHeader(
    f.volume,
    f.path,
    (await f.volume.stat(f.path))!.size,
  );
  expect(newest.generation).toBeGreaterThan(
    header.generation,
  );
  await f.volume.commit(f.path, [
    {
      offset:
        newest.metadataOffset +
        (newest.generation % 2) * PARTIAL_SLOT_BYTES +
        8,
      data: new Uint8Array(32),
    },
  ]);
  const restored = await reopen(f.volume);
  expect(
    (await restored.cache.getInfo())?.aliases,
  ).toBeUndefined();
  expect(await restored.cache.getCachedKeys()).toEqual([0]);
});
it("retains the trailer when whole-file verification fails and handles empty files", async () => {
  const f = await fixture();
  const fingerprint = await fingerprintBlob(
    new Blob([bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)]),
  );
  await f.cache.setInfo({ ...f.info, fingerprint });
  for (let i = 0; i < 3; i++)
    await f.cache.storeChunk(
      i,
      i === 2 ? bytes(0, 0) : bytes(0, 0, 0, 0),
    );
  await expect(f.cache.getFile()).rejects.toThrow(
    /verification failed/,
  );
  expect(
    (await f.volume.stat(f.path))!.size,
  ).toBeGreaterThan(10);
  const empty = await f.storage.createCache("empty", {
    memoryChunks: 4,
    isRetained: () => false,
  });
  await empty.setInfo({
    fileName: "empty.txt",
    fileSize: 0,
    chunkSize: 4,
  });
  expect((await empty.getFile())?.size).toBe(0);
  expect((await f.volume.stat("empty.txt"))?.size).toBe(0);
});

it("keeps a final name created during reception and chooses another name on completion", async () => {
  const f = await fixture();
  expect(await f.volume.stat(f.finalPath)).toBeNull();
  expect((await f.cache.getInfo())?.file).toBeUndefined();
  await f.volume.commit(
    f.finalPath,
    [
      {
        offset: 0,
        data: new TextEncoder().encode("existing"),
      },
    ],
    8,
  );
  await fill(f);
  expect((await f.cache.getFile())?.name).toBe("file.bin");
  expect(
    new TextDecoder().decode(
      await f.volume.read(f.finalPath, 0, 8),
    ),
  ).toBe("existing");
  expect((await f.volume.stat("file (1).bin"))?.size).toBe(
    10,
  );
  expect(await f.volume.stat(f.path)).toBeNull();
});

it("retains all committed chunks if writing the final copy fails and resumes without an index", async () => {
  const f = await fixture();
  await fill(f);
  const commit = f.volume.commit.bind(f.volume);
  const writes = vi
    .spyOn(f.volume, "commit")
    .mockImplementation(async (path, changes, size) => {
      if (path === f.finalPath && changes.length)
        throw new Error("Copy interrupted");
      return commit(path, changes, size);
    });
  await expect(f.cache.getFile()).rejects.toThrow(
    "Copy interrupted",
  );
  expect(await f.volume.stat(f.finalPath)).toBeNull();
  expect(
    (await f.volume.stat(f.path))!.size,
  ).toBeGreaterThan(10);
  writes.mockRestore();
  const restarted = await reopen(f.volume);
  expect(await restarted.cache.getReqRanges()).toEqual([]);
  expect(
    await (await restarted.cache.getFile())!.arrayBuffer(),
  ).toEqual(bytes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
  expect(await f.volume.stat(f.path)).toBeNull();
});

it("recovers a committed copy after temporary cleanup fails, without duplicate rows or another copy", async () => {
  const f = await fixture();
  await fill(f);
  const remove = vi
    .spyOn(f.volume, "remove")
    .mockRejectedValueOnce(
      new Error("Cleanup interrupted"),
    );
  await expect(f.cache.getFile()).rejects.toThrow(
    "Cleanup interrupted",
  );
  remove.mockRestore();
  expect(
    (await f.volume.list("")).map((entry) => entry.name),
  ).toEqual([f.finalPath, f.path]);
  const listing = await scanDirectory(
    f.volume,
    new AbortController().signal,
  );
  expect(listing.map((entry) => entry.id)).toEqual([
    "receive",
  ]);
  const writes = vi.spyOn(f.volume, "commit");
  const restarted = await reopen(f.volume);
  expect((await restarted.cache.getFile())?.name).toBe(
    "file.bin",
  );
  expect(writes).not.toHaveBeenCalled();
  expect(
    (await f.volume.list("")).map((entry) => entry.name),
  ).toEqual([f.finalPath]);
});

it("recovers after moving to the final name but before removing its trailer", async () => {
  const f = await fixture();
  await fill(f);
  const commit = f.volume.commit.bind(f.volume);
  f.volume.move = vi.fn(
    async (source, target, revision) => {
      expect((await f.volume.stat(source))?.revision).toBe(
        revision,
      );
      const size = (await f.volume.stat(source))!.size;
      const stat = await commit(
        target,
        [
          {
            offset: 0,
            data: new Uint8Array(
              await f.volume.read(source, 0, size),
            ),
          },
        ],
        size,
      );
      await f.volume.remove(source);
      return stat;
    },
  );
  const writes = vi
    .spyOn(f.volume, "commit")
    .mockImplementation(async (path, changes, size) => {
      if (
        path === f.finalPath &&
        size === 10 &&
        !changes.length
      )
        throw new Error("Final truncate interrupted");
      return commit(path, changes, size);
    });
  await expect(f.cache.getFile()).rejects.toThrow(
    "Final truncate interrupted",
  );
  expect(await f.volume.stat(f.path)).toBeNull();
  expect(
    (await f.volume.stat(f.finalPath))!.size,
  ).toBeGreaterThan(10);
  writes.mockRestore();
  const restarted = await reopen(f.volume);
  expect((await restarted.cache.getFile())?.size).toBe(10);
  expect(f.volume.move).toHaveBeenCalledOnce();
  expect((await f.volume.stat(f.finalPath))?.size).toBe(10);
});
