import type {
  VfsVolume,
  VfsStat,
  VfsEntry,
  VfsWrite,
  VfsFileMetadata,
} from "@weblink/platform";
import { vfsPath } from "@/libs/domain/vfs";
import {
  requestResult,
  transactionDone,
} from "../storage/indexeddb-helpers";
import { VfsDatabase } from "./database";

const PAGE = 256 * 1024;
interface Node extends VfsStat {
  path: string;
}

/** Sparse logical files; holes consume metadata only until their pages are written. */
export class IndexedDbVolume implements VfsVolume {
  readonly id = "indexeddb";
  readonly name = "IndexedDB";
  readonly kind = "indexeddb";
  readonly capabilities = {
    commit: "transaction",
    watch: "events",
  } as const;
  constructor(private readonly database: VfsDatabase) {}
  async stat(path: string): Promise<VfsStat | null> {
    vfsPath(path);
    const node = await this.database.get<Node>(
      "nodes",
      path,
    );
    if (node) return node;
    if (
      !path ||
      (await this.database.all<Node>("nodes")).some(
        (node) => node.path.startsWith(`${path}/`),
      )
    )
      return {
        kind: "directory",
        size: 0,
        modified: 0,
        revision: "directory",
      };
    return null;
  }
  async list(path: string): Promise<VfsEntry[]> {
    vfsPath(path);
    const prefix = path ? `${path}/` : "";
    const result = new Map<string, VfsEntry>();
    for (const node of await this.database.all<Node>(
      "nodes",
    )) {
      if (!node.path.startsWith(prefix)) continue;
      const rest = node.path.slice(prefix.length);
      const [name] = rest.split("/");
      if (!name) continue;
      result.set(
        name,
        rest.includes("/")
          ? {
              name,
              kind: "directory",
              size: 0,
              modified: 0,
              revision: "directory",
            }
          : { ...node, name },
      );
    }
    return [...result.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    vfsPath(path);
    const tx = (await this.database.open()).transaction([
      "nodes",
      "pages",
    ]);
    const done = transactionDone(tx);
    try {
      const node = await requestResult<Node | undefined>(
        tx.objectStore("nodes").get(path),
      );
      if (!node) throw new Error("File does not exist");
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        offset + length > node.size
      )
        throw new Error("Invalid read range");
      const result = new Uint8Array(length);
      for (
        let cursor = offset;
        cursor < offset + length;
      ) {
        const index = Math.floor(cursor / PAGE);
        const page = await requestResult<
          ArrayBuffer | undefined
        >(tx.objectStore("pages").get([path, index]));
        const count = Math.min(
          offset + length - cursor,
          PAGE - (cursor % PAGE),
        );
        if (page)
          result.set(
            new Uint8Array(page, cursor % PAGE, count),
            cursor - offset,
          );
        cursor += count;
      }
      await done;
      return result.buffer;
    } catch (error) {
      await done.catch(() => {});
      throw error;
    }
  }
  async commit(
    path: string,
    writes: readonly VfsWrite[],
    size?: number,
  ): Promise<VfsStat> {
    vfsPath(path);
    if (!path)
      throw new Error("Cannot write the root directory");
    const tx = (await this.database.open()).transaction(
      ["nodes", "pages"],
      "readwrite",
    );
    const done = transactionDone(tx);
    try {
      const nodes = tx.objectStore("nodes");
      const pages = tx.objectStore("pages");
      const old = await requestResult<Node | undefined>(
        nodes.get(path),
      );
      const length = size ?? old?.size;
      if (
        length === undefined ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        throw new Error("Invalid file size");
      if (size !== undefined && old && length < old.size) {
        pages.delete(
          IDBKeyRange.bound(
            [path, Math.ceil(length / PAGE)],
            [path, Number.MAX_SAFE_INTEGER],
          ),
        );
        if (length % PAGE) {
          const index = Math.floor(length / PAGE);
          const page = await requestResult<
            ArrayBuffer | undefined
          >(pages.get([path, index]));
          if (page) {
            new Uint8Array(page).fill(0, length % PAGE);
            pages.put(page, [path, index]);
          }
        }
      }
      for (const write of writes) {
        if (
          !Number.isSafeInteger(write.offset) ||
          write.offset < 0 ||
          write.offset + write.data.length > length
        )
          throw new Error("Invalid write range");
        for (let cursor = 0; cursor < write.data.length; ) {
          const offset = write.offset + cursor;
          const index = Math.floor(offset / PAGE);
          const previous = await requestResult<
            ArrayBuffer | undefined
          >(pages.get([path, index]));
          const page = new Uint8Array(
            previous ?? new ArrayBuffer(PAGE),
          );
          const count = Math.min(
            write.data.length - cursor,
            PAGE - (offset % PAGE),
          );
          page.set(
            write.data.subarray(cursor, cursor + count),
            offset % PAGE,
          );
          pages.put(page.buffer, [path, index]);
          cursor += count;
        }
      }
      const node: Node = {
        path,
        kind: "file",
        size: length,
        modified: Date.now(),
        revision: crypto.randomUUID(),
      };
      nodes.put(node, path);
      await done;
      this.database.changed();
      return node;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  async remove(path: string): Promise<void> {
    vfsPath(path);
    const tx = (await this.database.open()).transaction(
      ["nodes", "pages"],
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore("nodes").delete(path);
    tx.objectStore("pages").delete(
      IDBKeyRange.bound(
        [path, 0],
        [path, Number.MAX_SAFE_INTEGER],
      ),
    );
    await done;
    this.database.changed();
  }
  async file(
    path: string,
    metadata: VfsFileMetadata,
  ): Promise<File> {
    const tx = (await this.database.open()).transaction([
      "nodes",
      "pages",
    ]);
    const done = transactionDone(tx);
    try {
      const node = await requestResult<Node | undefined>(
        tx.objectStore("nodes").get(vfsPath(path)),
      );
      if (!node) throw new Error("File does not exist");
      const parts: BlobPart[] = [];
      for (
        let offset = 0;
        offset < node.size;
        offset += PAGE
      ) {
        const buffer = await requestResult<
          ArrayBuffer | undefined
        >(
          tx
            .objectStore("pages")
            .get([path, offset / PAGE]),
        );
        parts.push(
          new Uint8Array(
            buffer ?? new ArrayBuffer(PAGE),
            0,
            Math.min(PAGE, node.size - offset),
          ),
        );
      }
      await done;
      return new File(parts, metadata.name, {
        type: metadata.type,
        lastModified: metadata.lastModified,
      });
    } catch (error) {
      await done.catch(() => {});
      throw error;
    }
  }
  async watch(changed: () => void): Promise<() => void> {
    return this.database.watch(changed);
  }
}
