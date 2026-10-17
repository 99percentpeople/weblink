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
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import { VfsChunkCache } from "@/libs/infrastructure/vfs/chunk-cache";
import { migrateLegacyIndexedDb } from "@/libs/infrastructure/storage/indexeddb-migration";
import { openLegacySource } from "@/libs/infrastructure/storage/legacy-indexeddb-source";
import { requestResult } from "@/libs/infrastructure/storage/indexeddb-helpers";
import { legacyDatabase } from "../helpers/legacy-indexeddb";
import type { StorageMigrationProgress } from "@/libs/domain/storage-migration";
import { FileStorageService } from "@/libs/application/file-storage-service";
import { FileLibraryService } from "@/libs/application/file-library-service";
import { IndexedDbFileLibrary } from "@/libs/infrastructure/storage/indexeddb-file-library";
import { fingerprintBlob } from "@/libs/infrastructure/storage/fingerprint";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import type { ChunkCache } from "@/libs/domain/file";

let database: VfsDatabase;
let volume: IndexedDbVolume;
let controller: AbortController;
const closes: (() => void)[] = [];
const info = {
  fileName: "old.bin",
  fileSize: 10,
  chunkSize: 4,
  lastModified: 123,
  mimetype: "application/test",
  aliases: ["original.bin"],
  sharedReference: true,
};
const bytes = (...values: number[]) =>
  new Uint8Array(values).buffer;
beforeEach(() => {
  vi.stubGlobal("File", NodeFile);
  database = new VfsDatabase(
    `migration-test-${crypto.randomUUID()}`,
  );
  volume = new IndexedDbVolume(database);
  controller = new AbortController();
});
afterEach(async () => {
  controller.abort();
  closes.splice(0).forEach((close) => close());
  vi.restoreAllMocks();
  await database.close();
  for (const { name } of await indexedDB.databases())
    if (name)
      await requestResult(indexedDB.deleteDatabase(name));
  vi.unstubAllGlobals();
});
const run = (
  progress = (_: StorageMigrationProgress) => {},
) =>
  migrateLegacyIndexedDb(
    database,
    controller.signal,
    progress,
    volume,
  );
async function old(
  id = crypto.randomUUID(),
  metadata = info,
  chunks = [
    {
      chunkIndex: 0,
      data: bytes(1, 2, 3, 4) as Blob | ArrayBuffer,
    },
    {
      chunkIndex: 2,
      data: new Blob([bytes(9, 10)]) as Blob | ArrayBuffer,
    },
  ],
) {
  const db = await legacyDatabase(id, metadata, chunks);
  db.close();
  return id;
}
const names = async () =>
  (await indexedDB.databases()).map((db) => db.name);
async function cache(id: string) {
  const value = new VfsChunkCache(
    id,
    database,
    async () => volume,
    () => false,
  );
  await value.initialize();
  closes.push(() => value.dispose());
  return value;
}

