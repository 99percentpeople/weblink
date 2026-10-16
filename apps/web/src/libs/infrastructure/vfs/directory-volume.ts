import type {
  VfsVolume,
  VfsStat,
  VfsEntry,
  VfsWrite,
  VfsFileMetadata,
  BinarySource,
} from "@weblink/platform";
import {
  DirectoryWriteError,
  StorageUnavailableError,
  vfsPath,
} from "@/libs/domain/vfs";
import { decodeDirectoryFilename } from "./directory-filename";

type Observer = {
  observe(
    handle: FileSystemDirectoryHandle,
    options: { recursive: boolean },
  ): Promise<void>;
  disconnect(): void;
};
type ObserverConstructor = new (
  changed: () => void,
) => Observer;

export class DirectoryVolume implements VfsVolume {
  readonly kind = "directory";
  readonly capabilities = {
    commit: "close",
    watch: "poll",
  } as const;
  constructor(
    readonly id: string,
    readonly name: string,
    readonly handle: FileSystemDirectoryHandle,
  ) {}
  async authorize(): Promise<void> {
    if (
      (await this.handle.requestPermission({
        mode: "readwrite",
      })) !== "granted"
    )
      throw new StorageUnavailableError(
        "Directory access was not granted",
      );
  }
  private async directory(
    path: string,
    create = false,
  ): Promise<FileSystemDirectoryHandle> {
    if (
      (await this.handle.queryPermission({
        mode: "readwrite",
      })) !== "granted"
    )
      throw new StorageUnavailableError();
    let directory = this.handle;
    for (const name of vfsPath(path)
      .split("/")
      .filter(Boolean))
      directory = await directory.getDirectoryHandle(name, {
        create,
      });
    return directory;
  }
  private async handleFor(
    path: string,
    create = false,
  ): Promise<FileSystemFileHandle> {
    const parts = vfsPath(path).split("/");
    const name = parts.pop();
    if (!name) throw new Error("File path is empty");
    return (
      await this.directory(parts.join("/"), create)
    ).getFileHandle(name, { create });
  }
  private fileStat(file: File): VfsStat {
    return {
      kind: "file",
      size: file.size,
      modified: file.lastModified,
      revision: `${file.size}:${file.lastModified}`,
    };
  }
  async stat(path: string): Promise<VfsStat | null> {
    try {
      if (!path) {
        const directory = await this.directory("");
        // Permission can remain granted after a directory is deleted or disconnected.
        const entries = directory.entries();
        try {
          await entries.next();
        } finally {
          await entries.return?.();
        }
        return {
          kind: "directory",
          size: 0,
          modified: 0,
          revision: "directory",
        };
      }
      return this.fileStat(
        await (await this.handleFor(path)).getFile(),
      );
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "NotFoundError"
      )
        return null;
      if (
        error instanceof DOMException &&
        error.name === "TypeMismatchError"
      ) {
        await this.directory(path);
        return {
          kind: "directory",
          size: 0,
          modified: 0,
          revision: "directory",
        };
      }
      throw error;
    }
  }
  async list(path: string): Promise<VfsEntry[]> {
    const result: VfsEntry[] = [];
    for await (const [name, handle] of (
      await this.directory(path)
    ).entries()) {
      result.push(
        handle.kind === "file"
          ? {
              name,
              ...this.fileStat(await handle.getFile()),
            }
          : {
              name,
              kind: "directory",
              size: 0,
              modified: 0,
              revision: "directory",
            },
      );
    }
    return result.sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    const file = await (
      await this.handleFor(path)
    ).getFile();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + length > file.size
    )
      throw new Error("Invalid read range");
    return file
      .slice(offset, offset + length)
      .arrayBuffer();
  }
  async commit(
    path: string,
    writes: readonly VfsWrite[],
    size?: number,
  ): Promise<VfsStat> {
    const handle = await this.handleFor(
      path,
      size !== undefined,
    );
    const before = await handle.getFile();
    const length = size ?? before.size;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      writes.some(
        (write) =>
          !Number.isSafeInteger(write.offset) ||
          write.offset < 0 ||
          write.offset + write.data.length > length,
      )
    )
      throw new Error("Invalid write range");
    const stream = await handle.createWritable({
      keepExistingData: true,
    });
    try {
      if (size !== undefined) await stream.truncate(size);
      for (const write of writes)
        await stream.write({
          type: "write",
          position: write.offset,
          data: write.data,
        });
      try {
        await stream.close();
      } catch (error) {
        throw new DirectoryWriteError(
          decodeDirectoryFilename(path.split("/").at(-1)!),
          "commit",
          error,
        );
      }
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return this.fileStat(await handle.getFile());
  }
  async writeFile(
    path: string,
    source: BinarySource,
    signal?: AbortSignal,
    onWritten?: (bytes: number) => void,
  ): Promise<VfsStat> {
    signal?.throwIfAborted();
    let stage: "create" | "write" | "commit" = "create";
    let stream: FileSystemWritableFileStream | undefined;
    try {
      const handle = await this.handleFor(path, true);
      signal?.throwIfAborted();
      stream = await handle.createWritable({
        keepExistingData: false,
      });
      signal?.throwIfAborted();
      stage = "write";
      // Reserve in the writable transaction; expose only the complete payload on close.
      await stream.truncate(source.size);
      const batch = 4 * 1024 * 1024;
      for (
        let offset = 0;
        offset < source.size;
        offset += batch
      ) {
        signal?.throwIfAborted();
        const part = source.slice(
          offset,
          Math.min(source.size, offset + batch),
        );
        // A Blob is streamed by the browser without materializing it in JS memory.
        const data =
          part instanceof Blob
            ? part
            : await part.arrayBuffer();
        signal?.throwIfAborted();
        await stream.write(data);
        onWritten?.(Math.min(source.size, offset + batch));
      }
      signal?.throwIfAborted();
      stage = "commit";
      await stream.close();
      return this.fileStat(await handle.getFile());
    } catch (error) {
      await stream?.abort().catch(() => {});
      signal?.throwIfAborted();
      throw new DirectoryWriteError(
        decodeDirectoryFilename(path.split("/").at(-1)!),
        stage,
        error,
      );
    }
  }
  async remove(path: string): Promise<void> {
    const parts = vfsPath(path).split("/");
    const name = parts.pop()!;
    try {
      await (
        await this.directory(parts.join("/"))
      ).removeEntry(name);
    } catch (error) {
      if (
        !(
          error instanceof DOMException &&
          error.name === "NotFoundError"
        )
      )
        throw error;
    }
  }
  async file(
    path: string,
    metadata: VfsFileMetadata,
  ): Promise<File> {
    const file = await (
      await this.handleFor(path)
    ).getFile();
    return new File([file], metadata.name, {
      type: metadata.type || file.type,
      lastModified: metadata.lastModified,
    });
  }
  async watch(changed: () => void): Promise<() => void> {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: string | undefined;
    let observer: Observer | undefined;
    let scanning = false;
    const scan = async () => {
      if (stopped || scanning) return;
      scanning = true;
      try {
        const entries: string[] = [];
        const visit = async (
          path: string,
        ): Promise<void> => {
          for (const entry of await this.list(path)) {
            if (stopped) return;
            const child = path
              ? `${path}/${entry.name}`
              : entry.name;
            entries.push(
              `${child}:${entry.kind}:${entry.revision}`,
            );
            if (entry.kind === "directory")
              await visit(child);
          }
        };
        await visit("");
        const next = JSON.stringify(entries);
        if (
          !stopped &&
          snapshot !== undefined &&
          snapshot !== next
        )
          changed();
        snapshot = next;
      } catch {
        if (!stopped && snapshot !== "unavailable")
          changed();
        snapshot = "unavailable";
      } finally {
        scanning = false;
        if (!stopped)
          timer = setTimeout(() => {
            if (document.visibilityState === "hidden") {
              timer = setTimeout(() => void scan(), 15_000);
            } else void scan();
          }, 5000);
      }
    };
    const ObserverClass = (
      globalThis as typeof globalThis & {
        FileSystemObserver?: ObserverConstructor;
      }
    ).FileSystemObserver;
    if (ObserverClass) {
      try {
        observer = new ObserverClass(() => {
          if (!stopped) changed();
        });
        await observer.observe(this.handle, {
          recursive: true,
        });
      } catch {
        observer?.disconnect();
        observer = undefined;
      }
    }
    const focus = () => {
      clearTimeout(timer);
      // A file may have been created and deleted between watch snapshots, and
      // permission may have changed even when the directory listing is identical.
      if (!stopped) changed();
      void scan();
    };
    window.addEventListener("focus", focus);
    void scan();
    return () => {
      stopped = true;
      clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("focus", focus);
    };
  }
}
