import {
  Channel,
  convertFileSrc,
  invoke,
} from "@tauri-apps/api/core";
import {
  LocalFileSystemError,
  RangeFile,
  sequentialWriter,
  type FileSystemOperation,
  type NativeFileSystem,
  type VfsVolume,
  type VfsVolumeInfo,
  type VfsStat,
  type VfsEntry,
  type VfsWrite,
  type VfsWriter,
  type VfsFileMetadata,
  type StoredFile,
} from "@weblink/platform";

const IO_BYTES = 1024 * 1024;
const asciiJson = (value: string) =>
  JSON.stringify(value).replace(
    /[^\x20-\x7e]/g,
    (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
const mimeType = (name: string): string =>
  ({
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
    avif: "image/avif",
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/plain",
    json: "application/json",
  })[name.split(".").at(-1)?.toLowerCase() ?? ""] ??
  "application/octet-stream";

class NativeVolume implements VfsVolume {
  readonly kind = "native";
  readonly capabilities = {
    commit: "sync",
    watch: "native",
  } as const;
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  private async io<T>(
    operation: FileSystemOperation,
    path: string,
    run: () => Promise<T>,
    range?: LocalFileSystemError["range"],
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // Tauri rejects Result<_, String> with a string. Transfer failures must be
      // real Errors so receiver listeners do not silently ignore disk failures.
      throw new LocalFileSystemError(
        operation,
        path,
        error,
        range,
      );
    }
  }
  stat(path: string): Promise<VfsStat | null> {
    return this.io("stat", path, () =>
      invoke("vfs_stat", { mountId: this.id, path }),
    );
  }
  list(path: string): Promise<VfsEntry[]> {
    return this.io("list", path, () =>
      invoke("vfs_list", { mountId: this.id, path }),
    );
  }
  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    return this.readVersion(path, offset, length);
  }
  private async readVersion(
    path: string,
    offset: number,
    length: number,
    revision?: string,
  ): Promise<ArrayBuffer> {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      throw new LocalFileSystemError(
        "read",
        path,
        new Error("Invalid read range"),
        { offset, length },
      );
    const result = new Uint8Array(length);
    for (
      let cursor = 0;
      cursor < length;
      cursor += IO_BYTES
    ) {
      const count = Math.min(IO_BYTES, length - cursor);
      const bytes = await this.io(
        "read",
        path,
        () =>
          invoke<ArrayBuffer>("vfs_read", {
            mountId: this.id,
            path,
            offset: offset + cursor,
            length: count,
            revision,
          }),
        { offset: offset + cursor, length: count },
      );
      if (bytes.byteLength !== count)
        throw new LocalFileSystemError(
          "read",
          path,
          new Error("File changed while reading"),
          { offset: offset + cursor, length: count },
        );
      result.set(new Uint8Array(bytes), cursor);
    }
    return result.buffer;
  }
  async commit(
    path: string,
    writes: readonly VfsWrite[],
    size?: number,
  ): Promise<VfsStat> {
    if (size !== undefined)
      await this.io(
        "resize",
        path,
        () =>
          invoke("vfs_resize", {
            mountId: this.id,
            path,
            size,
          }),
        { size },
      );
    for (const write of writes) {
      for (
        let offset = 0;
        offset < write.data.byteLength;
        offset += IO_BYTES
      ) {
        const data = write.data.subarray(
          offset,
          offset + IO_BYTES,
        );
        await this.io(
          "write",
          path,
          () =>
            invoke("vfs_write", data, {
              headers: {
                "x-vfs-mount": this.id,
                "x-vfs-path": asciiJson(path),
                "x-vfs-offset": String(
                  write.offset + offset,
                ),
              },
            }),
          {
            offset: write.offset + offset,
            length: data.byteLength,
          },
        );
      }
    }
    return this.io("sync", path, () =>
      invoke("vfs_sync", { mountId: this.id, path }),
    );
  }
  async openWriter(path: string): Promise<VfsWriter> {
    const id = await this.io<string>("write", path, () =>
      invoke("vfs_writer_open", { mountId: this.id, path }),
    );
    return sequentialWriter({
      write: async (bytes, offset) => {
        for (
          let cursor = 0;
          cursor < bytes.length;
          cursor += IO_BYTES
        ) {
          const data = bytes.subarray(
            cursor,
            cursor + IO_BYTES,
          );
          await this.io(
            "write",
            path,
            () =>
              invoke("vfs_writer_append", data, {
                headers: {
                  "x-vfs-writer": id,
                  "x-vfs-offset": String(offset + cursor),
                },
              }),
            {
              offset: offset + cursor,
              length: data.length,
            },
          );
        }
      },
      close: (_size, patches) =>
        this.io<VfsStat>("sync", path, () =>
          invoke("vfs_writer_close", {
            id,
            patches: patches.map(({ offset, data }) => ({
              offset,
              data: Array.from(data),
            })),
          }),
        ),
      abort: () =>
        this.io<void>("sync", path, () =>
          invoke("vfs_writer_abort", { id }),
        ),
    });
  }
  remove(path: string): Promise<void> {
    return this.io("remove", path, () =>
      invoke("vfs_remove", { mountId: this.id, path }),
    );
  }
  move(
    path: string,
    destination: string,
    revision: string,
  ): Promise<VfsStat | null> {
    return this.io("move", path, () =>
      invoke("vfs_move", {
        mountId: this.id,
        path,
        destination,
        revision,
      }),
    );
  }
  async file(
    path: string,
    metadata: VfsFileMetadata,
  ): Promise<StoredFile> {
    const stat = await this.stat(path);
    if (!stat || stat.kind !== "file")
      throw new LocalFileSystemError(
        "open",
        path,
        new Error("File is unavailable"),
      );
    const type = metadata.type || mimeType(metadata.name);
    const token = await this.io("open", path, () =>
      invoke<string>("vfs_media", {
        mountId: this.id,
        path,
        mime: type,
        revision: stat.revision,
      }),
    );
    return new RangeFile(
      metadata.name,
      stat.size,
      type,
      metadata.lastModified,
      (offset, length) =>
        this.readVersion(
          path,
          offset,
          length,
          stat.revision,
        ),
      convertFileSrc(token, "weblink-file"),
    );
  }
  async watch(changed: () => void): Promise<() => void> {
    let stopped = false;
    let id: string | undefined;
    let connecting = false;
    const connect = async () => {
      if (stopped || id || connecting) return;
      connecting = true;
      const channel = new Channel<null>();
      channel.onmessage = () => {
        if (!stopped) changed();
      };
      try {
        const watchId = await invoke<string>("vfs_watch", {
          mountId: this.id,
          onChange: channel,
        });
        if (stopped)
          await invoke("vfs_unwatch", { id: watchId });
        else id = watchId;
      } catch {
        /* Offline volumes remain mounted; polling retries and repairs missed events. */
      } finally {
        connecting = false;
      }
    };
    await connect();
    const timer = setInterval(() => {
      void connect();
      changed();
    }, 10_000);
    const focus = () => changed();
    window.addEventListener("focus", focus);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      if (id)
        void invoke("vfs_unwatch", { id }).catch(
          console.error,
        );
    };
  }
}

export const nativeFileSystem: NativeFileSystem = {
  openDirectory: (mountId) =>
    invoke("vfs_open_directory", { mountId }),
  revealFile: (mountId, path) =>
    invoke("vfs_reveal_file", { mountId, path }),
  async volumes() {
    return (
      await invoke<VfsVolumeInfo[]>("vfs_volumes")
    ).map(
      (volume) => new NativeVolume(volume.id, volume.name),
    );
  },
  async pickDirectory() {
    const volume = await invoke<VfsVolumeInfo | null>(
      "vfs_pick_directory",
    );
    return volume
      ? new NativeVolume(volume.id, volume.name)
      : null;
  },
};
