import type { VfsStat } from "@/libs/domain/vfs";
import {
  VfsDatabase,
  type StoredVfsFile,
} from "../vfs/database";
import {
  requestResult,
  transactionDone,
} from "./indexeddb-helpers";

/** Publish or reconfirm metadata only while it still points at the verified bytes. */
export async function publishMigratedFile(
  database: VfsDatabase,
  record: StoredVfsFile,
  alreadyPublished = false,
): Promise<void> {
  const tx = (await database.open()).transaction(
    ["files", "nodes", "checkpoints"],
    "readwrite",
  );
  const done = transactionDone(tx);
  try {
    const [existing, node] = await Promise.all([
      requestResult<StoredVfsFile | undefined>(
        tx.objectStore("files").get(record.id),
      ),
      requestResult<VfsStat | undefined>(
        tx.objectStore("nodes").get(record.path),
      ),
    ]);
    if (
      (alreadyPublished
        ? !existing ||
          existing.path !== record.path ||
          existing.migrationSource !==
            record.migrationSource ||
          existing.checkpointVersion !==
            record.checkpointVersion
        : !!existing) ||
      !node ||
      node.revision !== record.revision ||
      node.size !== record.info?.fileSize
    )
      throw new Error(
        "Migration destination changed before publication",
      );
    if (alreadyPublished) {
      await done;
      return;
    }
    const { chunks, ...metadata } = record;
    const checkpoints = tx.objectStore("checkpoints");
    checkpoints.delete(
      IDBKeyRange.bound(
        [record.id, 0],
        [record.id, Number.MAX_SAFE_INTEGER],
      ),
    );
    for (const [index, hash] of Object.entries(chunks))
      checkpoints.put({ index: Number(index), hash }, [
        record.id,
        Number(index),
      ]);
    tx.objectStore("files").add(
      { ...metadata, checkpointVersion: 1 },
      record.id,
    );
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw error;
  }
}

/** A crash may leave staging pages, but cleanup must never delete a published file. */
export async function discardMigrationStages(
  database: VfsDatabase,
  id: string,
  prefix: string,
): Promise<void> {
  const tx = (await database.open()).transaction(
    ["files", "nodes", "pages"],
    "readwrite",
  );
  const done = transactionDone(tx);
  try {
    const [record, nodes] = await Promise.all([
      requestResult<StoredVfsFile | undefined>(
        tx.objectStore("files").get(id),
      ),
      requestResult<(VfsStat & { path: string })[]>(
        tx
          .objectStore("nodes")
          .getAll(
            IDBKeyRange.bound(prefix, `${prefix}\uffff`),
          ),
      ),
    ]);
    for (const node of nodes) {
      if (
        !node.path.startsWith(prefix) ||
        node.path === record?.path
      )
        continue;
      tx.objectStore("nodes").delete(node.path);
      tx.objectStore("pages").delete(
        IDBKeyRange.bound(
          [node.path, 0],
          [node.path, Number.MAX_SAFE_INTEGER],
        ),
      );
    }
    await done;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await done.catch(() => {});
    throw error;
  }
}
