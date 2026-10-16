import { FileStorageService } from "@/libs/application/file-storage-service";
import { FileCacheFactory } from "@/libs/application/cache-service";
import { DirectoryVolume } from "@/libs/infrastructure/vfs/directory-volume";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { VfsChunkCache } from "@/libs/infrastructure/vfs/chunk-cache";
import { FileLibraryService } from "@/libs/application/file-library-service";
import { IndexedDbFileLibrary } from "@/libs/infrastructure/storage/indexeddb-file-library";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import type { ChunkCache } from "@/libs/domain/file";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { libraryFiles } from "@/libs/application/files/library-query";
import { DirectoryWriteError } from "@/libs/domain/vfs";
import { encodeDirectoryFilename } from "@/libs/infrastructure/vfs/directory-filename";

function assert(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
const eq = (actual: unknown, expected: unknown) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );

async function checkBrowserUpload(passed: string[]) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle(
    `vfs-upload-${crypto.randomUUID()}`,
    { create: true },
  );
  const databaseName = `vfs-upload-${crypto.randomUUID()}`;
  let storage = new FileStorageService(
    undefined,
    new VfsDatabase(databaseName),
  );
  let manager = new FileCacheFactory(storage);
  const picker = window.showDirectoryPicker;
  const queryPermission =
    FileSystemHandle.prototype.queryPermission;
  const requestPermission =
    FileSystemHandle.prototype.requestPermission;
  const createWritable =
    FileSystemFileHandle.prototype.createWritable;
  const writers = new Map<string, number>();
  let rejectCommit = false;
  FileSystemFileHandle.prototype.createWritable = function (
    this: FileSystemFileHandle,
    options,
  ) {
    writers.set(
      this.name,
      (writers.get(this.name) ?? 0) + 1,
    );
    return createWritable
      .call(this, options)
      .then((stream) => {
        if (rejectCommit && this.name === "blocked.exe")
          stream.close = async () => {
            throw new DOMException(
              "Blocked by Safe Browsing.",
              "AbortError",
            );
          };
        return stream;
      });
  };
  let permission: PermissionState = "granted";
  let requests = 0;
  FileSystemHandle.prototype.queryPermission = function (
    options,
  ) {
    return this.name === handle.name
      ? Promise.resolve(permission)
      : queryPermission.call(this, options);
  };
  FileSystemHandle.prototype.requestPermission = function (
    options,
  ) {
    if (this.name !== handle.name)
      return requestPermission.call(this, options);
    requests++;
    permission = "granted";
    return Promise.resolve(permission);
  };
  window.showDirectoryPicker = async () => handle;
  try {
    await manager.initialize();
    const mountId = await storage.mountDirectory();
    assert(mountId, "Directory was not mounted");
    await storage.setDefault(mountId);
    const file = new File(
      ["uploaded content"],
      "uploaded.txt",
      { type: "text/plain" },
    );
    const uploaded = await manager.library.importFile(file);
    const info = await uploaded.cache.getInfo();
    assert(
      info?.isComplete && !info.storageUnavailable,
      `Upload unavailable: ${info?.storageUnavailable}`,
    );
    eq(await info.file!.text(), "uploaded content");
    eq(writers.get(file.name), 1);
    const listing = await storage.synchronizeDirectories();
    eq(listing.files.length, 1);
    eq(
      await (
        await (
          await handle.getFileHandle(file.name)
        ).getFile()
      ).text(),
      "uploaded content",
    );
    eq(await storage.database.all("files"), []);
    eq(await storage.database.all("checkpoints"), []);
    manager.dispose();
    permission = "prompt";
    setAppState("cache", {
      cacheInfo: {},
      caches: {},
      status: "loading",
      error: undefined,
    });
    storage = new FileStorageService(
      undefined,
      new VfsDatabase(databaseName),
    );
    manager = new FileCacheFactory(storage);
    await manager.initialize();
    eq(storage.defaultMountId, mountId);
    const reopened =
      appState.cache.cacheInfo[uploaded.cache.id];
    assert(
      reopened?.storageUnavailable &&
        !reopened.storageMissing,
      "Restored directory must require permission without treating its files as deleted",
    );
    let unavailable = false;
    try {
      await manager.library.importFile(file);
    } catch {
      unavailable = true;
    }
    assert(
      unavailable,
      "Permission loss did not reproduce the unavailable upload",
    );
    const before = requests;
    await storage.authorizeDefault();
    eq(requests, before + 1);
    const reused = await manager.library.importFile(file);
    assert(
      reused.reused,
      "Restored content was not reused after granting permission",
    );
    eq(
      await (await reused.cache.getFile())!.text(),
      "uploaded content",
    );
    const payload = new Uint8Array(
      32 * 1024 * 1024 + 17,
    ).fill(97);
    const second = await manager.library.importFile(
      new File([payload], file.name),
    );
    eq(writers.get("uploaded (1).txt"), 1);
    const secondFile = await (
      await handle.getFileHandle("uploaded (1).txt")
    ).getFile();
    eq(
      await fingerprintBlob(secondFile),
      await fingerprintBlob(new Blob([payload])),
    );
    eq(
      await (
        await (
          await handle.getFileHandle(file.name)
        ).getFile()
      ).text(),
      "uploaded content",
    );
    assert(
      (await second.cache.getInfo())?.isComplete,
      "Upload after reload is unavailable",
    );
    const previewFile = (await second.cache.getInfo())!
      .file;
    await manager.library.refresh();
    assert(
      (await second.cache.getInfo())!.file === previewFile,
      "Unchanged refresh replaced the preview file",
    );
    const secondRows = libraryFiles(
      Object.values(appState.cache.cacheInfo).filter(
        Boolean,
      ),
    );
    eq(secondRows.length, 2);
    // Exercise the real writable-stream abort and import cleanup while simulating
    // the browser's rejection; OPFS itself does not run external-directory scans.
    rejectCommit = true;
    let rejected: unknown;
    try {
      await manager.library.importFile(
        new File(["MZblocked"], "blocked.exe"),
      );
    } catch (error) {
      rejected = error;
    }
    assert(
      rejected instanceof DirectoryWriteError &&
        rejected.stage === "commit" &&
        rejected.detail ===
          "AbortError: Blocked by Safe Browsing.",
      "Browser save rejection lost its original error",
    );
    eq(
      await (
        await storage.getVolume(mountId)
      ).stat("blocked.exe"),
      null,
    );
    rejectCommit = false;
    await handle.removeEntry("uploaded (1).txt");
    window.dispatchEvent(new Event("focus"));
    const deadline = Date.now() + 10_000;
    while (
      !appState.cache.cacheInfo[second.cache.id]
        ?.storageMissing &&
      Date.now() < deadline
    )
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      );
    assert(
      appState.cache.cacheInfo[second.cache.id]
        ?.storageMissing,
      "Deleted upload was not synchronized",
    );
    assert(
      !libraryFiles(
        Object.values(appState.cache.cacheInfo).filter(
          Boolean,
        ),
      ).some((entry) => entry.id === second.cache.id),
      "Deleted upload remains in the cache list",
    );
    passed.push(
      "browser 32 MiB upload in one writable stream, permission recovery, collision-safe writes, stable previews, and deletion synchronization",
    );
  } finally {
    window.showDirectoryPicker = picker;
    FileSystemHandle.prototype.queryPermission =
      queryPermission;
    FileSystemHandle.prototype.requestPermission =
      requestPermission;
    FileSystemFileHandle.prototype.createWritable =
      createWritable;
    manager.dispose();
    await root.removeEntry(handle.name, {
      recursive: true,
    });
  }
}

