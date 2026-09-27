import type { ChunkMetaData } from "@/libs/domain/file";

export type StoredChunk = {
  chunkIndex: number;
  data: Blob | ArrayBuffer;
};
export interface MergeMetrics {
  chunks: number;
  batches: number;
  readMs: number;
  buildMs: number;
  commitMs: number;
  totalMs: number;
}
export interface MergeResult {
  info: ChunkMetaData | null;
  assembled: boolean;
  metrics: MergeMetrics;
}

// Bound both callback count and the legacy ArrayBuffer payload materialized per batch.
export const MERGE_BATCH_BYTES = 8 * 1024 * 1024;
export const MERGE_BATCH_RECORDS = 64;
export function mergeBatchSize(chunkSize: number): number {
  return Math.max(
    1,
    Math.min(
      MERGE_BATCH_RECORDS,
      Math.floor(MERGE_BATCH_BYTES / chunkSize),
    ),
  );
}

export function expectedChunkSize(
  info: ChunkMetaData,
  index: number,
): number {
  if (
    !Number.isSafeInteger(info.fileSize) ||
    info.fileSize < 0 ||
    !Number.isSafeInteger(info.chunkSize) ||
    !info.chunkSize ||
    info.chunkSize < 1
  )
    throw new Error("Invalid file size or chunk size");
  const count = Math.ceil(info.fileSize / info.chunkSize);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= count
  )
    throw new Error(`Unexpected chunk index ${index}`);
  return Math.min(
    info.chunkSize,
    info.fileSize - index * info.chunkSize,
  );
}

export function chunkBlob(
  record: StoredChunk,
  info: ChunkMetaData,
  index: number,
): Blob {
  if (record.chunkIndex !== index)
    throw new Error(`Missing or unordered chunk ${index}`);
  const data = record.data;
  const size =
    data instanceof Blob
      ? data.size
      : data instanceof ArrayBuffer
        ? data.byteLength
        : -1;
  if (size !== expectedChunkSize(info, index))
    throw new Error(
      `Invalid byte length for chunk ${index}`,
    );
  // Existing ArrayBuffer caches remain readable; new records already contain Blobs.
  return data instanceof Blob ? data : new Blob([data]);
}

/** Resolve only after the transaction commits, never merely after a request succeeds. */
export function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener(
      "complete",
      () => resolve(),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () =>
        reject(
          transaction.error ??
            new DOMException(
              "IndexedDB transaction aborted",
              "AbortError",
            ),
        ),
      { once: true },
    );
  });
}
export function requestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Read ordered batches and commit File + deletion of chunks in ONE transaction.
 * Issue the next request inside the success callback so the transaction cannot
 * auto-commit between batches. Any bad/missing chunk or failed write rolls back.
 * Concurrent cache instances serialize here, and the later one reuses the File.
 */
export function assembleCachedFile(
  db: IDBDatabase,
  fileId: string,
): Promise<MergeResult> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      ["info", "chunks"],
      "readwrite",
    );
    const infos = transaction.objectStore("info");
    const chunks = transaction.objectStore("chunks");
    let failure: unknown;
    let info: ChunkMetaData | null = null;
    let assembled = false;
    let index = 0;
    let batches = 0;
    let readFinishedAt = startedAt;
    let buildFinishedAt = startedAt;
    const parts: Blob[] = [];
    const fail = (error: unknown) => {
      failure = error;
      try {
        transaction.abort();
      } catch {
        reject(error);
      }
    };
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("File assembly aborted"),
      );
    transaction.oncomplete = () => {
      const finishedAt = performance.now();
      resolve({
        info,
        assembled,
        metrics: {
          chunks: index,
          batches,
          readMs: readFinishedAt - startedAt,
          buildMs: buildFinishedAt - readFinishedAt,
          commitMs: finishedAt - buildFinishedAt,
          totalMs: finishedAt - startedAt,
        },
      });
    };
    const metadata = infos.get(fileId);
    metadata.onsuccess = () => {
      try {
        info = metadata.result ?? null;
        if (!info || info.file) {
          readFinishedAt = buildFinishedAt =
            performance.now();
          return;
        }
        if (
          !Number.isSafeInteger(info.fileSize) ||
          info.fileSize < 0 ||
          !Number.isSafeInteger(info.chunkSize) ||
          !info.chunkSize ||
          info.chunkSize < 1
        )
          throw new Error(
            "Invalid file metadata for assembly",
          );
        const expected = Math.ceil(
          info.fileSize / info.chunkSize,
        );
        const batchSize = mergeBatchSize(info.chunkSize);
        const readNext = () => {
          const request = chunks.getAll(
            IDBKeyRange.lowerBound(index),
            batchSize,
          );
          request.onsuccess = () => {
            try {
              const records =
                request.result as StoredChunk[];
              batches++;
              for (const record of records)
                parts.push(
                  chunkBlob(record, info!, index++),
                );
              if (records.length === batchSize) {
                readNext();
                return;
              }
              if (index !== expected)
                throw new Error(
                  `File incomplete: ${index}/${expected} chunks`,
                );
              readFinishedAt = performance.now();
              const file = new File(parts, info!.fileName, {
                type: info!.mimetype,
                lastModified: info!.lastModified,
              });
              if (file.size !== info!.fileSize)
                throw new Error(
                  "Assembled file size mismatch",
                );
              info = { ...info!, id: fileId, file };
              buildFinishedAt = performance.now();
              infos.put(info);
              chunks.clear();
              assembled = true;
              parts.length = 0;
            } catch (error) {
              fail(error);
            }
          };
        };
        // LowerBound(0) would hide negative/string keys. Check the key count too;
        // ordinary records must be exactly the expected contiguous numeric keys.
        const count = chunks.count();
        count.onsuccess = () => {
          try {
            if (count.result !== expected)
              throw new Error(
                `File incomplete: ${count.result}/${expected} chunks`,
              );
            readNext();
          } catch (error) {
            fail(error);
          }
        };
      } catch (error) {
        fail(error);
      }
    };
  });
}
