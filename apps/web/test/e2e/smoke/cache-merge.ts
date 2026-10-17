import { createStore } from "solid-js/store";
import type {
  ChunkCache,
  ChunkMetaData,
} from "@/libs/domain/file";
import type {
  ContentRecord,
  FileReference,
} from "@/libs/domain/file-library";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import { IndexedDbFileLibrary } from "@/libs/infrastructure/storage/indexeddb-file-library";
import { requestResult } from "@/libs/infrastructure/storage/indexeddb-helpers";
import { migrateLegacyIndexedDb } from "@/libs/infrastructure/storage/indexeddb-migration";
import { FileStorageService } from "@/libs/application/file-storage-service";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import { legacyDatabase } from "../../helpers/legacy-indexeddb";

const assert: (
  value: unknown,
  message: string,
) => asserts value = (value, message) => {
  if (!value) throw new Error(message);
};
const equal = (a: unknown, b: unknown) =>
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  );
const rejects = async (
  pending: Promise<unknown>,
  pattern?: RegExp,
) => {
  try {
    await pending;
  } catch (error) {
    if (pattern)
      assert(
        pattern.test(String(error)),
        `Unexpected error: ${error}`,
      );
    return;
  }
  throw new Error("Expected rejection");
};
const database = new VfsDatabase(
  `cache-vfs-smoke-${crypto.randomUUID()}`,
);
const storage = new FileStorageService(undefined, database);
const volume = new IndexedDbVolume(database);
const controller = new AbortController();
const caches: ChunkCache[] = [];
const completed: string[] = [];
const bytes = (index: number, size: number) =>
  new Uint8Array(size).fill(index + 1);
const info = {
  fileName: "cache.bin",
  fileSize: 19,
  chunkSize: 8,
  mimetype: "application/octet-stream",
  lastModified: 123,
};
async function cache(
  size = 19,
  chunkSize = 8,
  id: string = crypto.randomUUID(),
) {
  const value = await storage.createCache(id, {
    memoryChunks: 4,
    isRetained: () => false,
  });
  caches.push(value);
  await value.initialize();
  if (!(await value.getInfo()))
    await value.setInfo({
      ...info,
      fileSize: size,
      chunkSize,
    });
  return value;
}
async function verifyFile(
  file: import("@weblink/platform").StoredFile | null,
) {
  assert(file, "File missing");
  equal(
    [...new Uint8Array(await file.arrayBuffer())],
    [...bytes(0, 8), ...bytes(1, 8), ...bytes(2, 3)],
  );
  equal(
    [file.name, file.type, file.lastModified],
    [info.fileName, info.mimetype, info.lastModified],
  );
}
async function test(
  name: string,
  action: () => Promise<void>,
) {
  await action();
  completed.push(name);
}
const exists = async (id: string) =>
  (await indexedDB.databases()).some(
    (db) => db.name === `file-${id}`,
  );
const migrate = () =>
  migrateLegacyIndexedDb(
    database,
    controller.signal,
    () => {},
    volume,
  );