describe("verified legacy IndexedDB migration", () => {
  it("preserves native File metadata and supplies chunk size for old completed imports", async () => {
    const id = crypto.randomUUID();
    const file = new File(["data"], "old.txt", {
      type: "text/plain",
      lastModified: 321,
    });
    (
      await legacyDatabase(id, {
        fileName: file.name,
        fileSize: file.size,
        file,
      })
    ).close();
    expect((await run())?.phase).toBe("completed");
    const value = await cache(id);
    const saved = await value.getFile();
    expect([saved?.type, saved?.lastModified]).toEqual([
      file.type,
      file.lastModified,
    ]);
    expect(
      new TextDecoder().decode((await value.getChunk(0))!),
    ).toBe("data");
  });

  it("migrates into IndexedDB even when desktop defaults to a native directory", async () => {
    const id = await old();
    const storage = new FileStorageService(
      {
        volumes: async () => [],
        pickDirectory: async () => null,
        openDirectory: async () => {},
      },
      database,
    );
    closes.push(() => storage.dispose());
    await storage.initialize();
    expect(storage.defaultMountId).toBe("native-default");
    expect((await database.file(id))?.mountId).toBe(
      "indexeddb",
    );
    expect(await names()).not.toContain(`file-${id}`);
  });

  it("preserves the source if the destination changes after readback but before publication", async () => {
    const id = await old();
    const stat = volume.stat.bind(volume);
    let reads = 0;
    vi.spyOn(volume, "stat").mockImplementation(
      async (path) => {
        const result = await stat(path);
        if (++reads === 2)
          await volume.commit(path, [
            { offset: 0, data: new Uint8Array([99]) },
          ]);
        return result;
      },
    );
    expect((await run())?.failures[0].error).toContain(
      "changed before publication",
    );
    expect(await names()).toContain(`file-${id}`);
    expect(await database.file(id)).toBeUndefined();
  });

  it("copies a completed File through pages, preserving identity and metadata without persisting another File", async () => {
    const data = new Uint8Array(4 * 1024 * 1024 + 17).fill(
      37,
    );
    const file = new File([data], info.fileName, {
      lastModified: 123,
      type: info.mimetype,
    });
    const id = crypto.randomUUID();
    (
      await legacyDatabase(id, {
        ...info,
        fileSize: file.size,
        file,
      })
    ).close();
    const stages: string[] = [];
    const result = await run((state) =>
      stages.push(state.phase),
    );
    expect(result?.phase).toBe("completed");
    expect(stages).toContain("verifying");
    expect(stages.indexOf("deleting")).toBeGreaterThan(
      stages.indexOf("verifying"),
    );
    expect(await names()).not.toContain(`file-${id}`);
    const migrated = await database.file(id);
    expect(migrated).toMatchObject({
      id,
      mountId: "indexeddb",
      complete: true,
      info: { ...info, id, fileSize: file.size },
    });
    expect(migrated?.info).not.toHaveProperty("file");
    const saved = await (await cache(id)).getFile();
    expect(saved?.size).toBe(file.size);
    expect(
      Buffer.from(await saved!.arrayBuffer()).equals(data),
    ).toBe(true);
    expect([
      saved?.name,
      saved?.type,
      saved?.lastModified,
    ]).toEqual([info.fileName, info.mimetype, 123]);
  });

  it("keeps mixed Blob/ArrayBuffer chunks, holes and original resume identity across reopen", async () => {
    const id = await old();
    expect((await run())?.completedFiles).toBe(1);
    await database.close();
    const value = await cache(id);
    expect(await value.getReqRanges()).toEqual([1]);
    expect(await value.calcCachedBytes()).toBe(6);
    expect(
      new Uint8Array((await value.getChunk(2))!),
    ).toEqual(new Uint8Array([9, 10]));
    expect(await value.getFile()).toBeNull();
    await value.storeChunk(1, bytes(5, 6, 7, 8));
    await value.flush();
    expect(
      new Uint8Array(
        await (await value.getFile())!.arrayBuffer(),
      ),
    ).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
  });

  it("migrates zero-length files and metadata-only partial files without treating reserved length as progress", async () => {
    const empty = await old(
      crypto.randomUUID(),
      { ...info, fileSize: 0 },
      [],
    );
    const pending = await old(
      crypto.randomUUID(),
      info,
      [],
    );
    expect((await run())?.completedFiles).toBe(2);
    expect(
      (await (await cache(empty)).getFile())?.size,
    ).toBe(0);
    const value = await cache(pending);
    expect(await value.getChunkCount()).toBe(0);
    expect(await value.calcCachedBytes()).toBe(0);
    expect(await value.getFile()).toBeNull();
    expect(await value.getReqRanges()).toEqual([[0, 2]]);
  });

  it("removes an empty abandoned legacy database", async () => {
    const id = crypto.randomUUID();
    (await legacyDatabase(id, null)).close();
    expect((await run())?.completedFiles).toBe(1);
    expect(await database.file(id)).toBeUndefined();
    expect(await names()).not.toContain(`file-${id}`);
  });

  it("retains invalid legacy data and migrates other files", async () => {
    const bad = await old(crypto.randomUUID(), info, [
      { chunkIndex: 0, data: new Blob(["bad"]) },
    ]);
    const good = await old();
    const result = await run();
    expect(result?.phase).toBe("failed");
    expect(result?.completedFiles).toBe(1);
    expect(result?.failures[0]).toMatchObject({
      id: bad,
      error: "Error: Invalid legacy chunk 0",
    });
    expect(await names()).toContain(`file-${bad}`);
    expect(await names()).not.toContain(`file-${good}`);
    expect(await database.file(bad)).toBeUndefined();
  });

  it("keeps the source on quota failure and retries the sealed database on next startup", async () => {
    const id = await old();
    const commit = vi
      .spyOn(volume, "commit")
      .mockRejectedValueOnce(
        new DOMException("Disk full", "QuotaExceededError"),
      );
    expect((await run())?.failures[0].error).toContain(
      "QuotaExceededError",
    );
    expect(await names()).toContain(`file-${id}`);
    expect(await database.file(id)).toBeUndefined();
    commit.mockRestore();
    expect((await run())?.phase).toBe("completed");
    expect(await names()).not.toContain(`file-${id}`);
  });

  it("does not publish or delete the source if readback bytes differ", async () => {
    const id = await old();
    const read = volume.read.bind(volume);
    vi.spyOn(volume, "read").mockImplementation(
      async (...args) => {
        const data = await read(...args);
        new Uint8Array(data)[0] ^= 255;
        return data;
      },
    );
    expect((await run())?.failures[0].error).toContain(
      "checksum mismatch",
    );
    expect(await names()).toContain(`file-${id}`);
    expect(await database.file(id)).toBeUndefined();
    expect(await database.all("nodes")).toEqual([]);
    expect(await database.all("pages")).toEqual([]);
    const source = await openLegacySource(
      `file-${id}`,
      controller.signal,
      () => {},
    );
    expect(
      await (await source!.chunk(0)).arrayBuffer(),
    ).toEqual(bytes(1, 2, 3, 4));
    source!.close();
  });

  it("rejects a completed file that disagrees with its persisted fingerprint", async () => {
    const id = crypto.randomUUID();
    (
      await legacyDatabase(id, {
        ...info,
        fileSize: 4,
        file: new File(["data"], "old.bin"),
        fingerprint: {
          version: 1,
          algorithm: "blake3-256",
          size: 4,
          digest: "0".repeat(64),
        },
      })
    ).close();
    expect((await run())?.failures[0].error).toContain(
      "checksum mismatch",
    );
    expect(await names()).toContain(`file-${id}`);
    expect(await database.file(id)).toBeUndefined();
  });

  it("waits for publication transaction completion, not the add request success", async () => {
    const id = await old();
    const original = IDBObjectStore.prototype.add;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, "add")
      .mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        const request = original.call(this, value, key);
        if (this.name === "files")
          request.addEventListener(
            "success",
            () => this.transaction.abort(),
            { once: true },
          );
        return request;
      });
    expect((await run())?.phase).toBe("failed");
    expect(await names()).toContain(`file-${id}`);
    expect(await database.file(id)).toBeUndefined();
    expect(await database.all("checkpoints")).toEqual([]);
    expect(await database.all("pages")).toEqual([]);
    spy.mockRestore();
    expect((await run())?.phase).toBe("completed");
  });

  it("reuses a published copy after interrupted deletion without losing newly received chunks", async () => {
    const id = await old();
    const remove = vi
      .spyOn(indexedDB, "deleteDatabase")
      .mockImplementationOnce(() => {
        throw new Error("Deletion interrupted");
      });
    expect((await run())?.phase).toBe("failed");
    const before = (await database.file(id))!;
    const value = await cache(id);
    await value.storeChunk(1, bytes(5, 6, 7, 8));
    await value.flush();
    remove.mockRestore();
    expect((await run())?.phase).toBe("completed");
    expect((await database.file(id))?.path).toBe(
      before.path,
    );
    expect(await value.calcCachedBytes()).toBe(10);
    expect(await names()).not.toContain(`file-${id}`);
  });

  it("reports blocked old connections and prevents old clients from writing after sealing", async () => {
    const id = crypto.randomUUID();
    const connection = await legacyDatabase(id, info, [
      { chunkIndex: 0, data: bytes(1, 2, 3, 4) },
    ]);
    closes.push(() => connection.close());
    let waiting = 0;
    let sealed = false;
    const result = await run((state) => {
      if (state.phase === "waiting") {
        waiting++;
        connection.close();
      }
      if (state.phase === "copying") {
        expect(() =>
          connection.transaction("chunks", "readwrite"),
        ).toThrow();
        sealed = true;
      }
    });
    expect(waiting).toBeGreaterThan(0);
    expect(sealed).toBe(true);
    expect(result?.phase).toBe("completed");
  });

  it("does not report completion while deletion is blocked", async () => {
    const id = await old();
    let blocker: IDBDatabase | undefined;
    let waiting = false;
    let opened = false;
    const result = await run((state) => {
      if (state.phase === "deleting" && !opened) {
        opened = true;
        const request = indexedDB.open(`file-${id}`);
        request.onsuccess = () => {
          blocker = request.result;
          closes.push(() => blocker?.close());
        };
      }
      if (state.phase === "waiting") {
        waiting = true;
        expect(state.completedFiles).toBe(0);
        blocker?.close();
      }
    });
    expect(waiting).toBe(true);
    expect(result?.phase).toBe("completed");
    expect(await names()).not.toContain(`file-${id}`);
  });

  it("interruption before publication preserves the source and cleans staging pages", async () => {
    const id = await old();
    await expect(
      run((state) => {
        if (state.phase === "verifying") controller.abort();
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await names()).toContain(`file-${id}`);
    expect(await database.file(id)).toBeUndefined();
    expect(await database.all("pages")).toEqual([]);
  });

  it("never overwrites an unrelated destination with the same ID", async () => {
    const id = await old();
    await database.put("files", id, {
      id,
      mountId: "indexeddb",
      path: "original",
      info,
      chunks: {},
      complete: false,
    });
    expect((await run())?.failures[0].error).toContain(
      "different file",
    );
    expect((await database.file(id))?.path).toBe(
      "original",
    );
    expect(await names()).toContain(`file-${id}`);
  });

  it("cleans abandoned staging data and serializes concurrent migrations", async () => {
    const id = await old();
    const abandoned = `Legacy migration/${id}/abandoned`;
    await volume.commit(
      abandoned,
      [{ offset: 0, data: new Uint8Array([99]) }],
      10,
    );
    const [a, b] = await Promise.all([run(), run()]);
    expect(a?.phase).toBe("completed");
    expect(b?.phase).toBe("completed");
    expect(await volume.stat(abandoned)).toBeNull();
    expect((await database.all("files")).length).toBe(1);
    expect(await names()).not.toContain(`file-${id}`);
  });

  it("runs automatically before exposing caches and replays progress to a late UI subscriber", async () => {
    const id = await old();
    const storage = new FileStorageService(
      undefined,
      database,
    );
    closes.push(() => storage.dispose());
    await storage.initialize();
    expect(await storage.list()).toEqual([id]);
    const states: StorageMigrationProgress[] = [];
    const stop = storage.onMigrationProgress((state) =>
      states.push(state),
    );
    expect(states[0].phase).toBe("completed");
    stop();
    const value = await storage.createCache(id, {
      memoryChunks: 4,
      isRetained: () => false,
    });
    expect(value).toBeInstanceOf(VfsChunkCache);
    value.dispose?.();
  });

  it("does not notify or create an old database when there is nothing to migrate", async () => {
    const notify = vi.fn();
    expect(await run(notify)).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    const missing = await openLegacySource(
      "file-missing",
      controller.signal,
      () => {},
    );
    expect(missing).toBeNull();
    expect(await names()).not.toContain("file-missing");
  });

  it.each([false, true])(
    "preserves chat and shared references when migration failure is %s",
    async (fail) => {
      const id = crypto.randomUUID();
      const file = new File(["data"], info.fileName);
      const fingerprint = await fingerprintBlob(file);
      const key = contentKey(fingerprint);
      (
        await legacyDatabase(id, {
          ...info,
          fileSize: 4,
          file,
          fingerprint,
        })
      ).close();
      const repository = new IndexedDbFileLibrary(
        `migration-library-${id}`,
      );
      const reference = {
        id: "chat-attachment",
        contentKey: key,
        fingerprint,
        fileName: "chat-name.bin",
        fileSize: 4,
        chunkSize: 4,
      };
      await repository.commit(
        {
          key,
          fingerprint,
          storageId: id,
          createdAt: 123,
          state: "ready",
          isShared: true,
          sharedReferenceId: "shared-copy",
        },
        reference,
      );
      await repository.putReference({
        ...reference,
        id: "shared-copy",
        sharedReference: true,
        libraryPinned: true,
      });
      if (fail)
        vi.spyOn(
          IndexedDbVolume.prototype,
          "commit",
        ).mockRejectedValueOnce(
          new DOMException(
            "Disk full",
            "QuotaExceededError",
          ),
        );
      const storage = new FileStorageService(
        undefined,
        database,
      );
      closes.push(() => storage.dispose());
      await storage.initialize();
      const published = new Map<string, ChunkCache>();
      const library = new FileLibraryService({
        repository,
        fingerprint: (source) => fingerprintBlob(source),
        storage: async (storageId, existingOnly) => {
          const value = await storage.createCache(
            storageId,
            {
              memoryChunks: 4,
              isRetained: () => true,
              existingOnly,
            },
          );
          closes.push(() => value.dispose?.());
          await value.initialize();
          return value;
        },
        getCache: (referenceId) =>
          published.get(referenceId) ?? null,
        publish: async (value) => {
          published.set(value.id, value);
          await value.initialize();
        },
      });
      closes.push(() => library.dispose());
      await library.initialize();
      await repository.putReference({
        ...reference,
        id: "local-pin",
        libraryPinned: true,
      });
      await storage.synchronize();
      await library.reconcileMissingFiles();
      expect(
        await repository.reference("local-pin"),
      ).toBeDefined();
      await repository.removeReference("local-pin");
      if (fail) {
        expect(
          (
            await published
              .get("chat-attachment")!
              .getInfo()
          )?.storageUnavailable,
        ).toContain("migration failed");
        expect(
          (
            await published
              .get("chat-attachment")!
              .getInfo()
          )?.storageMissing,
        ).toBe(false);
        expect(await library.hasContent(fingerprint)).toBe(
          false,
        );
        expect(await names()).toContain(`file-${id}`);
      } else {
        expect(
          await (await published
            .get("chat-attachment")!
            .getFile())!.text(),
        ).toBe("data");
        expect(
          (await library.sharedFiles()).map(
            (value) => value.id,
          ),
        ).toEqual(["shared-copy"]);
        expect(
          (
            await published
              .get("chat-attachment")!
              .getFile()
          )?.name,
        ).toBe("chat-name.bin");
        expect(await names()).not.toContain(`file-${id}`);
      }
      expect(await repository.content(key)).toMatchObject({
        storageId: id,
        isShared: true,
      });
      expect(
        (await repository.references())
          .map((ref) => ref.id)
          .sort(),
      ).toEqual(["chat-attachment", "shared-copy"]);
    },
  );
});
