// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  chunkBlob,
  expectedChunkSize,
  mergeBatchSize,
  transactionDone,
  MERGE_BATCH_BYTES,
  MERGE_BATCH_RECORDS,
} from "@/libs/infrastructure/storage/chunk-assembly";
import type { ChunkMetaData } from "@/libs/domain/file";

const info: ChunkMetaData = {
  id: "test",
  fileName: "test.bin",
  fileSize: 19,
  chunkSize: 8,
};

describe("bounded Blob assembly", () => {
  it("uses a record and byte bound for bulk reads", () => {
    for (const size of [
      1,
      4096,
      512 * 1024,
      4 * 1024 * 1024,
      16 * 1024 * 1024,
    ]) {
      const count = mergeBatchSize(size);
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(
        MERGE_BATCH_RECORDS,
      );
      if (size <= MERGE_BATCH_BYTES)
        expect(size * count).toBeLessThanOrEqual(
          MERGE_BATCH_BYTES,
        );
    }
  });
  it("reuses existing Blobs instead of reading their bytes", () => {
    const data = new Blob([new Uint8Array(8)]);
    expect(
      chunkBlob({ chunkIndex: 1, data }, info, 1),
    ).toBe(data);
  });
  it("accepts legacy ArrayBuffer records and snapshots their bytes", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const blob = chunkBlob(
      { chunkIndex: 2, data: data.buffer },
      info,
      2,
    );
    data.fill(99);
    expect([
      ...new Uint8Array(await blob.arrayBuffer()),
    ]).toEqual([1, 2, 3]);
  });
  it("checks final chunk sizes including exact multiples", () => {
    expect(expectedChunkSize(info, 2)).toBe(3);
    expect(
      expectedChunkSize({ ...info, fileSize: 16 }, 1),
    ).toBe(8);
    expect(() =>
      expectedChunkSize({ ...info, fileSize: 0 }, 0),
    ).toThrow();
  });
  it("rejects missing, out-of-range, malformed and wrong-size records", () => {
    expect(() =>
      chunkBlob(
        { chunkIndex: 1, data: new Blob(["12345678"]) },
        info,
        0,
      ),
    ).toThrow(/Missing/);
    expect(() =>
      chunkBlob(
        { chunkIndex: 2, data: new Blob(["1234"]) },
        info,
        2,
      ),
    ).toThrow(/length/);
    expect(() =>
      chunkBlob(
        { chunkIndex: 3, data: new ArrayBuffer(8) },
        info,
        3,
      ),
    ).toThrow(/index/);
    expect(() =>
      chunkBlob(
        { chunkIndex: 0, data: null } as any,
        info,
        0,
      ),
    ).toThrow(/length/);
    for (const chunkSize of [0, -1, NaN, Infinity, 1.5])
      expect(() =>
        expectedChunkSize({ ...info, chunkSize }, 0),
      ).toThrow();
  });
  it("does not resolve a transaction from a request success event", async () => {
    const transaction = new EventTarget() as IDBTransaction;
    let complete = false;
    const pending = transactionDone(transaction).then(
      () => {
        complete = true;
      },
    );
    transaction.dispatchEvent(new Event("success"));
    await Promise.resolve();
    expect(complete).toBe(false);
    transaction.dispatchEvent(new Event("complete"));
    await pending;
    expect(complete).toBe(true);
  });
  it("rejects an aborted transaction", async () => {
    const transaction = new EventTarget() as IDBTransaction;
    const pending = transactionDone(transaction);
    transaction.dispatchEvent(new Event("abort"));
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
