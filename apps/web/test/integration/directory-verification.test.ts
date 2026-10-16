// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { FileCacheFactory } from "@/libs/application/cache-service";
import { FileStorageService } from "@/libs/application/file-storage-service";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { MemoryNativeVolume } from "../support/native-volume";

vi.mock("@/libs/platform/runtime", () => ({
  platform: {},
}));
vi.mock("@/libs/utils/download-file", () => ({
  downloadFile: vi.fn(),
}));
vi.mock("@/libs/state/app-state", async () => {
  const { createStore } = await import("solid-js/store");
  const [appState, setAppState] = createStore({
    options: {
      chunkSize: 256 * 1024,
      maxMomeryCacheSlices: 4,
      automaticDownload: false,
    },
    cache: {
      cacheInfo: {},
      caches: {},
      status: "loading",
      error: undefined,
    },
  });
  return { appState, setAppState };
});

const managers: FileCacheFactory[] = [];
const databases: VfsDatabase[] = [];
const resetState = () =>
  setAppState("cache", {
    cacheInfo: {},
    caches: {},
    status: "loading",
    error: undefined,
  });
beforeEach(() => {
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("indexedDB", new IDBFactory());
  resetState();
});
afterEach(async () => {
  managers
    .splice(0)
    .forEach((manager) => manager.dispose());
  await Promise.all(
    databases.splice(0).map((db) => db.close()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(volume = new MemoryNativeVolume()) {
  const db = new VfsDatabase(crypto.randomUUID());
  databases.push(db);
  const storage = new FileStorageService(
    {
      volumes: async () => [volume],
      pickDirectory: async () => null,
      openDirectory: async () => {},
    },
    db,
  );
  const manager = new FileCacheFactory(storage);
  managers.push(manager);
  await manager.initialize();
  return { volume, storage, manager };
}
async function receive(volume?: MemoryNativeVolume) {
  const f = await open(volume);
  const payload = new Uint8Array(8 * 1024 * 1024).fill(19);
  const fingerprint = await fingerprintBlob(
    new Blob([payload]),
  );
  const cache = await f.manager.createCache("received");
  const chunkSize = 256 * 1024;
  await cache.setInfo({
    fileName: "large.dll",
    fileSize: payload.length,
    chunkSize,
    fingerprint,
  });
  for (
    let offset = 0;
    offset < payload.length;
    offset += chunkSize
  )
    await cache.storeChunk(
      offset / chunkSize,
      payload.slice(offset, offset + chunkSize).buffer,
    );
  await cache.flush();
  f.volume.reads.length = 0;
  return { ...f, cache, payload, fingerprint };
}
const readBytes = (volume: MemoryNativeVolume) =>
  volume.reads.reduce((sum, read) => sum + read.length, 0);

it("reads a native receive once across finalization, publication, aliases and distinct cache snapshots", async () => {
  const f = await receive();
  await f.cache.verifyFile!();
  expect(readBytes(f.volume)).toBe(f.payload.length);
  expect(
    new Set(f.volume.reads.map((read) => read.path)),
  ).toEqual(new Set(["large.dll.part"]));
  expect(await f.volume.stat("large.dll.part")).toBeNull();
  expect((await f.volume.stat("large.dll"))?.size).toBe(
    f.payload.length,
  );
  expect(f.manager.getCache("received")).not.toBe(f.cache);
  await f.manager.library.prepare(
    { kind: "library", localFileId: "received" },
    { id: "sent-again", chunkSize: 256 * 1024 },
  );
  expect(
    await f.manager.library.hasContent(f.fingerprint),
  ).toBe(true);
  await f.manager.library.refresh();
  const identity = await f.cache.storageIdentity!();
  const second = await f.storage.createCache(identity, {
    existingOnly: true,
    memoryChunks: 4,
    isRetained: () => true,
  });
  try {
    await second.initialize();
    expect(
      await second.fingerprint!((await second.getFile())!),
    ).toEqual(f.fingerprint);
  } finally {
    second.dispose?.();
  }
  expect(readBytes(f.volume)).toBe(f.payload.length);
});

it("keeps an active receive alive when a directory scan replaces its temporary identity during verification", async () => {
  const f = await receive();
  await f.storage.synchronizeDirectories();
  let active = true;
  f.manager.isCacheInUse = (cache) =>
    active && cache === f.cache;
  const cleanup = vi.spyOn(f.cache, "cleanup");
  let entered!: () => void;
  let resume!: () => void;
  const verifying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const fingerprint = f.cache.fingerprint!.bind(f.cache);
  f.cache.fingerprint = async (file, options, compute) => {
    entered();
    await paused;
    return fingerprint(file, options, compute);
  };
  const completed = f.cache.verifyFile!();
  try {
    await verifying;
    await f.storage.authorizeDefault();
    await vi.waitFor(() =>
      expect(
        Object.values(appState.cache.cacheInfo).some(
          (info) =>
            info?.id.startsWith("directory_") &&
            info.isComplete,
        ),
      ).toBe(true),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect((await f.cache.getInfo())?.fileSize).toBe(
      f.payload.length,
    );
  } finally {
    resume();
    await completed;
    active = false;
  }
  await vi.waitFor(() =>
    expect(cleanup).toHaveBeenCalled(),
  );
  expect(await f.cache.getInfo()).toBeNull();
  expect((await f.volume.stat("large.dll"))?.size).toBe(
    f.payload.length,
  );
  expect(
    (await f.manager.getCache("received")!.getInfo())
      ?.isComplete,
  ).toBe(true);
  expect(readBytes(f.volume)).toBe(f.payload.length);
});

it("verifies once again after restart instead of trusting the persisted content fingerprint", async () => {
  const f = await receive();
  await f.cache.verifyFile!();
  f.manager.dispose();
  resetState();
  f.volume.reads.length = 0;
  const reopened = await open(f.volume);
  expect(readBytes(f.volume)).toBe(f.payload.length);
  expect(
    await reopened.manager.library.hasContent(
      f.fingerprint,
    ),
  ).toBe(true);
  await reopened.manager.library.refresh();
  expect(
    (await reopened.manager.getCache("received")!.getInfo())
      ?.isComplete,
  ).toBe(true);
  expect(readBytes(f.volume)).toBe(f.payload.length);
});

it("invalidates an edited version and never serves its bytes under the old content identity", async () => {
  const f = await receive();
  await f.cache.verifyFile!();
  const retained = f.manager.getCache("received")!;
  f.payload[0] = 20;
  await f.volume.commit(
    "large.dll",
    [{ offset: 0, data: f.payload }],
    f.payload.length,
  );
  f.volume.reads.length = 0;
  await expect(retained.getFile()).rejects.toThrow();
  expect(
    await f.manager.library.hasContent(f.fingerprint),
  ).toBe(false);
  await f.storage.authorizeDefault();
  await vi.waitFor(() =>
    expect(
      Object.values(appState.cache.cacheInfo).some(
        (info) =>
          info?.id.startsWith("directory_") &&
          info.isComplete,
      ),
    ).toBe(true),
  );
  const source = Object.values(
    appState.cache.cacheInfo,
  ).find(
    (info) =>
      info?.id.startsWith("directory_") && info.isComplete,
  )!;
  const prepared = await f.manager.library.prepare(
    { kind: "library", localFileId: source.id },
    { id: "new-version", chunkSize: 256 * 1024 },
  );
  const info = await prepared.getInfo();
  expect(
    f.manager
      .preparations()
      .some(
        (task) =>
          task.fileIds?.includes("new-version") &&
          task.status === "completed",
      ),
  ).toBe(true);
  expect(info?.fingerprint).toEqual(
    await fingerprintBlob(new Blob([f.payload])),
  );
  expect(info?.fingerprint).not.toEqual(f.fingerprint);
  await f.manager.library.refresh();
  expect(readBytes(f.volume)).toBe(f.payload.length);
  await expect(retained.getFile()).rejects.toThrow();
});

it("keeps the verified payload across a failed trailer cleanup and retry", async () => {
  const f = await receive();
  const commit = f.volume.commit.bind(f.volume);
  let fail = true;
  vi.spyOn(f.volume, "commit").mockImplementation(
    async (path, writes, size) => {
      if (
        fail &&
        path === "large.dll" &&
        size === f.payload.length
      ) {
        fail = false;
        throw new Error("Truncation failed");
      }
      return commit(path, writes, size);
    },
  );
  await expect(f.cache.getFile()).rejects.toThrow(
    "Truncation failed",
  );
  expect(
    (await f.volume.stat("large.dll"))!.size,
  ).toBeGreaterThan(f.payload.length);
  expect(readBytes(f.volume)).toBe(f.payload.length);
  await f.cache.verifyFile!();
  expect((await f.volume.stat("large.dll"))?.size).toBe(
    f.payload.length,
  );
  expect(
    (await f.manager.getCache("received")!.getInfo())
      ?.isComplete,
  ).toBe(true);
  expect(readBytes(f.volume)).toBe(f.payload.length);
});

it("rejects payload edits after verification but before the native move", async () => {
  const f = await receive();
  const move = f.volume.move.bind(f.volume);
  vi.spyOn(f.volume, "move").mockImplementationOnce(
    async (path, target, revision) => {
      await f.volume.commit(path, [
        { offset: 0, data: new Uint8Array([99]) },
      ]);
      return move(path, target, revision);
    },
  );
  await expect(f.cache.getFile()).rejects.toThrow(
    "File changed before move",
  );
  expect(await f.volume.stat("large.dll")).toBeNull();
  expect(
    await f.volume.stat("large.dll.part"),
  ).not.toBeNull();
  expect(
    await f.manager.library.hasContent(f.fingerprint),
  ).toBe(false);
});

it("verifies a physical copy separately and reuses both verified versions during recovery scans", async () => {
  const volume = new MemoryNativeVolume();
  Object.defineProperty(volume, "move", {
    value: undefined,
  });
  const f = await receive(volume);
  const remove = volume.remove.bind(volume);
  let fail = true;
  vi.spyOn(volume, "remove").mockImplementation(
    async (path) => {
      if (fail && path === "large.dll.part") {
        fail = false;
        throw new Error("Temporary file busy");
      }
      await remove(path);
    },
  );
  await expect(f.cache.getFile()).rejects.toThrow(
    "Temporary file busy",
  );
  // One read to verify the source, one to copy it and one to verify the committed destination.
  expect(readBytes(volume)).toBe(3 * f.payload.length);
  volume.reads.length = 0;
  const listing = await f.storage.synchronizeDirectories();
  expect(listing.files).toEqual(["received"]);
  await f.cache.verifyFile!();
  expect(await volume.stat("large.dll.part")).toBeNull();
  expect(
    (await f.manager.getCache("received")!.getInfo())
      ?.isComplete,
  ).toBe(true);
  expect(readBytes(volume)).toBe(0);
});
