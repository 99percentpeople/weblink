import {
  IDBChunkCache,
  type IDBChunkCacheOptions,
} from "../../src/libs/cache/chunk-cache";
import {
  assembleCachedFile,
  requestResult,
  transactionDone,
  type StoredChunk,
} from "../../src/libs/cache/chunk-assembly";
import MergeWorker from "../../src/libs/workers/merge-chunk?worker";
import type { ChunkMetaData } from "../../src/libs/cache";

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
const caches: IDBChunkCache[] = [];
const completed: string[] = [];
async function cache(
  size = 19,
  chunkSize = 8,
  options: Partial<IDBChunkCacheOptions> = {},
) {
  const value = new IDBChunkCache({
    id: crypto.randomUUID(),
    maxMomeryCacheSize: 4,
    ...options,
  });
  caches.push(value);
  await value.initialize();
  await value.setInfo({
    id: value.id,
    fileName: "cache.bin",
    fileSize: size,
    chunkSize,
    mimetype: "application/octet-stream",
    lastModified: 123,
  });
  return value;
}
const bytes = (index: number, size: number) =>
  new Uint8Array(size).fill(index + 1);
async function populate(value: IDBChunkCache) {
  // Deliberately deliver out of order.
  await value.storeChunk(2, bytes(2, 3).buffer);
  await value.storeChunk(0, bytes(0, 8).buffer);
  await value.storeChunk(1, bytes(1, 8).buffer);
  await value.flush();
}
async function database<T>(
  value: IDBChunkCache,
  action: (db: IDBDatabase) => Promise<T>,
): Promise<T> {
  const db = await requestResult(
    indexedDB.open(`file-${value.id}`),
  );
  try {
    return await action(db);
  } finally {
    db.close();
  }
}
async function read(value: IDBChunkCache) {
  return database(value, async (db) => {
    const transaction = db.transaction(
      ["info", "chunks"],
      "readonly",
    );
    const [info, chunks] = await Promise.all([
      requestResult<ChunkMetaData>(
        transaction.objectStore("info").get(value.id),
      ),
      requestResult<StoredChunk[]>(
        transaction.objectStore("chunks").getAll(),
      ),
      transactionDone(transaction),
    ]);
    return { info, chunks };
  });
}
async function put(
  value: IDBChunkCache,
  records: StoredChunk[],
) {
  await database(value, async (db) => {
    const transaction = db.transaction(
      "chunks",
      "readwrite",
    );
    const done = transactionDone(transaction);
    for (const record of records)
      transaction.objectStore("chunks").put(record);
    await done;
  });
}
async function verifyFile(file: File | null) {
  assert(file, "File missing");
  equal(
    [...new Uint8Array(await file.arrayBuffer())],
    [...bytes(0, 8), ...bytes(1, 8), ...bytes(2, 3)],
  );
  equal(
    [file.name, file.type, file.lastModified],
    ["cache.bin", "application/octet-stream", 123],
  );
}
async function test(
  name: string,
  action: () => Promise<void>,
) {
  await action();
  completed.push(name);
}

