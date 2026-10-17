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
import type { VfsVolume } from "@weblink/platform";
import { FileCacheFactory } from "@/libs/application/cache-service";
import { FileStorageService } from "@/libs/application/file-storage-service";
import { FileFingerprintService } from "@/libs/application/file-fingerprint-service";
import {
  VfsDatabase,
  type StoredVfsFile,
} from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import { IndexedDbFileLibrary } from "@/libs/infrastructure/storage/indexeddb-file-library";
import { VfsChunkCache } from "@/libs/infrastructure/vfs/chunk-cache";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import { libraryFiles } from "@/libs/application/files/library-query";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

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
      chunkSize: 4,
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
beforeEach(() => {
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("indexedDB", new IDBFactory());
  setAppState("cache", {
    cacheInfo: {},
    caches: {},
    status: "loading",
    error: undefined,
  });
  vi.spyOn(
    FileFingerprintService.prototype,
    "hash",
  ).mockImplementation((file, options) =>
    fingerprintBlob(
      file,
      options?.onProgress,
      options?.signal,
    ),
  );
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
function db() {
  const result = new VfsDatabase(crypto.randomUUID());
  databases.push(result);
  return result;
}
async function fixture() {
  const backing = new IndexedDbVolume(db());
  const volume: VfsVolume = Object.assign(
    Object.create(backing),
    {
      id: "native-default",
      name: "Files",
      kind: "native",
    },
  );
  const pickDirectory = vi
    .fn<() => Promise<VfsVolume | null>>()
    .mockResolvedValue(null);
  const reveal = vi.fn(
    async (_mountId: string, _path: string) => {},
  );
  const storage = new FileStorageService(
    {
      revealFile: reveal,
      volumes: async () => [volume],
      pickDirectory,
      openDirectory: async () => {},
    },
    db(),
  );
  const manager = new FileCacheFactory(storage);
  managers.push(manager);
  const write = (path: string, text: string) => {
    const data = new TextEncoder().encode(text);
    return volume.commit(
      path,
      [{ offset: 0, data }],
      data.length,
    );
  };
  return {
    storage,
    manager,
    volume,
    write,
    pickDirectory,
    reveal,
  };
}
const files = () =>
  Object.values(appState.cache.cacheInfo).filter(Boolean);
const names = () =>
  files()
    .map((file) => file.fileName)
    .sort();
const waitNames = (expected: string[]) =>
  vi.waitFor(() => expect(names()).toEqual(expected), {
    timeout: 4000,
    interval: 20,
  });

it("retains each reference's capabilities and mount after the default changes", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const native = (
    await f.manager.library.importFile(
      new File(["native"], "report.txt"),
    )
  ).cache;
  expect((await native.getInfo())?.capabilities).toEqual({
    save: "save-as",
    inlineSave: false,
    reveal: true,
  });
  expect((await native.getInfo())?.storageMountId).toBe(
    "native-default",
  );
  expect((await native.storageInfo?.())?.mountId).toBe(
    "native-default",
  );
  await native.reveal?.();
  expect(f.reveal).toHaveBeenLastCalledWith(
    "native-default",
    "report.txt",
  );
  await f.storage.setDefault("indexeddb");
  const browser = (
    await f.manager.library.importFile(
      new File(["browser"], "report.txt"),
    )
  ).cache;
  expect((await browser.getInfo())?.capabilities).toEqual({
    save: "download",
    inlineSave: true,
    reveal: false,
  });
  expect((await browser.getInfo())?.storageMountId).toBe(
    "indexeddb",
  );
  expect((await browser.storageInfo?.())?.mountId).toBe(
    "indexeddb",
  );
  await expect(browser.reveal?.()).rejects.toThrow(
    "File location is unavailable",
  );
  await native.reveal?.();
  expect(f.reveal).toHaveBeenLastCalledWith(
    "native-default",
    "report.txt",
  );
  const stat = vi
    .spyOn(f.volume, "stat")
    .mockRejectedValue(
      new DOMException("Denied", "NotAllowedError"),
    );
  const unavailable = await native.getInfo();
  expect(unavailable?.storageMountId).toBe(
    "native-default",
  );
  expect(unavailable?.capabilities?.save).toBe("save-as");
  expect(unavailable?.storageUnavailable).toBeTruthy();
  stat.mockRestore();
});

it("scopes the library to a newly selected directory while preserving old files and resumable data", async () => {
  const f = await fixture();
  await f.write("old.txt", "old bytes");
  await f.manager.initialize();
  const imported = (
    await f.manager.library.importFile(
      new File(["imported"], "imported.txt"),
    )
  ).cache;
  const partial = await f.manager.createCache(
    "unfinished-switch",
  );
  await partial.setInfo({
    fileName: "partial.bin",
    fileSize: 8,
    chunkSize: 4,
  });
  await partial.storeChunk(
    0,
    new Uint8Array([1, 2, 3, 4]).buffer,
  );
  await partial.flush();
  expect((await partial.getInfo())?.storageMountId).toBe(
    "native-default",
  );
  const visible = () =>
    libraryFiles(files(), f.storage.defaultMountId)
      .map((file) => file.fileName)
      .sort();
  expect(visible()).toEqual([
    "imported.txt",
    "old.txt",
    "partial.bin",
  ]);
  const backing = new IndexedDbVolume(db());
  const next: VfsVolume = Object.assign(
    Object.create(backing),
    {
      id: "native-next",
      name: "Next",
      kind: "native",
    },
  );
  const data = new TextEncoder().encode("next bytes");
  await next.commit(
    "next.txt",
    [{ offset: 0, data }],
    data.length,
  );
  f.pickDirectory.mockResolvedValue(next);
  const id = await f.storage.mountDirectory();
  await f.storage.setDefault(id!);
  await vi.waitFor(
    () => expect(visible()).toEqual(["next.txt"]),
    { timeout: 4000 },
  );
  expect(
    await imported.getFile().then((file) => file?.text()),
  ).toBe("imported");
  expect(await partial.getReqRanges()).toEqual([1]);
  expect([
    ...new Uint8Array((await partial.getChunk(0))!),
  ]).toEqual([1, 2, 3, 4]);
  expect((await f.volume.stat("old.txt"))?.size).toBe(9);
  await next.remove("next.txt");
  await vi.waitFor(() => expect(visible()).toEqual([]), {
    timeout: 4000,
  });
  await f.storage.setDefault("native-default");
  expect(visible()).toEqual([
    "imported.txt",
    "old.txt",
    "partial.bin",
  ]);
  await f.storage.setDefault("indexeddb");
  expect(visible()).toEqual([]);
  const browser = (
    await f.manager.library.importFile(
      new File(["browser"], "browser.txt"),
    )
  ).cache;
  expect(visible()).toEqual(["browser.txt"]);
  expect((await browser.getInfo())?.storageMountId).toBe(
    "indexeddb",
  );
  expect(await partial.getReqRanges()).toEqual([1]);
});

it("lists existing nested files directly, syncs watch events, and never treats preallocation as completion", async () => {
  const f = await fixture();
  await f.write("existing.txt", "original");
  await f.write("nested/empty.txt", "");
  const writes = vi.spyOn(f.volume, "commit");
  await f.manager.initialize();
  expect(names()).toEqual(["empty.txt", "existing.txt"]);
  expect(writes).not.toHaveBeenCalled();
  expect(await f.storage.database.all("files")).toEqual([]);
  expect(
    await f.storage.database.all("checkpoints"),
  ).toEqual([]);
  expect(
    files().every(
      (info) => info.isComplete && !info.isShared,
    ),
  ).toBe(true);
  const original = files().find(
    (info) => info.fileName === "existing.txt",
  )!;
  expect(await original.file!.text()).toBe("original");
  await f.write("added.txt", "new");
  await waitNames([
    "added.txt",
    "empty.txt",
    "existing.txt",
  ]);
  await f.write("existing.txt", "replaced");
  await vi.waitFor(async () => {
    const current = files().find(
      (info) => info.fileName === "existing.txt",
    );
    expect(current).toBeDefined();
    expect(current!.id).not.toBe(original.id);
    expect(await current!.file?.text()).toBe("replaced");
  });
  await f.write("nested/renamed.txt", "new");
  await f.volume.remove("added.txt");
  await waitNames([
    "empty.txt",
    "existing.txt",
    "renamed.txt",
  ]);
  await f.volume.remove("existing.txt");
  await waitNames(["empty.txt", "renamed.txt"]);
  const receive = await f.manager.createCache("unfinished");
  await receive.setInfo({
    fileName: "receiving.bin",
    fileSize: 12,
    chunkSize: 4,
  });
  await receive.storeChunk(
    1,
    new Uint8Array([1, 2, 3, 4]).buffer,
  );
  await receive.flush();
  await f.storage.synchronize();
  expect(await receive.getReqRanges()).toEqual([0, 2]);
  expect((await receive.getInfo())?.isComplete).toBe(false);
});

it("preserves directory membership on failed scans, recovers permission, and retains IDs after restart", async () => {
  const f = await fixture();
  await f.write("keep.txt", "keep");
  await f.manager.initialize();
  const original = files()[0];
  const list = vi
    .spyOn(f.volume, "list")
    .mockRejectedValue(
      new DOMException("Denied", "NotAllowedError"),
    );
  expect((await f.storage.synchronize()).files).toEqual([
    original.id,
  ]);
  expect((await f.storage.synchronize()).removed).toEqual(
    [],
  );
  list.mockRestore();
  const stat = vi
    .spyOn(f.volume, "stat")
    .mockResolvedValue(null);
  expect((await f.storage.synchronize()).removed).toEqual(
    [],
  );
  stat.mockRestore();
  const restarted = new FileStorageService(
    {
      volumes: async () => [f.volume],
      pickDirectory: async () => null,
      openDirectory: async () => {},
    },
    db(),
  );
  await restarted.initialize();
  expect((await restarted.synchronize()).files).toEqual([
    original.id,
  ]);
  restarted.dispose();
});

it("keeps old send identities unavailable after external edits and sends the new version", async () => {
  const f = await fixture();
  await f.write("source.txt", "old version");
  await f.manager.initialize();
  const source = files()[0];
  const sent = await f.manager.library.prepare(
    { kind: "library", localFileId: source.id },
    { id: "sent-before-edit", chunkSize: 4 },
  );
  expect(await (await sent.getFile())!.text()).toBe(
    "old version",
  );
  await f.write("source.txt", "new version");
  await vi.waitFor(() =>
    expect(
      files().some(
        (info) =>
          info.id !== source.id &&
          info.id !== sent.id &&
          info.isComplete,
      ),
    ).toBe(true),
  );
  expect(f.manager.getCache(source.id)).toBeNull();
  const updated = files().find(
    (info) => info.id !== sent.id,
  )!;
  expect(updated.isComplete).toBe(true);
  expect(
    (await sent.getInfo())?.storageUnavailable,
  ).toBeTruthy();
  const next = await f.manager.library.prepare(
    { kind: "library", localFileId: updated.id },
    { id: "sent-after-edit", chunkSize: 4 },
  );
  expect(await (await next.getFile())!.text()).toBe(
    "new version",
  );
  expect(
    (await next.getInfo())?.fingerprint?.digest,
  ).not.toBe((await sent.getInfo())?.fingerprint?.digest);
});

it("deletes an indexed source only on explicit deletion and never deletes a replacement version", async () => {
  const f = await fixture();
  await f.write("source.txt", "old");
  await f.manager.initialize();
  const source = files()[0];
  const cache = f.manager.getCache(source.id)!;
  await cache.cleanup();
  expect(await f.volume.stat("source.txt")).not.toBeNull();
  await f.write("source.txt", "new");
  await expect(
    cache.cleanup({ deleteSource: true }),
  ).rejects.toThrow(/changed/);
  expect(await f.volume.stat("source.txt")).not.toBeNull();
  await vi.waitFor(() =>
    expect(files()[0].id).not.toBe(source.id),
  );
  await f.manager.remove(files()[0].id);
  await waitNames([]);
  expect(await f.volume.stat("source.txt")).toBeNull();
  const records =
    await f.storage.database.all<StoredVfsFile>("files");
  expect(
    records.filter(
      (record) => record.source === "directory",
    ),
  ).toHaveLength(0);
});

it("restores retained references from verified identical bytes after a rename without copying", async () => {
  const f = await fixture();
  await f.write("before.txt", "same bytes");
  await f.manager.initialize();
  const source = files()[0];
  const sent = await f.manager.library.prepare(
    { kind: "library", localFileId: source.id },
    { id: "sent", chunkSize: 4 },
  );
  await f.manager.library.setShared(source.id, true);
  await f.write("after.txt", "same bytes");
  await f.volume.remove("before.txt");
  await vi.waitFor(() =>
    expect(
      files().some(
        (info) =>
          info.fileName === "after.txt" && info.isComplete,
      ),
    ).toBe(true),
  );
  expect(f.manager.getCache(source.id)).toBeNull();
  expect(
    (await sent.getInfo())?.storageUnavailable,
  ).toBeTruthy();
  const renamed = files().find(
    (file) => file.fileName === "after.txt",
  )!;
  const writes = vi.spyOn(f.volume, "commit");
  const next = await f.manager.library.prepare(
    { kind: "library", localFileId: renamed.id },
    { id: "sent-again", chunkSize: 4 },
  );
  expect(writes).not.toHaveBeenCalled();
  expect(await (await next.getFile())!.text()).toBe(
    "same bytes",
  );
  expect(await (await sent.getFile())!.text()).toBe(
    "same bytes",
  );
  expect(
    await f.manager.library.sharedFiles(),
  ).toHaveLength(1);
});

it("removes the selected source path after deduplication against existing managed content", async () => {
  const f = await fixture();
  await f.write("source.txt", "same");
  await f.manager.initialize();
  const source = files()[0];
  await f.manager.library.importFile(
    new File(["same"], "imported.txt"),
  );
  await f.manager.library.prepare(
    { kind: "library", localFileId: source.id },
    { id: "send", chunkSize: 4 },
  );
  expect(f.manager.library.ownsStorage(source.id)).toBe(
    false,
  );
  expect(await f.volume.stat("source.txt")).not.toBeNull();
  await f.manager.remove(source.id);
  expect(await f.volume.stat("source.txt")).toBeNull();
  expect((await f.storage.synchronize()).files).toEqual([]);
});

it("does not list a managed file twice and verifies retained content again after restart", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const imported = await f.manager.library.importFile(
    new File(["original"], "imported.txt"),
  );
  await waitNames(["imported.txt"]);
  await f.write("watch.txt", "trigger directory refresh");
  await waitNames(["imported.txt", "watch.txt"]);
  const path = "imported.txt";
  const previousRevision = (await f.volume.stat(path))!
    .revision;
  const originalId = imported.cache.id;
  f.manager.dispose();
  await f.write(path, "replaced");
  // Size/mtime-style revisions can remain unchanged after an external replacement.
  const stat = f.volume.stat.bind(f.volume);
  const list = f.volume.list.bind(f.volume);
  vi.spyOn(f.volume, "stat").mockImplementation(
    async (entry) => {
      const current = await stat(entry);
      return entry === path && current
        ? { ...current, revision: previousRevision }
        : current;
    },
  );
  vi.spyOn(f.volume, "list").mockImplementation(
    async (entry) =>
      (await list(entry)).map((current) =>
        current.name === path
          ? { ...current, revision: previousRevision }
          : current,
      ),
  );
  setAppState("cache", {
    cacheInfo: {},
    caches: {},
    status: "loading",
    error: undefined,
  });
  const storage = new FileStorageService(
    {
      volumes: async () => [f.volume],
      pickDirectory: async () => null,
      openDirectory: async () => {},
    },
    db(),
  );
  const restarted = new FileCacheFactory(storage);
  managers.push(restarted);
  await restarted.initialize();
  const retained = restarted.getCache(originalId)!;
  expect(
    (await retained.getInfo())?.storageUnavailable,
  ).toBeTruthy();
  await expect(retained.getFile()).rejects.toThrow(
    /fingerprint/,
  );
});

