# Blob-backed chunk caching and final assembly

This optimizes the cache behind the existing file-transfer service. It does not
change the P2P protocol, channel labels or missing-range requests, and does not
introduce OPFS or require a new storage permission.

## Receive and read paths

`IDBChunkCache.storeChunk()` snapshots each decompressed ArrayBuffer into a Blob
when it is received. A bounded in-memory map holds pending records; duplicate
indices replace their previous pending value. `flush()` serializes overlapping
calls and waits for their transactions to commit. Failed batches are restored,
without replacing newer buffered values for the same index.

IndexedDB still uses the same `chunks` store and `chunkIndex` keys. New records
contain Blobs. Existing ArrayBuffer records, including a partially downloaded
cache containing both formats after an upgrade, remain readable. `getChunk()`
converts only the requested Blob to an ArrayBuffer for retransmission. No bulk
migration, cache reset or schema version bump is required.

Missing-range calculation returns no ranges for an already finalized File.
Cached-byte accounting handles both zero-length files and a full-sized last
chunk correctly.

## Finalization

`getFile()` and `mergeFile()` share the same in-flight Promise per cache instance.
A completed cached File is returned without spawning a worker. A failed attempt
releases its Promise so the caller may repair missing data and retry.

The worker no longer creates another `IDBChunkCache` or calls back into its merge
logic. `chunk-assembly.ts` reads and commits through one IndexedDB transaction:

1. Read metadata and confirm the expected number of chunk records.
2. Read ordered `getAll(range, count)` batches, bounded to 64 records and a target
   of 8 MiB of nominal chunk data per batch (at least one record). A chunk larger
   than that target still requires one complete record read. Convert legacy
   ArrayBuffers only; existing Blobs are directly reused as File parts.
3. Validate contiguous numeric indices, each chunk's byte length, the final
   partial chunk and total file size. Build the File once.
4. Put the final File into `info` and clear `chunks` in the **same transaction**.
5. Report completion only from `transaction.oncomplete`.

The next read is scheduled inside the previous request's success callback so
IndexedDB does not auto-commit between batches. The transaction covers both
stores in readwrite mode, serializing concurrent finalization attempts. A second
cache instance observes and returns the first committed File instead of
reassembling it. A failed put, clear or transaction abort preserves the original
metadata and chunks together.

The main thread only updates observable state from the worker result; it does
not write the File back a second time. Worker startup, message decoding and
reported failures reject the Promise and reset the merging flag. Cache cleanup
cancels its worker and guards late results. A blocked database deletion is not
reported as successful. Transaction completion here means IndexedDB commit, not
a promise about physical fsync or survival of every possible power failure.

`IDBChunkCache.mergeMetrics` exposes the last worker's read, build and commit
latencies plus chunk/batch counts, without adding timers or progress UI.

## What this does and does not accelerate

Conversion work is distributed over receipt, and the final read no longer
materializes every new chunk as an ArrayBuffer. Batch reads also reduce cursor
callbacks. This is **not** continuous writing into a final filesystem file:
completion still waits for all required chunks, and IndexedDB still has to
commit the assembled File. Blob storage and copying decisions vary by browser.
Do not assume zero-copy assembly or a universal end-to-end speedup.

In the local real-Chromium benchmark, the remaining finalization time is mostly
File commit, not `new File(parts)`. Removing that final whole-file persistence
step would require a separate storage design, such as OPFS offset writes.

## Testing and benchmarks

Correctness tests, real-Chromium cache/transfer smoke checks and the browser
benchmark are documented separately in [TESTING.md](TESTING.md). Benchmarks are
not correctness gates and do not run in the normal test suite.

### Local before/after measurements

The benchmark generates and hashes data outside its timed interval. It measures
all chunk stores/flushes, `getFile()` and final readback confirmation separately.
It excludes WebRTC, decompression, OS download/export and the post-timing SHA-256
verification. Tests run in a disposable headless Chromium 148 profile on the
same host. Chunk size: 512 KiB. Buffered chunks: 4. Each value below is the median
of three runs; files have an additional 17-byte tail to exercise partial chunks.

Deterministic pseudo-random data (`xorshift32`, the default):

| File size      | Final readback confirmed: before |    After | Store + finalization: before |    After |
| -------------- | -------------------------------: | -------: | ---------------------------: | -------: |
| 32 MiB + 17 B  |                         251.4 ms | 143.7 ms |                     394.3 ms | 271.6 ms |
| 128 MiB + 17 B |                         914.5 ms | 498.2 ms |                    1523.7 ms | 974.3 ms |

The old `getFile()` Promise returned before its writes were committed: its
128 MiB median Promise time was 540.1 ms, compared with 487.1 ms for the new
Promise, which already includes the atomic commit. The larger final-readback
improvement should not be confused with the old UI's early success indication.
Old baseline runs also sometimes retained all chunk records after returning a
valid final File; every optimized run cleared them. The benchmark reports
`remainingChunks` rather than concealing this old cleanup race.

A repetitive byte-pattern trial showed a different tradeoff:

| File size      | Final readback confirmed: before |    After | Store + finalization: before |    After |
| -------------- | -------------------------------: | -------: | ---------------------------: | -------: |
| 32 MiB + 17 B  |                         217.7 ms | 141.9 ms |                     266.0 ms | 256.2 ms |
| 128 MiB + 17 B |                         706.5 ms | 480.3 ms |                     883.7 ms | 973.0 ms |

Thus the repetitive 128 MiB case improved the final tail but made the isolated
store-plus-finalization total about 10% slower. Data-dependent storage costs
matter; these results are not a prediction for every browser, disk or file.
