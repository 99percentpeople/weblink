import {
  RangeFile,
  type StoredFile,
  type VfsEntry,
  type VfsFileMetadata,
  type VfsStat,
  type VfsVolume,
  type VfsWrite,
} from "@weblink/platform";

/** Native-shaped range reads and atomic moves, with payload IO accounting. */
export class MemoryNativeVolume implements VfsVolume {
  readonly id = "native-default";
  readonly name = "Native files";
  readonly kind = "native";
  readonly capabilities = {
    commit: "sync",
    watch: "native",
  } as const;
  readonly reads: { path: string; length: number }[] = [];
  private version = 0;
  private readonly files = new Map<
    string,
    { bytes: Uint8Array<ArrayBuffer>; stat: VfsStat }
  >();

  async stat(path: string): Promise<VfsStat | null> {
    if (!path)
      return {
        kind: "directory",
        size: 0,
        modified: 0,
        revision: "root",
      };
    const file = this.files.get(path);
    return file ? { ...file.stat } : null;
  }
  async list(path: string): Promise<VfsEntry[]> {
    const prefix = path ? `${path}/` : "";
    return [...this.files].flatMap(([name, file]) => {
      if (!name.startsWith(prefix)) return [];
      const relative = name.slice(prefix.length);
      return relative.includes("/")
        ? []
        : [{ name: relative, ...file.stat }];
    });
  }
  async read(
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) throw new Error("File is missing");
    return file.bytes.slice(offset, offset + length).buffer;
  }
  async commit(
    path: string,
    writes: readonly VfsWrite[],
    size?: number,
  ): Promise<VfsStat> {
    const old = this.files.get(path)?.bytes;
    const bytes = new Uint8Array(
      size ??
        Math.max(
          old?.length ?? 0,
          ...writes.map(
            (write) => write.offset + write.data.length,
          ),
        ),
    );
    if (old) bytes.set(old.subarray(0, bytes.length));
    for (const write of writes)
      bytes.set(write.data, write.offset);
    const stat: VfsStat = {
      kind: "file",
      size: bytes.length,
      modified: ++this.version,
      revision: String(this.version),
    };
    this.files.set(path, { bytes, stat });
    return { ...stat };
  }
  async move(
    path: string,
    destination: string,
    revision: string,
  ): Promise<VfsStat | null> {
    if (this.files.has(destination)) return null;
    const file = this.files.get(path);
    if (!file || file.stat.revision !== revision)
      throw new Error("File changed before move");
    this.files.set(destination, file);
    this.files.delete(path);
    return { ...file.stat };
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async file(
    path: string,
    metadata: VfsFileMetadata,
  ): Promise<StoredFile> {
    const stat = await this.stat(path);
    if (!stat) throw new Error("File is missing");
    return new RangeFile(
      metadata.name,
      stat.size,
      metadata.type,
      metadata.lastModified,
      async (offset, length) => {
        if (
          (await this.stat(path))?.revision !==
          stat.revision
        )
          throw new Error("File snapshot changed");
        this.reads.push({ path, length });
        return this.read(path, offset, length);
      },
    );
  }
  async watch(): Promise<() => void> {
    return () => {};
  }
}