it.each(["deleted", "replaced"])(
  "reimports %s native content after restart without losing attachment or shared references",
  async (change) => {
    const f = await fixture();
    await f.manager.initialize();
    const file = new File(
      ["original dll bytes"],
      "amd_fidelityfx_loader_dx12.dll",
    );
    const imported =
      await f.manager.library.importFile(file);
    await f.manager.library.prepare(
      { kind: "library", localFileId: imported.cache.id },
      { id: "sent", chunkSize: 4 },
    );
    await f.manager.library.setShared(
      imported.cache.id,
      true,
    );
    const [shared] = await f.manager.library.sharedFiles();
    f.manager.dispose();
    if (change === "deleted")
      await f.volume.remove(file.name);
    else await f.write(file.name, "externally replaced");
    setAppState("cache", {
      cacheInfo: {},
      caches: {},
      status: "loading",
      error: undefined,
    });
    const storage = new FileStorageService(
      {
        volumes: async () => [f.volume],
        pickDirectory: async () => null,
        openDirectory: async () => {},
      },
      db(),
    );
    const reopened = new FileCacheFactory(storage);
    managers.push(reopened);
    await reopened.initialize();
    const sent = reopened.getCache("sent")!;
    expect((await sent.getInfo())?.storageMissing).toBe(
      true,
    );

    const [restored, duplicate] = await Promise.all([
      reopened.library.importFile(file),
      reopened.library.importFile(file),
    ]);
    expect(restored.reused).toBe(false);
    expect(duplicate.reused).toBe(true);
    expect(duplicate.cache.id).toBe(restored.cache.id);
    expect(
      await new IndexedDbFileLibrary().reference(
        imported.cache.id,
      ),
    ).toBeUndefined();
    expect(
      await (await restored.cache.getFile())!.text(),
    ).toBe(await file.text());
    expect(await (await sent.getFile())!.text()).toBe(
      await file.text(),
    );
    expect(
      (await sent.getInfo())?.storageUnavailable,
    ).toBeUndefined();
    expect(
      (await reopened.library.sharedFiles()).map(
        (item) => item.id,
      ),
    ).toEqual([shared.id]);
    expect(
      (await f.volume.list(""))
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(
      change === "deleted"
        ? [file.name]
        : ["amd_fidelityfx_loader_dx12 (1).dll", file.name],
    );
    if (change === "replaced")
      expect(
        new TextDecoder().decode(
          await f.volume.read(file.name, 0, 19),
        ),
      ).toBe("externally replaced");
    await vi.waitFor(() => {
      const visible = libraryFiles(files());
      expect(visible).toHaveLength(
        change === "deleted" ? 1 : 2,
      );
      expect(
        visible.every((entry) => !entry.storageUnavailable),
      ).toBe(true);
      expect(
        appState.cache.cacheInfo.sent.storageUnavailable,
      ).toBeUndefined();
    });
  },
);

it("removes only newly created bytes when an upload is cancelled while publishing", async () => {
  const f = await fixture();
  await f.write("report.txt", "existing");
  await f.manager.initialize();
  const controller = new AbortController();
  const identity = VfsChunkCache.prototype.storageIdentity;
  vi.spyOn(
    VfsChunkCache.prototype,
    "storageIdentity",
  ).mockImplementation(async function (
    this: VfsChunkCache,
  ) {
    const id = await identity.call(this);
    controller.abort();
    return id;
  });
  await expect(
    f.manager.library.importFile(
      new File(["new data"], "report.txt"),
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await f.volume.read("report.txt", 0, 8)).toEqual(
    new TextEncoder().encode("existing").buffer,
  );
  expect(await f.volume.stat("report (1).txt")).toBeNull();
});

it("keeps one PDF row when a directory scan discovers the upload before its reference is published", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const identity = VfsChunkCache.prototype.storageIdentity;
  vi.spyOn(
    VfsChunkCache.prototype,
    "storageIdentity",
  ).mockImplementation(async function (
    this: VfsChunkCache,
  ) {
    const id = await identity.call(this);
    await f.storage.authorizeDefault();
    // Force the watch scan into the gap between the file commit and reference commit.
    await vi.waitFor(
      () => expect(f.manager.getCache(id)).not.toBeNull(),
      { timeout: 4000 },
    );
    return id;
  });
  const imported = await f.manager.library.importFile(
    new File(["%PDF-1.7"], "report.pdf", {
      type: "application/pdf",
    }),
  );
  await vi.waitFor(() =>
    expect(
      libraryFiles(files()).map((file) => file.id),
    ).toEqual([imported.cache.id]),
  );
  expect(
    (await f.volume.list("")).map((file) => file.name),
  ).toEqual(["report.pdf"]);
  await f.manager.library.refresh();
  expect(libraryFiles(files())).toHaveLength(1);
});

it("reuses the same preview file across unchanged reference refreshes", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const imported = await f.manager.library.importFile(
    new File(["image bytes"], "image.png", {
      type: "image/png",
    }),
  );
  const first = (await imported.cache.getInfo())!.file;
  await f.manager.library.refresh();
  expect((await imported.cache.getInfo())!.file).toBe(
    first,
  );
  await f.storage.authorizeDefault();
  await f.manager.library.refresh();
  expect((await imported.cache.getInfo())!.file).toBe(
    first,
  );
});

