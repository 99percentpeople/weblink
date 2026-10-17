// @vitest-environment node
import { describe, expect, it } from "vitest";
import { expectedChunkSize } from "@/libs/domain/file-chunks";
import { transactionDone } from "@/libs/infrastructure/storage/indexeddb-helpers";
const info = {
  id: "test",
  fileName: "test.bin",
  fileSize: 19,
  chunkSize: 8,
};
describe("IndexedDB commits and chunk boundaries", () => {
  it("checks final chunk sizes including exact multiples", () => {
    expect(expectedChunkSize(info, 2)).toBe(3);
    expect(
      expectedChunkSize({ ...info, fileSize: 16 }, 1),
    ).toBe(8);
    expect(() =>
      expectedChunkSize({ ...info, fileSize: 0 }, 0),
    ).toThrow();
  });
  it("rejects invalid sizes and indices", () => {
    for (const chunkSize of [0, -1, NaN, Infinity, 1.5])
      expect(() =>
        expectedChunkSize({ ...info, chunkSize }, 0),
      ).toThrow();
    for (const index of [-1, 3, NaN, Infinity, 1.5])
      expect(() =>
        expectedChunkSize(info, index),
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