async function checkBrowserEncodedNames(passed: string[]) {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle(
    `vfs-names-${crypto.randomUUID()}`,
    { create: true },
  );
  // OPFS permits these names. Model external-directory name rejection while
  // exercising real handles, streams, bytes and directory reconstruction.
  const granted = new Proxy(handle, {
    get(target, property) {
      if (
        property === "queryPermission" ||
        property === "requestPermission"
      )
        return async () => "granted";
      if (property === "getFileHandle")
        return async (
          name: string,
          options?: FileSystemGetFileOptions,
        ) => {
          if (/\.(dll|lnk)$/i.test(name))
            throw new TypeError(
              "Failed to execute 'getFileHandle' on 'FileSystemDirectoryHandle': Name is not allowed.",
            );
          return target.getFileHandle(name, options);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function"
        ? value.bind(target)
        : value;
    },
  });
  const directory = new DirectoryVolume(
    "native-default",
    "Encoded names",
    granted,
  );
  const services: FileStorageService[] = [];
  const caches: ChunkCache[] = [];
  const visible = new Map<string, ChunkCache>();
  const open = async () => {
    const storage = new FileStorageService(
      {
        volumes: async () => [directory],
        pickDirectory: async () => null,
        openDirectory: async () => {},
      },
      new VfsDatabase(`vfs-names-${crypto.randomUUID()}`),
    );
    services.push(storage);
    await storage.initialize();
    return storage;
  };
  let storage = await open();
  const make = async (id: string, existingOnly = false) => {
    const cache = await storage.createCache(id, {
      memoryChunks: 4,
      isRetained: () => false,
      existingOnly,
    });
    caches.push(cache);
    visible.set(cache.id, cache);
    return cache;
  };
  const library = new FileLibraryService({
    repository: new IndexedDbFileLibrary(
      `vfs-names-library-${crypto.randomUUID()}`,
    ),
    fingerprint: (file, options) =>
      fingerprintBlob(
        file,
        options?.onProgress,
        options?.signal,
      ),
    storage: make,
    getCache: (id) => visible.get(id) ?? null,
    publish: async (cache) => {
      visible.set(cache.id, cache);
      await cache.initialize();
    },
  });
  try {
    await library.initialize();
    for (const name of [
      "nppc64_12.dll",
      "IObit Unlocker.lnk",
    ]) {
      const imported = await library.importFile(
        new File([`bytes:${name}`], name),
      );
      eq((await imported.cache.getFile())!.name, name);
      const physical = encodeDirectoryFilename(name);
      eq(
        await (
          await (
            await handle.getFileHandle(physical)
          ).getFile()
        ).text(),
        `bytes:${name}`,
      );
    }
    const literal = encodeDirectoryFilename("literal.dll");
    await library.importFile(
      new File(["literal"], literal),
    );
    const encodedLiteral = encodeDirectoryFilename(literal);
    eq(
      await (
        await (
          await handle.getFileHandle(encodedLiteral)
        ).getFile()
      ).text(),
      "literal",
    );
    const partial = await make("encoded-receive");
    await partial.setInfo({
      fileName: "resume.dll",
      fileSize: 10,
      chunkSize: 4,
    });
    await partial.storeChunk(0, new Uint8Array(4).buffer);
    await partial.storeChunk(
      2,
      new Uint8Array([9, 10]).buffer,
    );
    await partial.flush();
    assert(
      (await directory.stat("resume.dll.weblink.part"))!
        .size > 10,
      "Receive has no temporary suffix",
    );
    eq(await directory.stat("resume.dll.weblink"), null);
    partial.dispose?.();
    storage.dispose();
    visible.clear();
    storage = await open();
    const listing = await storage.synchronizeDirectories();
    eq(listing.files.length, 4);
    for (const id of listing.files) {
      const cache = await make(id, true);
      const info = (await cache.getInfo())!;
      if (id === "encoded-receive") {
        eq(info.fileName, "resume.dll");
        eq(await cache.getReqRanges(), [1]);
        await cache.storeChunk(
          1,
          new Uint8Array([5, 6, 7, 8]).buffer,
        );
        const file = (await cache.getFile())!;
        eq(file.name, "resume.dll");
        eq(
          [...new Uint8Array(await file.arrayBuffer())],
          [0, 0, 0, 0, 5, 6, 7, 8, 9, 10],
        );
      } else {
        // This is the same library preparation used when sending a cache item.
        const prepared = await library.prepare(
          { kind: "library", localFileId: id },
          { roomAttachment: true },
        );
        const offered = (await prepared.getInfo())!;
        eq(offered.fileName, info.fileName);
        eq(offered.file!.name, info.fileName);
        assert(
          [
            "nppc64_12.dll",
            "IObit Unlocker.lnk",
            literal,
          ].includes(info.fileName),
          "Storage suffix leaked into transfer metadata",
        );
      }
    }
    eq(
      (await directory.stat(
        encodeDirectoryFilename("resume.dll"),
      ))!.size,
      10,
    );
    eq(await storage.database.all("files"), []);
    eq(await storage.database.all("checkpoints"), []);
    await directory.remove(
      encodeDirectoryFilename("nppc64_12.dll"),
    );
    eq(
      (await storage.synchronizeDirectories()).files.length,
      3,
    );
    passed.push(
      "browser encoded filenames, original transfer metadata, empty-index reconstruction, partial resume and deletion",
    );
  } finally {
    library.dispose();
    caches.forEach((cache) => cache.dispose?.());
    services.forEach((service) => service.dispose());
    await Promise.all(
      services.map((service) => service.database.close()),
    );
    await root.removeEntry(handle.name, {
      recursive: true,
    });
  }
}

async function main() {
  const db = new VfsDatabase(
    `vfs-browser-${crypto.randomUUID()}`,
  );
  const storage = new FileStorageService(undefined, db);
  const services = [storage];
  const passed: string[] = [];
  const caches: ChunkCache[] = [];
  const make = async (id: string) => {
    const cache = await storage.createCache(id, {
      memoryChunks: 4,
      isRetained: () => false,
    });
    caches.push(cache);
    await cache.initialize();
    return cache;
  };
  try {
    await checkBrowserUpload(passed);
    await checkBrowserEncodedNames(passed);
    await storage.initialize();
    eq(storage.defaultMountId, "indexeddb");
    const cache = await make(
      `receive-${crypto.randomUUID()}`,
    );
    const info = {
      fileName: "原始文件.bin",
      fileSize: 10,
      chunkSize: 4,
    };
    await cache.setInfo(info);
    eq(await cache.getReqRanges(), [[0, 2]]);
    await cache.storeChunk(
      2,
      new Uint8Array([9, 10]).buffer,
    );
    await cache.storeChunk(
      0,
      new Uint8Array([1, 2, 3, 4]).buffer,
    );
    await cache.flush();
    const resumed = new VfsChunkCache(cache.id, db, (id) =>
      storage.getVolume(id),
    );
    caches.push(resumed);
    await resumed.initialize();
    eq(await resumed.getReqRanges(), [1]);
    await resumed.storeChunk(
      1,
      new Uint8Array([5, 6, 7, 8]).buffer,
    );
    eq(
      [
        ...new Uint8Array(
          await (await resumed.getFile())!.arrayBuffer(),
        ),
      ],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    passed.push(
      "real IndexedDB out-of-order writes, preallocation and restart recovery",
    );

    const visible = new Map<string, ChunkCache>();
    const library = new FileLibraryService({
      repository: new IndexedDbFileLibrary(
        `vfs-library-${crypto.randomUUID()}`,
      ),
      fingerprint: (file, options) =>
        fingerprintBlob(
          file,
          options?.onProgress,
          options?.signal,
        ),
      storage: make,
      getCache: (id) => visible.get(id) ?? null,
      publish: async (cache) => {
        visible.set(cache.id, cache);
        await cache.initialize();
      },
    });
    await library.initialize();
    const imported = await library.importFile(
      new File(["snapshot"], "a.txt"),
    );
    const duplicate = await library.importFile(
      new File(["snapshot"], "b.txt"),
    );
    assert(
      duplicate.reused,
      "Content was not deduplicated",
    );
    eq(
      await (await imported.cache.getFile())!.text(),
      "snapshot",
    );
    library.dispose();
    passed.push(
      "VFS-backed library import, fingerprinting and shared content references",
    );

    // Real browser file streams via OPFS. Picker authorization remains a manual check.
    const root = await navigator.storage.getDirectory();
    const handle = await root.getDirectoryHandle(
      `vfs-test-${crypto.randomUUID()}`,
      { create: true },
    );
    const granted = new Proxy(handle, {
      get(target, property) {
        if (
          property === "queryPermission" ||
          property === "requestPermission"
        )
          return async () => "granted";
        const value = Reflect.get(target, property, target);
        return typeof value === "function"
          ? value.bind(target)
          : value;
      },
    });
    const directory = new DirectoryVolume(
      "directory-test",
      "Test",
      granted,
    );
    const id = `directory-${crypto.randomUUID()}`;
    const openDirectory = async () => {
      const service = new FileStorageService(
        {
          volumes: async () => [directory],
          pickDirectory: async () => null,
          openDirectory: async () => {},
        },
        new VfsDatabase(`directory-${crypto.randomUUID()}`),
      );
      services.push(service);
      await service.initialize();
      await service.setDefault(directory.id);
      return service;
    };
    const firstDirectory = await openDirectory();
    const receive = await firstDirectory.createCache(id, {
      memoryChunks: 4,
      isRetained: () => false,
    });
    caches.push(receive);
    await receive.initialize();
    await receive.setInfo(info);
    await receive.storeChunk(
      2,
      new Uint8Array([9, 10]).buffer,
    );
    await receive.flush();
    const path = info.fileName;
    assert(
      (await directory.stat(`${path}.part`))!.size > 10,
      "Partial file has no trailer",
    );
    eq(await firstDirectory.database.all("files"), []);
    eq(
      await firstDirectory.database.all("checkpoints"),
      [],
    );
    receive.dispose?.();
    firstDirectory.dispose();
    // A completely new database must recover only from directory bytes.
    const secondDirectory = await openDirectory();
    const restarted = await secondDirectory.createCache(
      id,
      {
        memoryChunks: 4,
        isRetained: () => false,
        existingOnly: true,
      },
    );
    caches.push(restarted);
    await restarted.initialize();
    eq(await restarted.getReqRanges(), [[0, 1]]);
    await restarted.storeChunk(
      0,
      new Uint8Array([1, 2, 3, 4]).buffer,
    );
    await restarted.storeChunk(
      1,
      new Uint8Array([5, 6, 7, 8]).buffer,
    );
    eq(
      [
        ...new Uint8Array(
          await (await restarted.getFile())!.arrayBuffer(),
        ),
      ],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    eq((await directory.stat(path))!.size, 10);
    eq(await directory.stat(`${path}.part`), null);
    eq(await secondDirectory.database.all("files"), []);
    eq(
      await secondDirectory.database.all("checkpoints"),
      [],
    );
    passed.push(
      "real file-stream checkpoints, resume from an empty database and trailer removal on completion",
    );
    let changes = 0;
    const stop = await directory.watch(() => changes++);
    // Allow the initial scan to finish before an external edit.
    await new Promise((resolve) =>
      setTimeout(resolve, 100),
    );
    await directory.commit(path, [
      { offset: 0, data: new Uint8Array([99]) },
    ]);
    window.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 50 && changes === 0; i++)
      await new Promise((resolve) =>
        setTimeout(resolve, 20),
      );
    assert(
      changes > 0,
      "Directory watch did not invalidate after external edit",
    );
    assert(
      (await restarted.getInfo())?.storageUnavailable,
      "Changed completed content was still available",
    );
    stop();
    passed.push(
      "directory change detection and stale content invalidation",
    );
    await directory.remove(path);

    const syncedStorage = new FileStorageService(
      {
        volumes: async () => [directory],
        pickDirectory: async () => null,
        openDirectory: async () => {},
      },
      new VfsDatabase(
        `directory-index-${crypto.randomUUID()}`,
      ),
    );
    try {
      await directory.commit(
        "nested/existing.txt",
        [
          {
            offset: 0,
            data: new TextEncoder().encode("before"),
          },
        ],
        6,
      );
      await syncedStorage.initialize();
      const initial =
        await syncedStorage.synchronizeDirectories();
      const external = initial.files;
      eq(external.length, 1);
      eq(initial.removed, []);
      const indexed = await syncedStorage.createCache(
        external[0],
        { memoryChunks: 4, isRetained: () => false },
      );
      caches.push(indexed);
      eq(await (await indexed.getFile())!.text(), "before");
      eq(
        (await syncedStorage.synchronizeDirectories())
          .files,
        initial.files,
      );
      await directory.commit(
        "nested/existing.txt",
        [
          {
            offset: 0,
            data: new TextEncoder().encode("changed"),
          },
        ],
        7,
      );
      const edited =
        await syncedStorage.synchronizeDirectories();
      const changed = edited.files;
      eq(changed.length, 1);
      assert(
        changed[0] !== external[0],
        "External changes reused an old file identity",
      );
      eq(edited.removed, external);
      assert(
        (await indexed.getInfo())?.storageUnavailable,
        "Old directory version stayed readable",
      );
      const updated = await syncedStorage.createCache(
        changed[0],
        { memoryChunks: 4, isRetained: () => false },
      );
      caches.push(updated);
      eq(
        await (await updated.getFile())!.text(),
        "changed",
      );
      await directory.remove("nested/existing.txt");
      const deleted =
        await syncedStorage.synchronizeDirectories();
      eq(deleted.files, []);
      assert(
        deleted.removed.includes(changed[0]),
        "External deletion was not synchronized",
      );
      passed.push(
        "direct recursive directory listing, stable IDs, external edits and deletion without an on-disk index",
      );
    } finally {
      syncedStorage.dispose();
    }
    await root.removeEntry(handle.name, {
      recursive: true,
    });
    window.__SPEED_TEST_REPORT__ = {
      ok: true,
      tests: passed.length,
      passed,
      storage:
        "real IndexedDB and OPFS file streams; picker permissions simulated",
    };
  } finally {
    caches.forEach((cache) => cache.dispose?.());
    services.forEach((service) => service.dispose());
  }
}
main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