it("keeps an uncommitted local import out of directory scans and removes it on cancellation", async () => {
  const f = await fixture();
  await f.write("keep.txt", "keep");
  await f.manager.initialize();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  f.volume.writeFile = async (path, source, signal) => {
    // FileSystemFileHandle creates an empty entry before the stream is closed.
    await f.volume.commit(path, [], 0);
    enter();
    await paused;
    signal?.throwIfAborted();
    return f.volume.commit(
      path,
      [
        {
          offset: 0,
          data: new Uint8Array(await source.arrayBuffer()),
        },
      ],
      source.size,
    );
  };
  const controller = new AbortController();
  const importing = f.manager.library.importFile(
    new File(["%PDF-1.7"], "cancelled.pdf"),
    { signal: controller.signal },
  );
  await entered;
  expect((await f.storage.synchronize()).files).toEqual([
    files()[0].id,
  ]);
  controller.abort();
  const rejected = expect(importing).rejects.toMatchObject({
    name: "AbortError",
  });
  resume();
  await rejected;
  expect(await f.volume.stat("cancelled.pdf")).toBeNull();
  expect(await f.volume.read("keep.txt", 0, 4)).toEqual(
    new TextEncoder().encode("keep").buffer,
  );
});

it("verifies complete streamed imports before publishing their content references", async () => {
  const f = await fixture();
  await f.manager.initialize();
  f.volume.writeFile = async (path) =>
    f.write(path, "tampered");
  await expect(
    f.manager.library.importFile(
      new File(["original"], "integrity.txt"),
    ),
  ).rejects.toThrow("File content verification failed");
  expect(await f.volume.stat("integrity.txt")).toBeNull();
  expect(libraryFiles(files())).toEqual([]);
});