async function partial() {
  const id = crypto.randomUUID();
  (
    await legacyDatabase(id, info, [
      { chunkIndex: 0, data: bytes(0, 8).buffer },
      { chunkIndex: 2, data: new Blob([bytes(2, 3)]) },
    ])
  ).close();
  return id;
}
async function main() {
  try {
    await storage.initialize();
    await test("reactive metadata is snapshotted while file bytes use VFS pages", async () => {
      const value = await cache(7);
      const file = new File(["content"], "source.txt", {
        type: "text/plain",
        lastModified: 123,
      });
      const [metadata, setMetadata] =
        createStore<ChunkMetaData>({
          id: value.id,
          fileName: file.name,
          fileSize: file.size,
          file,
          fingerprint: {
            version: 1,
            algorithm: "blake3-256",
            digest: "a".repeat(64),
            size: file.size,
          },
          aliases: ["alias.txt"],
        });
      await rejects(
        Promise.resolve().then(() =>
          structuredClone({ ...metadata }),
        ),
        /clone/i,
      );
      const pending = value.setInfo({ ...metadata });
      setMetadata("fingerprint", "digest", "b".repeat(64));
      setMetadata("aliases", 0, "changed.txt");
      await pending;
      const saved = (await database.file(value.id))!.info!;
      equal(saved.fingerprint?.digest, "a".repeat(64));
      equal(saved.aliases, ["alias.txt"]);
      assert(
        !("file" in saved),
        "A whole File was persisted again",
      );
      equal(
        await (await value.getFile())?.text(),
        "content",
      );
    });
    await test("file library writes snapshot reactive content records and references", async () => {
      const name = `file-library-snapshot-${crypto.randomUUID()}`;
      const library = new IndexedDbFileLibrary(name);
      const fingerprint = {
        version: 1 as const,
        algorithm: "blake3-256" as const,
        digest: "a".repeat(64),
        size: 7,
      };
      const key = contentKey(fingerprint);
      const [record, setRecord] =
        createStore<ContentRecord>({
          key,
          fingerprint: { ...fingerprint },
          storageId: "storage-id",
          createdAt: 123,
          state: "pending",
        });
      const [reference, setReference] =
        createStore<FileReference>({
          id: "reference-id",
          contentKey: key,
          fingerprint: { ...fingerprint },
          fileName: "source.txt",
          fileSize: 7,
          aliases: ["alias.txt"],
        });
      try {
        const claiming = library.claim(record);
        setRecord("fingerprint", "digest", "b".repeat(64));
        equal(await claiming, true);
        equal(
          (await library.content(key))?.fingerprint,
          fingerprint,
        );
        equal(
          (await library.content(key))?.state,
          "pending",
        );
        equal(await library.claim(record), false);
        equal(
          (await library.content(key))?.fingerprint,
          fingerprint,
        );

        setRecord(
          "fingerprint",
          "digest",
          fingerprint.digest,
        );
        const committing = library.commit(
          { ...record },
          { ...reference },
        );
        setRecord("fingerprint", "digest", "b".repeat(64));
        setReference(
          "fingerprint",
          "digest",
          "b".repeat(64),
        );
        setReference("aliases", 0, "changed.txt");
        await committing;
        equal((await library.content(key))?.state, "ready");
        equal(
          (await library.content(key))?.fingerprint,
          fingerprint,
        );
        equal(
          (await library.reference(reference.id))
            ?.fingerprint,
          fingerprint,
        );
        equal(
          (await library.reference(reference.id))?.aliases,
          ["alias.txt"],
        );

        setReference(
          "fingerprint",
          "digest",
          fingerprint.digest,
        );
        setReference("aliases", 0, "updated.txt");
        const updating = library.putReference(reference);
        setReference(
          "fingerprint",
          "digest",
          "b".repeat(64),
        );
        setReference("aliases", 0, "changed-again.txt");
        await updating;
        equal(
          (await library.reference(reference.id))
            ?.fingerprint,
          fingerprint,
        );
        equal(
          (await library.reference(reference.id))?.aliases,
          ["updated.txt"],
        );
      } finally {
        // The repository closes its connection on versionchange.
        await requestResult(indexedDB.deleteDatabase(name));
      }
    });
    await test("VFS snapshots duplicate and out-of-order chunks with exact progress", async () => {
      const value = await cache();
      const data = bytes(0, 8);
      await value.storeChunk(0, data.buffer);
      data.fill(99);
      await value.storeChunk(2, bytes(2, 3).buffer);
      await value.flush();
      equal(await value.calcCachedBytes(), 11);
      equal(await value.getReqRanges(), [1]);
      equal(
        [...new Uint8Array((await value.getChunk(0))!)],
        [...bytes(0, 8)],
      );
      await value.storeChunk(0, bytes(0, 8).buffer);
      equal(await value.getChunkCount(), 2);
      await value.storeChunk(1, bytes(1, 8).buffer);
      await verifyFile(await value.getFile());
      equal(await value.getReqRanges(), []);
      assert(
        !(await database.file(
          value.id,
        ))!.info!.hasOwnProperty("file"),
        "VFS persisted another File",
      );
    });
    await test("migration retains partial mixed-format chunks and resumes with the original ID", async () => {
      const id = await partial();
      equal((await migrate())?.phase, "completed");
      equal(await exists(id), false);
      const value = await cache(19, 8, id);
      equal(await value.getReqRanges(), [1]);
      equal(await value.calcCachedBytes(), 11);
      await value.storeChunk(1, bytes(1, 8).buffer);
      await verifyFile(await value.getFile());
    });
    await test("completed legacy File preserves native metadata, is verified and removes the old database", async () => {
      const id = crypto.randomUUID();
      const file = new File(
        [bytes(0, 8), bytes(1, 8), bytes(2, 3)],
        info.fileName,
        {
          type: info.mimetype,
          lastModified: info.lastModified,
        },
      );
      // Old completed imports can store metadata only on the File itself.
      (
        await legacyDatabase(id, {
          fileName: file.name,
          fileSize: file.size,
          file,
        })
      ).close();
      equal((await migrate())?.phase, "completed");
      equal(await exists(id), false);
      await verifyFile(
        await (await cache(19, 8, id)).getFile(),
      );
    });
    await test("source sealing waits for old tabs and rejects subsequent old-format writes", async () => {
      const id = crypto.randomUUID();
      const old = await legacyDatabase(id, info, [
        { chunkIndex: 0, data: bytes(0, 8).buffer },
      ]);
      let waiting = false,
        checked = false,
        opening = false;
      try {
        const result = await migrateLegacyIndexedDb(
          database,
          controller.signal,
          (state) => {
            if (state.phase === "waiting") {
              waiting = true;
              old.close();
            }
            if (state.phase === "copying" && !opening) {
              opening = true;
              const request = indexedDB.open(`file-${id}`);
              request.onsuccess = () => {
                const connection = request.result;
                try {
                  connection.transaction(
                    "chunks",
                    "readwrite",
                  );
                } catch (error) {
                  checked =
                    error instanceof DOMException &&
                    error.name === "NotFoundError";
                } finally {
                  connection.close();
                }
              };
            }
          },
          volume,
        );
        equal(result?.phase, "completed");
        assert(
          waiting && checked,
          "Old format was not fenced",
        );
      } finally {
        old.close();
      }
    });
    await test("blocked deletion retains the verified copy and never reports early success", async () => {
      const id = await partial();
      let blocker: IDBDatabase | undefined;
      let opened = false,
        blocked = false;
      try {
        const result = await migrateLegacyIndexedDb(
          database,
          controller.signal,
          (state) => {
            if (state.phase === "deleting" && !opened) {
              opened = true;
              const request = indexedDB.open(`file-${id}`);
              request.onsuccess = () => {
                blocker = request.result;
              };
            }
            if (state.phase === "waiting") {
              blocked = true;
              equal(state.completedFiles, 0);
              blocker?.close();
            }
          },
          volume,
        );
        assert(blocked, "Deletion was not blocked");
        equal(result?.phase, "completed");
        equal(await exists(id), false);
        assert(
          await database.file(id),
          "Verified destination is missing",
        );
      } finally {
        blocker?.close();
      }
    });
    await test("aborted publication retains source and retries without duplicate destination", async () => {
      const id = await partial();
      const original = IDBObjectStore.prototype.add;
      let injected = false;
      IDBObjectStore.prototype.add = function (value, key) {
        const request =
          key === undefined
            ? original.call(this, value)
            : original.call(this, value, key);
        if (this.name === "files" && key === id) {
          request.addEventListener(
            "success",
            () => {
              injected = true;
              this.transaction.abort();
            },
            { once: true },
          );
        }
        return request;
      };
      try {
        equal((await migrate())?.phase, "failed");
      } finally {
        IDBObjectStore.prototype.add = original;
      }
      assert(
        injected,
        "Publication fault was not injected",
      );
      equal(await exists(id), true);
      equal(await database.file(id), undefined);
      equal((await migrate())?.phase, "completed");
      equal(await exists(id), false);
    });
    await test("readback corruption keeps source bytes and discards unpublished pages", async () => {
      const id = await partial();
      const read = volume.read.bind(volume);
      volume.read = async (...args) => {
        const data = await read(...args);
        new Uint8Array(data)[0] ^= 255;
        return data;
      };
      try {
        equal((await migrate())?.phase, "failed");
      } finally {
        volume.read = read;
      }
      equal(await exists(id), true);
      equal(await database.file(id), undefined);
      equal((await migrate())?.phase, "completed");
      equal(await exists(id), false);
    });
  } finally {
    for (const value of caches.reverse()) {
      await value.cleanup();
      value.dispose?.();
    }
    controller.abort();
    storage.dispose();
    await database.close();
  }
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    tests: completed.length,
    passed: completed,
    storage:
      "real IndexedDB VFS and verified legacy migration",
  };
}
main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
