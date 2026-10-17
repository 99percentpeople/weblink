import { createBLAKE3 } from "hash-wasm";
import type { BinarySource } from "@weblink/platform";
import { expectedChunkSize } from "@/libs/domain/file-chunks";
import type { StorageMigrationProgress } from "@/libs/domain/storage-migration";
import type { VfsVolume } from "@/libs/domain/vfs";
import { withExclusiveTask } from "@/libs/utils/exclusive-task";
import {
  VfsDatabase,
  type StoredVfsFile,
} from "../vfs/database";
import { IndexedDbVolume } from "../vfs/indexeddb-volume";
import {
  LEGACY_DATABASE_PREFIX,
  openLegacySource,
  deleteLegacyDatabase,
  type LegacySource,
} from "./legacy-indexeddb-source";
import {
  discardMigrationStages,
  publishMigratedFile,
} from "./indexeddb-migration-target";

const BATCH_BYTES = 4 * 1024 * 1024;
type Report = (
  progress: Partial<StorageMigrationProgress>,
) => void;

async function migrateFile(
  name: string,
  database: VfsDatabase,
  volume: VfsVolume,
  signal: AbortSignal,
  report: Report,
): Promise<void> {
  const id = name.slice(LEGACY_DATABASE_PREFIX.length);
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("Invalid legacy storage ID");
  const prefix = `Legacy migration/${encodeURIComponent(id)}/`;
  let source: LegacySource | null = null;
  let staging = "";
  const waiting = () => report({ phase: "waiting" });
  try {
    signal.throwIfAborted();
    source = await openLegacySource(name, signal, waiting);
    if (!source) return;
    await discardMigrationStages(database, id, prefix);
    const metadata = source.info;
    if (metadata) {
      const { file, ...rest } = metadata;
      const info = {
        ...rest,
        chunkSize: rest.chunkSize ?? 256 * 1024,
        mimetype: rest.mimetype ?? file?.type,
        lastModified:
          rest.lastModified ?? file?.lastModified,
      };
      if (
        !Number.isSafeInteger(info.chunkSize) ||
        info.chunkSize < 1
      )
        throw new Error("Invalid legacy chunk size");
      report({
        fileName: info.fileName,
        phase: "copying",
        bytes: 0,
      });
      const totalBytes = file
        ? file.size
        : source.keys.reduce(
            (size, key) =>
              size + expectedChunkSize(info, key),
            0,
          );
      report({ totalBytes });
      let record = await database.file(id);
      if (
        record &&
        (record.migrationSource !== name ||
          record.mountId !== "indexeddb" ||
          record.info?.fileSize !== info.fileSize ||
          (!file &&
            !record.complete &&
            record.info?.chunkSize !== info.chunkSize))
      )
        throw new Error(
          "A different file already uses the legacy storage ID",
        );
      const existing = !!record;
      if (!record) {
        staging = `${prefix}${crypto.randomUUID()}`;
        const stat = await volume.commit(
          staging,
          [],
          info.fileSize,
        );
        record = {
          id,
          mountId: "indexeddb",
          path: staging,
          info,
          chunks: {},
          complete: !!file || info.fileSize === 0,
          revision: stat.revision,
          migrationSource: name,
        };
      }
      const path = record.path;
      const hasher = await createBLAKE3(256);
      const fullDigest = file
        ? await copyChunk(file, 0, 0)
        : undefined;
      const sourceHashes: Record<number, string> = {};
      if (!file) {
        let bytes = 0;
        for (const key of source.keys) {
          const chunk = await source.chunk(key);
          const digest = await copyChunk(
            chunk,
            key * info.chunkSize!,
            bytes,
          );
          sourceHashes[key] = digest;
          if (!existing) record.chunks[key] = digest;
          bytes += chunk.size;
        }
      }
      const stat = await volume.stat(path);
      if (
        !stat ||
        stat.kind !== "file" ||
        stat.size !== info.fileSize
      )
        throw new Error("Migrated file size mismatch");
      report({ phase: "verifying", bytes: 0 });
      if (fullDigest) {
        hasher.init();
        for (
          let offset = 0;
          offset < info.fileSize;
          offset += BATCH_BYTES
        ) {
          signal.throwIfAborted();
          const length = Math.min(
            BATCH_BYTES,
            info.fileSize - offset,
          );
          hasher.update(
            new Uint8Array(
              await volume.read(path, offset, length),
            ),
          );
          report({ bytes: offset + length });
        }
        if (
          hasher.digest("hex") !== fullDigest ||
          (info.fingerprint &&
            (info.fingerprint.version !== 1 ||
              info.fingerprint.algorithm !== "blake3-256" ||
              info.fingerprint.size !== info.fileSize ||
              info.fingerprint.digest !== fullDigest))
        )
          throw new Error(
            "Migrated file checksum mismatch",
          );
      } else {
        let bytes = 0;
        for (const key of source.keys) {
          signal.throwIfAborted();
          const length = expectedChunkSize(info, key);
          const expected = sourceHashes[key];
          if (
            !record.complete &&
            (!record.chunks[key] ||
              record.chunks[key] !== expected)
          )
            throw new Error(
              `Migrated checkpoint ${key} is missing or changed`,
            );
          hasher.init();
          for (
            let offset = 0;
            offset < length;
            offset += BATCH_BYTES
          ) {
            const readSize = Math.min(
              BATCH_BYTES,
              length - offset,
            );
            signal.throwIfAborted();
            hasher.update(
              new Uint8Array(
                await volume.read(
                  path,
                  key * info.chunkSize! + offset,
                  readSize,
                ),
              ),
            );
            report({ bytes: bytes + offset + readSize });
          }
          if (hasher.digest("hex") !== expected)
            throw new Error(
              `Migrated chunk ${key} checksum mismatch`,
            );
          bytes += length;
        }
      }
      signal.throwIfAborted();
      if (
        (await volume.stat(path))?.revision !==
        stat.revision
      )
        throw new Error(
          "Migrated file changed during verification",
        );
      record.revision = stat.revision;
      await publishMigratedFile(database, record, existing);

      async function copyChunk(
        blob: BinarySource,
        start: number,
        processed: number,
      ): Promise<string> {
        hasher.init();
        for (
          let offset = 0;
          offset < blob.size;
          offset += BATCH_BYTES
        ) {
          signal.throwIfAborted();
          const data = new Uint8Array(
            await blob
              .slice(offset, offset + BATCH_BYTES)
              .arrayBuffer(),
          );
          hasher.update(data);
          if (!existing)
            await volume.commit(path, [
              { offset: start + offset, data },
            ]);
          report({
            bytes: processed + offset + data.length,
          });
        }
        return hasher.digest("hex");
      }
    }
    source.close();
    source = null;
    report({ phase: "deleting" });
    await deleteLegacyDatabase(name, signal, waiting);
  } finally {
    source?.close();
    // Also safe after publication: the transaction excludes the visible file.
    if (staging)
      await discardMigrationStages(
        database,
        id,
        staging,
      ).catch(() => {});
  }
}