it.each(["stream", "chunks"])(
  "reports actual import bytes through %s writes and verification",
  async (mode) => {
    const f = await fixture();
    await f.manager.initialize();
    if (mode === "stream")
      f.volume.writeFile = async (
        path,
        source,
        signal,
        onWritten,
      ) => {
        signal?.throwIfAborted();
        const bytes = new Uint8Array(
          await source.arrayBuffer(),
        );
        const stat = await f.volume.commit(
          path,
          [{ offset: 0, data: bytes }],
          source.size,
        );
        onWritten?.(source.size);
        return stat;
      };
    const onProgress = vi.fn();
    const onImportProgress = vi.fn();
    const file = new File(["progress"], "progress.txt");
    const result = await f.manager.library.importFile(
      file,
      { onProgress, onImportProgress },
    );
    expect(
      onImportProgress.mock.calls.map(
        ([progress]) => progress,
      ),
    ).toEqual([
      { phase: "identifying", bytes: 0 },
      { phase: "identifying", bytes: file.size },
      { phase: "writing", bytes: 0 },
      { phase: "writing", bytes: file.size },
      { phase: "verifying", bytes: 0 },
      { phase: "verifying", bytes: file.size },
    ]);
    expect(onProgress).toHaveBeenCalledWith(file.size);
    expect((await result.cache.getFile())?.size).toBe(
      file.size,
    );
    expect(
      await f.volume.read("progress.txt", 0, file.size),
    ).toEqual(await file.arrayBuffer());
  },
);

