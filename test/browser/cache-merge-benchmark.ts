import { IDBChunkCache } from "../../src/libs/infrastructure/storage/indexeddb-chunk-cache";

const MiB = 1024 * 1024;
const repetitive = new URLSearchParams(location.search).has(
  "repeating",
);
const round = (ms: number) => Math.round(ms * 10) / 10;
const digest = async (data: ArrayBuffer) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", data),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

async function measure(
  bytes: number,
  chunkSize: number,
  iteration: number,
) {
  // Generate and hash outside the measured interval. All runs use identical bytes.
  const input = new Uint8Array(bytes);
  if (repetitive) {
    for (let i = 0; i < input.length; i++)
      input[i] = (i * 31 + (i >>> 16)) & 255;
  } else {
    const words = new Uint32Array(
      input.buffer,
      0,
      Math.floor(input.byteLength / 4),
    );
    let seed = 0x12345678;
    for (let i = 0; i < words.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      words[i] = seed >>> 0;
    }
  }
  const expected = await digest(input.buffer);
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < bytes; offset += chunkSize)
    chunks.push(
      input.buffer.slice(offset, offset + chunkSize),
    );
  const cache = new IDBChunkCache({
    id: crypto.randomUUID(),
    maxMomeryCacheSize: 4,
  });
  await cache.initialize();
  await cache.setInfo({
    id: cache.id,
    fileName: "benchmark.bin",
    fileSize: bytes,
    chunkSize,
  });
  try {
    const startedAt = performance.now();
    for (let index = 0; index < chunks.length; index++)
      await cache.storeChunk(index, chunks[index]);
    await cache.flush();
    const storedAt = performance.now();
    const file = await cache.getFile();
    const resolvedAt = performance.now();
    // The old implementation resolved before commit. Confirm that the File can
    // be read back too, rather than comparing unlike definitions of completion.
    let persisted = await cache.getInfo();
    const deadline = performance.now() + 5000;
    while (
      !persisted?.file &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 10),
      );
      persisted = await cache.getInfo();
    }
    const remaining = await cache.getChunkCount();
    const committedAt = performance.now();
    if (!file || file.size !== bytes || !persisted?.file)
      throw new Error(
        `File not committed: size=${file?.size}, expected=${bytes}, persisted=${!!persisted?.file}, remaining=${remaining}`,
      );
    if (
      (await digest(await persisted.file.arrayBuffer())) !==
      expected
    )
      throw new Error("Persisted file checksum mismatch");
    return {
      bytes,
      chunkSize,
      chunks: chunks.length,
      iteration,
      remainingChunks: remaining,
      storeMs: round(storedAt - startedAt),
      filePromiseMs: round(resolvedAt - storedAt),
      finalizeMs: round(committedAt - storedAt),
      totalMs: round(committedAt - startedAt),
      worker: cache.mergeMetrics,
      sha256: expected,
    };
  } finally {
    await cache.cleanup();
  }
}

async function main() {
  const runs = [];
  for (const bytes of [32 * MiB + 17, 128 * MiB + 17])
    for (let iteration = 1; iteration <= 3; iteration++)
      runs.push(
        await measure(bytes, 512 * 1024, iteration),
      );
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    benchmark:
      "cache store + committed finalization, no network",
    browser: navigator.userAgent,
    dataset: repetitive
      ? "repetitive byte pattern"
      : "deterministic pseudo-random bytes (xorshift32)",
    runs,
  };
}
main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
