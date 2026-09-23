import { describe, expect, it } from "vitest";
import { Blob } from "node:buffer";
import { blake3 } from "hash-wasm";
import {
  fingerprintBlob,
  FINGERPRINT_CHUNK_SIZE,
} from "@/libs/infrastructure/storage/fingerprint";
import {
  contentKey,
  isFileFingerprint,
} from "@/libs/domain/protocol/file-fingerprint";

describe("file content fingerprints", () => {
  it("matches BLAKE3 known empty input and chunked input", async () => {
    const empty = await fingerprintBlob(
      new Blob([]) as globalThis.Blob,
    );
    expect(empty.digest).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
    const bytes = new Uint8Array(
      FINGERPRINT_CHUNK_SIZE + 17,
    );
    bytes[bytes.length - 1] = 19;
    const progress: number[] = [];
    const result = await fingerprintBlob(
      new Blob([bytes]) as globalThis.Blob,
      (value) => progress.push(value),
    );
    expect(result.digest).toBe(await blake3(bytes));
    expect(progress).toEqual([
      FINGERPRINT_CHUNK_SIZE,
      bytes.length,
    ]);
    expect(contentKey(result)).toContain(result.digest);
  });
  it("rejects malformed/unsupported identities and stops cancelled reads", async () => {
    expect(
      isFileFingerprint({
        version: 1,
        algorithm: "md5",
        digest: "a".repeat(64),
        size: 0,
      }),
    ).toBe(false);
    expect(
      isFileFingerprint({
        version: 1,
        algorithm: "blake3-256",
        digest: "a".repeat(64),
        size: -1,
      }),
    ).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fingerprintBlob(
        new Blob(["content"]) as globalThis.Blob,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