it.each(["stream", "chunks"])(
  "cancels %s verification and removes only the unfinished import",
  async (mode) => {
    const f = await fixture();
    await f.write("keep.txt", "keep");
    await f.manager.initialize();
    if (mode === "stream")
      f.volume.writeFile = async (path, source) =>
        f.write(path, await source.text());
    const controller = new AbortController();
    await expect(
      f.manager.library.importFile(
        new File(["cancel"], "cancel.txt"),
        {
          signal: controller.signal,
          onImportProgress: (progress) => {
            if (progress.phase === "verifying")
              controller.abort();
          },
        },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await f.volume.stat("cancel.txt")).toBeNull();
    expect(
      await f.volume.stat("cancel.txt.part"),
    ).toBeNull();
    expect(await f.volume.read("keep.txt", 0, 4)).toEqual(
      new TextEncoder().encode("keep").buffer,
    );
  },
);

it("removes an upload deleted before its first directory watch snapshot", async () => {
  const f = await fixture();
  vi.spyOn(f.volume, "watch").mockResolvedValue(() => {});
  await f.manager.initialize();
  const imported = await f.manager.library.importFile(
    new File(["quickly removed"], "quick.txt"),
  );
  await f.volume.remove("quick.txt");
  await f.storage.authorizeDefault();
  await vi.waitFor(() =>
    expect(
      f.manager.getCache(imported.cache.id),
    ).toBeNull(),
  );
  const repository = new IndexedDbFileLibrary();
  expect(await repository.references()).toEqual([]);
  expect(await repository.contents()).toEqual([]);
  expect(libraryFiles(files())).toEqual([]);
});

async function restart(volume: VfsVolume) {
  setAppState("cache", {
    cacheInfo: {},
    caches: {},
    status: "loading",
    error: undefined,
  });
  const storage = new FileStorageService(
    {
      volumes: async () => [volume],
      pickDirectory: async () => null,
      openDirectory: async () => {},
    },
    db(),
  );
  const manager = new FileCacheFactory(storage);
  managers.push(manager);
  await manager.initialize();
  return { manager, storage };
}

it.each(["running", "restarted", "orphaned"])(
  "cleans missing directory contents and import pins when %s",
  async (state) => {
    const f = await fixture();
    vi.spyOn(f.volume, "watch").mockResolvedValue(() => {});
    await f.manager.initialize();
    const imported = await f.manager.library.importFile(
      new File(["removed"], "gone.txt"),
    );
    const repository = new IndexedDbFileLibrary();
    const [content] = await repository.contents();
    expect(content.storageId).toMatch(/^directory_/);
    expect(content.storageId).not.toBe(imported.cache.id);
    await f.storage.synchronize();
    if (state !== "running") f.manager.dispose();
    if (state === "orphaned")
      await repository.removeReference(imported.cache.id);
    await f.volume.remove("gone.txt");
    if (state === "running")
      await f.storage.authorizeDefault();
    else await restart(f.volume);
    await vi.waitFor(async () => {
      expect(await repository.references()).toEqual([]);
      expect(await repository.contents()).toEqual([]);
      expect(libraryFiles(files())).toEqual([]);
    });
    expect(await f.volume.list("")).toEqual([]);
  },
);

it.each(["running", "restarted"])(
  "preserves import pins when the directory is inaccessible while %s",
  async (state) => {
    const f = await fixture();
    vi.spyOn(f.volume, "watch").mockResolvedValue(() => {});
    await f.manager.initialize();
    const imported = await f.manager.library.importFile(
      new File(["keep"], "keep.txt"),
    );
    const repository = new IndexedDbFileLibrary();
    const contents = await repository.contents();
    const refs = await repository.references();
    if (state === "restarted") f.manager.dispose();
    const stat = vi
      .spyOn(f.volume, "stat")
      .mockRejectedValue(
        new DOMException("Denied", "NotAllowedError"),
      );
    const active =
      state === "restarted" ? await restart(f.volume) : f;
    await active.storage.synchronize();
    await active.manager.library.reconcileMissingFiles();
    expect(await repository.contents()).toEqual(contents);
    expect(await repository.references()).toEqual(refs);
    expect(
      (
        await active.manager
          .getCache(imported.cache.id)!
          .getInfo()
      )?.storageMissing,
    ).not.toBe(true);
    stat.mockRestore();
    await active.storage.authorizeDefault();
    await vi.waitFor(async () =>
      expect(
        (
          await active.manager
            .getCache(imported.cache.id)!
            .getInfo()
        )?.isComplete,
      ).toBe(true),
    );
    expect(await repository.references()).toEqual(refs);
  },
);

it("removes an old version's index without deleting the replacement file", async () => {
  const f = await fixture();
  vi.spyOn(f.volume, "watch").mockResolvedValue(() => {});
  await f.manager.initialize();
  const imported = await f.manager.library.importFile(
    new File(["original"], "replace.txt"),
  );
  await f.storage.synchronize();
  await f.write("replace.txt", "replaced");
  await f.storage.authorizeDefault();
  const repository = new IndexedDbFileLibrary();
  await vi.waitFor(async () => {
    expect(await repository.contents()).toEqual([]);
    expect(await repository.references()).toEqual([]);
    expect(
      f.manager.getCache(imported.cache.id),
    ).toBeNull();
    expect(libraryFiles(files())).toHaveLength(1);
  });
  expect(
    new TextDecoder().decode(
      await f.volume.read("replace.txt", 0, 8),
    ),
  ).toBe("replaced");
});

it("does not infer deletion from a newly mounted root when loading the previous mounts failed", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const imported = await f.manager.library.importFile(
    new File(["keep"], "keep.txt"),
  );
  f.manager.dispose();
  setAppState("cache", {
    cacheInfo: {},
    caches: {},
    status: "loading",
    error: undefined,
  });
  const next: VfsVolume = Object.assign(
    Object.create(new IndexedDbVolume(db())),
    { id: "native-next", name: "Next", kind: "native" },
  );
  const storage = new FileStorageService(
    {
      volumes: async () => {
        throw new Error("Cannot read directory registry");
      },
      pickDirectory: async () => next,
      openDirectory: async () => {},
    },
    db(),
  );
  const manager = new FileCacheFactory(storage);
  managers.push(manager);
  await manager.initialize();
  await storage.mountDirectory();
  await storage.setDefault(next.id);
  await storage.synchronize();
  await manager.library.reconcileMissingFiles();
  const repository = new IndexedDbFileLibrary();
  expect(
    await repository.reference(imported.cache.id),
  ).toBeDefined();
  expect(await repository.contents()).toHaveLength(1);
  expect(
    (await manager.getCache(imported.cache.id)!.getInfo())
      ?.storageMissing,
  ).not.toBe(true);
});