/** All new and migrated files use VFS; the old format is read only here. */
export async function migrateLegacyIndexedDb(
  database: VfsDatabase,
  signal: AbortSignal,
  onProgress: (progress: StorageMigrationProgress) => void,
  volume: VfsVolume = new IndexedDbVolume(database),
): Promise<StorageMigrationProgress | undefined> {
  if (typeof indexedDB.databases !== "function") return;
  const names = (await indexedDB.databases()).flatMap(
    ({ name }) =>
      name?.startsWith(LEGACY_DATABASE_PREFIX)
        ? [name]
        : [],
  );
  if (!names.length) return;
  let state: StorageMigrationProgress = {
    phase: "preparing",
    fileName: "",
    totalFiles: names.length,
    completedFiles: 0,
    bytes: 0,
    totalBytes: 0,
    failures: [],
  };
  const report: Report = (progress) => {
    state = { ...state, ...progress };
    onProgress(state);
  };
  for (const name of names) {
    const id = name.slice(LEGACY_DATABASE_PREFIX.length);
    report({
      phase: "preparing",
      fileName: id,
      bytes: 0,
      totalBytes: 0,
    });
    try {
      await withExclusiveTask(`storage:${id}`, () =>
        migrateFile(name, database, volume, signal, report),
      );
      state = {
        ...state,
        completedFiles: state.completedFiles + 1,
      };
    } catch (error) {
      signal.throwIfAborted();
      report({
        failures: [
          ...state.failures,
          {
            id,
            fileName: state.fileName,
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error),
          },
        ],
      });
    }
  }
  report({
    phase: state.failures.length ? "failed" : "completed",
  });
  return state;
}