async function main() {
  try {
    await test("Blob storage, snapshot, duplicate count and ordered assembly", async () => {
      const value = await cache();
      const input = bytes(0, 8);
      await value.storeChunk(0, input.buffer);
      input.fill(100);
      await value.storeChunk(0, bytes(0, 8).buffer);
      equal(
        [...new Uint8Array((await value.getChunk(0))!)],
        [...bytes(0, 8)],
      );
      equal(await value.getChunkCount(), 1);
      await populate(value);
      assert(
        (await read(value)).chunks.every(
          (chunk) => chunk.data instanceof Blob,
        ),
        "New records are not Blobs",
      );
      await verifyFile(await value.getFile());
      equal((await read(value)).chunks.length, 0);
      equal(await value.getReqRanges(), []);
      equal(await value.calcCachedBytes(), 19);
      await value.storeChunk(0, bytes(0, 8).buffer); // late duplicate
      equal(await value.getChunkCount(), 0);
    });
    await test("single-flight merge and one completion after transaction commit", async () => {
      const value = await cache();
      await populate(value);
      let completions = 0,
        merges = 0;
      value.addEventListener(
        "complete",
        () => completions++,
      );
      value.addEventListener("merging", () => merges++);
      const first = value.getFile(),
        second = value.getFile(),
        third = value.mergeFile();
      assert(
        first === second && second === third,
        "Concurrent callers do not share the same Promise",
      );
      const [a, b] = await Promise.all([first, second]);
      assert(
        a === b,
        "Concurrent callers got different File instances",
      );
      equal([completions, merges], [1, 1]);
      const saved = await read(value);
      assert(
        saved.info.file && saved.chunks.length === 0,
        "getFile resolved before the final transaction committed",
      );
      await value.getFile();
      equal([completions, merges], [1, 1]);
      equal((await value.getInfo())?.isMerging, false);
    });
    await test("legacy ArrayBuffer and mixed Blob records survive reopen", async () => {
      const value = await cache();
      await put(value, [
        { chunkIndex: 0, data: bytes(0, 8).buffer },
        { chunkIndex: 1, data: new Blob([bytes(1, 8)]) },
        { chunkIndex: 2, data: bytes(2, 3).buffer },
      ]);
      const reopened = new IDBChunkCache({
        id: value.id,
        maxMomeryCacheSize: 4,
      });
      caches.push(reopened);
      await reopened.initialize();
      equal(
        [...new Uint8Array((await reopened.getChunk(1))!)],
        [...bytes(1, 8)],
      );
      await verifyFile(await reopened.getFile());
      const again = new IDBChunkCache({
        id: value.id,
        maxMomeryCacheSize: 4,
      });
      caches.push(again);
      await again.initialize();
      await verifyFile(await again.getFile());
    });
    await test("two cache instances serialize final commits", async () => {
      const a = await cache();
      await populate(a);
      const b = new IDBChunkCache({
        id: a.id,
        maxMomeryCacheSize: 4,
      });
      caches.push(b);
      await b.initialize();
      await Promise.all([a.getFile(), b.getFile()]).then(
        (files) => Promise.all(files.map(verifyFile)),
      );
      equal(
        [
          a.mergeMetrics?.chunks,
          b.mergeMetrics?.chunks,
        ].sort((x, y) => x! - y!),
        [0, 3],
      );
      equal((await read(a)).chunks.length, 0);
    });
    await test("missing chunks retain data and can be retried", async () => {
      const value = await cache();
      await value.storeChunk(0, bytes(0, 8).buffer);
      await value.storeChunk(2, bytes(2, 3).buffer);
      await rejects(value.getFile(), /incomplete/);
      const saved = await read(value);
      assert(
        !saved.info.file && saved.chunks.length === 2,
        "Failed merge destroyed partial data",
      );
      equal((await value.getInfo())?.isMerging, false);
      await value.storeChunk(1, bytes(1, 8).buffer);
      await verifyFile(await value.getFile());
    });
    await test("invalid lengths and invalid indices never produce a file", async () => {
      const value = await cache();
      await populate(value);
      await put(value, [
        { chunkIndex: 1, data: new Blob(["bad"]) },
      ]);
      await rejects(value.getFile(), /length/);
      assert(
        !(await read(value)).info.file,
        "Invalid data committed",
      );
      await put(value, [
        { chunkIndex: 1, data: bytes(1, 8).buffer },
      ]);
      await verifyFile(await value.getFile());
      await rejects(
        cache().then((c) =>
          c.storeChunk(-1, new ArrayBuffer(8)),
        ),
        /index/,
      );
    });
    await test("empty file and exact-multiple byte counts", async () => {
      const empty = await cache(0);
      equal((await empty.getFile())?.size, 0);
      equal(await empty.calcCachedBytes(), 0);
      const exact = await cache(16);
      await exact.storeChunk(0, bytes(0, 8).buffer);
      await exact.storeChunk(1, bytes(1, 8).buffer);
      equal(await exact.calcCachedBytes(), 16);
      equal((await exact.getFile())?.size, 16);
    });
    await test("File put succeeds then transaction aborts: neither put nor clear commits", async () => {
      const value = await cache();
      await populate(value);
      const original = IDBObjectStore.prototype.put;
      let requestSucceeded = false;
      IDBObjectStore.prototype.put = function (
        record,
        key,
      ) {
        const request =
          key === undefined
            ? original.call(this, record)
            : original.call(this, record, key);
        if (this.name === "info" && record.file) {
          const transaction = this.transaction;
          request.addEventListener(
            "success",
            () => {
              requestSucceeded = true;
              transaction.abort();
            },
            { once: true },
          );
        }
        return request;
      };
      try {
        await rejects(
          database(value, (db) =>
            assembleCachedFile(db, value.id),
          ),
        );
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      assert(
        requestSucceeded,
        "Fault injection did not run",
      );
      const saved = await read(value);
      assert(
        !saved.info.file && saved.chunks.length === 3,
        "Abort did not roll back both stores",
      );
      await verifyFile(await value.getFile());
    });
    await test("clear failure rolls back the already queued final File write", async () => {
      const value = await cache();
      await populate(value);
      const original = IDBObjectStore.prototype.clear;
      IDBObjectStore.prototype.clear = function () {
        throw new Error("injected clear failure");
      };
      try {
        await rejects(
          database(value, (db) =>
            assembleCachedFile(db, value.id),
          ),
          /clear failure/,
        );
      } finally {
        IDBObjectStore.prototype.clear = original;
      }
      const saved = await read(value);
      assert(
        !saved.info.file && saved.chunks.length === 3,
        "Clear failure lost original chunks",
      );
      await verifyFile(await value.getFile());
    });
    await test("failed flush restores the buffered batch for retry", async () => {
      const value = await cache();
      await value.storeChunk(0, bytes(0, 8).buffer);
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () {
        throw new Error("injected disk failure");
      };
      try {
        await rejects(value.flush(), /disk failure/);
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      equal((await read(value)).chunks.length, 0);
      await value.flush();
      equal(await value.getChunkCount(), 1);
      equal(
        [...new Uint8Array((await value.getChunk(0))!)],
        [...bytes(0, 8)],
      );
    });
    await test("aborted flush keeps a newer replacement rather than restoring stale bytes", async () => {
      const value = await cache();
      await value.storeChunk(0, bytes(0, 8).buffer);
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        record,
        key,
      ) {
        const request =
          key === undefined
            ? original.call(this, record)
            : original.call(this, record, key);
        if (this.name === "chunks") {
          const transaction = this.transaction;
          request.addEventListener(
            "success",
            () => {
              void value.storeChunk(0, bytes(8, 8).buffer);
              transaction.abort();
            },
            { once: true },
          );
        }
        return request;
      };
      try {
        await rejects(value.flush());
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      await value.flush();
      equal(
        [...new Uint8Array((await value.getChunk(0))!)],
        [...bytes(8, 8)],
      );
      equal(await value.getChunkCount(), 1);
    });
    await test("overlapping flushes wait for all committed chunks", async () => {
      const value = await cache();
      await value.storeChunk(0, bytes(0, 8).buffer);
      const first = value.flush();
      await value.storeChunk(1, bytes(1, 8).buffer);
      const second = value.flush();
      await value.storeChunk(2, bytes(2, 3).buffer);
      await Promise.all([first, second, value.flush()]);
      equal((await read(value)).chunks.length, 3);
      await verifyFile(await value.getFile());
    });
    await test("worker startup failure can retry without losing data", async () => {
      let attempts = 0,
        terminated = 0;
      const value = await cache(19, 8, {
        createMergeWorker: () => {
          if (attempts++) return new MergeWorker();
          const worker = {
            onerror: null as
              | ((event: ErrorEvent) => void)
              | null,
            terminate: () => {
              terminated++;
            },
            postMessage: () =>
              queueMicrotask(() =>
                worker.onerror?.(
                  new ErrorEvent("error", {
                    message:
                      "injected worker startup failure",
                    cancelable: true,
                  }),
                ),
              ),
          };
          return worker as unknown as Worker;
        },
      });
      await populate(value);
      await rejects(value.getFile(), /startup failure/);
      equal(terminated, 1);
      equal((await value.getInfo())?.isMerging, false);
      await verifyFile(await value.getFile());
    });
    await test("cleanup cancels an in-flight worker without late completion", async () => {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let terminated = 0,
        completions = 0;
      const value = await cache(19, 8, {
        createMergeWorker: () =>
          ({
            postMessage: () => started(),
            terminate: () => {
              terminated++;
            },
          }) as unknown as Worker,
      });
      await populate(value);
      value.addEventListener(
        "complete",
        () => completions++,
      );
      const pending = rejects(value.getFile(), /deleted/);
      await ready;
      await value.cleanup();
      await pending;
      equal([terminated, completions], [1, 0]);
    });
    await test("bulk reads cross batch boundaries without reordering", async () => {
      const chunkSize = 16 * 1024,
        count = 137;
      const value = await cache(
        chunkSize * count,
        chunkSize,
      );
      for (let index = count - 1; index >= 0; index--)
        await value.storeChunk(
          index,
          bytes(index, chunkSize).buffer,
        );
      const file = await value.getFile();
      assert(file, "File missing");
      const contents = new Uint8Array(
        await file.arrayBuffer(),
      );
      for (let index = 0; index < count; index++) {
        equal(contents[index * chunkSize], index + 1);
        equal(
          contents[(index + 1) * chunkSize - 1],
          index + 1,
        );
      }
      equal(value.mergeMetrics?.batches, 3);
    });
  } finally {
    for (const value of caches.reverse())
      await value.cleanup();
  }
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    tests: completed.length,
    passed: completed,
    storage: "real IndexedDB",
    worker: "real module Worker + fault injection",
  };
}
main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