it("does not publish a partial scan or create duplicate entries from concurrent scans", async () => {
  const f = await fixture();
  await f.write("one.txt", "one");
  await f.manager.initialize();
  const first = files()[0];
  await f.write("two.txt", "two");
  const open = vi
    .spyOn(f.volume, "file")
    .mockRejectedValue(new Error("File busy"));
  const failed = await f.storage.synchronize();
  expect(failed.files).toEqual([first.id]);
  expect(failed.removed).toEqual([]);
  open.mockRestore();
  const scans = await Promise.all([
    f.storage.synchronize(),
    f.storage.synchronize(),
  ]);
  expect(scans[0].files.sort()).toEqual(
    scans[1].files.sort(),
  );
  expect(scans[0].files).toHaveLength(2);
});

it("receives missing content again after restart and restores retained attachment references", async () => {
  const f = await fixture();
  await f.manager.initialize();
  const cache = await f.manager.createCache("received");
  await cache.setInfo({
    fileName: "received.txt",
    fileSize: 4,
    chunkSize: 4,
    fingerprint: await fingerprintBlob(new Blob(["data"])),
  });
  await cache.storeChunk(
    0,
    new TextEncoder().encode("data").buffer,
  );
  await cache.verifyFile!();
  await f.storage.synchronize();
  const reference = f.manager.getCache("received")!;
  expect(reference).not.toBe(cache);
  await f.volume.remove("received.txt");
  await vi.waitFor(() =>
    expect(
      appState.cache.cacheInfo.received?.storageUnavailable,
    ).toBeTruthy(),
  );
  expect(f.manager.getCache("received")).toBe(reference);
  expect(
    await f.manager.library.referenceCount("received"),
  ).toBe(1);
  expect((await reference.getInfo())?.fileName).toBe(
    "received.txt",
  );
  expect(libraryFiles(files())).toEqual([]);
  f.manager.dispose();
  setAppState("cache", {
    cacheInfo: {},
    caches: {},
    status: "loading",
    error: undefined,
  });
  const reopenedStorage = new FileStorageService(
    {
      volumes: async () => [f.volume],
      pickDirectory: async () => null,
      openDirectory: async () => {},
    },
    db(),
  );
  const reopened = new FileCacheFactory(reopenedStorage);
  managers.push(reopened);
  await reopened.initialize();
  expect(libraryFiles(files())).toEqual([]);
  expect(
    (await reopened.getCache("received")!.getInfo())
      ?.storageMissing,
  ).toBe(true);
  const retained = reopened.getCache("received")!;
  const info = (await retained.getInfo())!;
  expect(info.storageUnavailable).toBe(
    "Storage directory is unavailable",
  );
  // A stale content index must be a reuse miss, not a receive failure.
  expect(
    await reopened.library.hasContent(info.fingerprint!),
  ).toBe(false);
  const incoming = {
    id: "received-again",
    fileName: "received.txt",
    fileSize: 4,
    chunkSize: 4,
    fingerprint: info.fingerprint,
  };
  expect(
    await reopened.library.reuse(
      info.fingerprint!,
      incoming,
    ),
  ).toBeNull();
  expect((await retained.getInfo())?.storageMissing).toBe(
    true,
  );
  const next = await reopened.createCache(incoming.id);
  await next.setInfo(incoming);
  expect(await next.getReqRanges()).toEqual([0]);
  await next.storeChunk(
    0,
    new TextEncoder().encode("data").buffer,
  );
  await next.verifyFile!();
  expect(await (await retained.getFile())!.text()).toBe(
    "data",
  );
  expect(
    (await retained.getInfo())?.storageUnavailable,
  ).toBeUndefined();
  expect(
    await reopened.library.referenceCount("received"),
  ).toBe(2);
  expect(
    (await f.volume.list(""))
      .filter((entry) => entry.kind === "file")
      .map((entry) => entry.name),
  ).toEqual(["received.txt"]);
});

it("removes a source deleted in another window and clears unavailable state on reconnection", async () => {
  const f = await fixture();
  await f.write("keep.txt", "keep");
  await f.manager.initialize();
  const id = files()[0].id;
  const cache = f.manager.getCache(id)!;
  const stat = vi
    .spyOn(f.volume, "stat")
    .mockRejectedValue(
      new DOMException("Denied", "NotAllowedError"),
    );
  await cache.refresh?.();
  expect(
    appState.cache.cacheInfo[id].storageUnavailable,
  ).toBeTruthy();
  expect(appState.cache.cacheInfo[id].file).toBeUndefined();
  expect(libraryFiles(files())).toHaveLength(1);
  stat.mockRestore();
  await cache.refresh?.();
  expect(
    appState.cache.cacheInfo[id].storageUnavailable,
  ).toBeUndefined();
  expect(appState.cache.cacheInfo[id].isComplete).toBe(
    true,
  );
  const second = await f.storage.createCache(id, {
    memoryChunks: 4,
    isRetained: () => false,
  });
  await second.cleanup({ deleteSource: true });
  await cache.refresh?.();
  expect(f.manager.getCache(id)).toBeNull();
  expect(names()).toEqual([]);
});

it("discovers and removes IndexedDB files written by a separate storage connection through the same catalog", async () => {
  const name = crypto.randomUUID();
  const firstDatabase = new VfsDatabase(name);
  const secondDatabase = new VfsDatabase(name);
  databases.push(firstDatabase, secondDatabase);
  const first = new FileStorageService(
    undefined,
    firstDatabase,
  );
  const second = new FileStorageService(
    undefined,
    secondDatabase,
  );
  const manager = new FileCacheFactory(first);
  managers.push(manager);
  await manager.initialize();
  try {
    await second.initialize();
    const cache = await second.createCache(
      "opaque-catalog-entry",
      {
        memoryChunks: 4,
        isRetained: () => false,
      },
    );
    await cache.setInfo({
      fileName: "other-window.txt",
      fileSize: 4,
      chunkSize: 4,
      file: new File(["data"], "other-window.txt"),
    });
    await waitNames(["other-window.txt"]);
    expect(files()[0].capabilities).toEqual({
      save: "download",
      inlineSave: true,
      reveal: false,
    });
    expect(await first.list()).toContain(cache.id);
    await second.removeSource(cache.id);
    await waitNames([]);
    expect((await first.synchronize()).files).not.toContain(
      cache.id,
    );
    expect(await firstDatabase.all("checkpoints")).toEqual(
      [],
    );
    expect(await firstDatabase.all("pages")).toEqual([]);
  } finally {
    second.dispose();
  }
});

it.each(["indexeddb", "native-default"])(
  "releases missing local pins while retaining chat references through the same lifecycle in %s",
  async (mountId) => {
    const f = await fixture();
    await f.manager.initialize();
    await f.storage.setDefault(mountId);
    const imported = await f.manager.library.importFile(
      new File(["gone"], "gone.txt"),
    );
    const attachment = await f.manager.library.prepare(
      { kind: "library", localFileId: imported.cache.id },
      { id: "chat-retained", chunkSize: 4 },
    );
    const repository = new IndexedDbFileLibrary();
    const [content] = await repository.contents();
    const external = await f.storage.createCache(
      content.storageId,
      {
        memoryChunks: 4,
        isRetained: () => false,
        existingOnly: true,
      },
    );
    await external.cleanup({ deleteSource: true });
    await vi.waitFor(async () => {
      expect(
        (await repository.references()).map(
          (ref) => ref.id,
        ),
      ).toEqual(["chat-retained"]);
      expect(libraryFiles(files())).toEqual([]);
    });
    expect(
      await repository.content(content.key),
    ).toMatchObject({ storageId: content.storageId });
    expect((await attachment.getInfo())?.isComplete).toBe(
      false,
    );
  },
);

it.each(["indexeddb", "native-default"])(
  "releases ownership without deleting user-owned files in %s",
  async (mountId) => {
    const f = await fixture();
    await f.manager.initialize();
    await f.storage.setDefault(mountId);
    const imported = await f.manager.library.importFile(
      new File(["keep"], "keep.txt"),
    );
    const volume = await f.storage.getVolume(mountId);
    await f.manager.library.release(imported.cache.id);
    expect(
      await new IndexedDbFileLibrary().contents(),
    ).toEqual([]);
    if (mountId === "indexeddb")
      expect(await volume.list("")).toEqual([]);
    else
      expect(
        (await volume.list("")).map((entry) => entry.name),
      ).toEqual(["keep.txt"]);
  },
);
