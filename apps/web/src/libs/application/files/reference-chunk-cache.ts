import type {
  FileStorageLocation,
  StoredFile,
} from "@weblink/platform";
import { namedFile } from "@/libs/utils/stored-file";
import { StorageUnavailableError } from "@/libs/domain/vfs";
import type {
  ChunkCache,
  ChunkCacheEventMap,
  ChunkMetaData,
  FileMetaData,
} from "@/libs/domain/file";
import type { FileReference } from "@/libs/domain/file-library";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";

/** A complete attachment with its own metadata, backed by immutable shared bytes. */
export class ReferenceChunkCache
  extends MultiEventEmitter<ChunkCacheEventMap>
  implements ChunkCache
{
  readonly id: string;
  private removed = false;
  private snapshot?: {
    source: StoredFile;
    file: StoredFile;
  };
  constructor(
    private reference: FileReference,
    private readonly read: () => Promise<StoredFile | null>,
    private readonly update: (
      reference: FileReference,
    ) => Promise<void>,
    private readonly release: () => Promise<void>,
    private readonly shared: () => Promise<boolean> = async () =>
      false,
    private readonly location: () => Promise<FileStorageLocation | null> = async () =>
      null,
  ) {
    super();
    this.id = reference.id;
  }
  async refresh(
    reference: FileReference = this.reference,
  ): Promise<void> {
    this.reference = reference;
    await this.initialize();
  }
  async initialize(): Promise<void> {
    this.dispatchEvent("update", await this.getInfo());
  }
  async getFile(): Promise<StoredFile | null> {
    if (this.removed) return null;
    const file = await this.read();
    if (
      !file ||
      this.removed ||
      file.size !== this.reference.fileSize
    ) {
      this.snapshot = undefined;
      return null;
    }
    const name = this.reference.fileName;
    const type = this.reference.mimetype ?? file.type;
    const modified =
      this.reference.lastModified ?? file.lastModified;
    if (
      this.snapshot?.source === file &&
      this.snapshot.file.name === name &&
      this.snapshot.file.type === type &&
      this.snapshot.file.lastModified === modified
    )
      return this.snapshot.file;
    const named = namedFile(file, name, type, modified);
    this.snapshot = { source: file, file: named };
    return named;
  }
  async getInfo(): Promise<FileMetaData> {
    let file: StoredFile | null = null;
    let storageUnavailable: string | undefined;
    let storageMissing: boolean | undefined;
    try {
      file = await this.getFile();
    } catch (error) {
      if (!(error instanceof StorageUnavailableError))
        throw error;
      file = null;
      storageUnavailable = error.message;
      storageMissing = error.missing;
      this.snapshot = undefined;
    }
    // Permission loss must not move this reference into another storage view.
    const location = await this.storageLocation().catch(
      (error) => {
        if (!(error instanceof StorageUnavailableError))
          throw error;
        storageUnavailable ??= error.message;
        storageMissing ??= error.missing;
        file = null;
        this.snapshot = undefined;
        return null;
      },
    );
    return {
      ...this.reference,
      storageKind: location?.kind,
      storageMountId:
        location?.kind === "indexeddb"
          ? "indexeddb"
          : location?.mountId,
      isShared: await this.shared(),
      file: file ?? undefined,
      isComplete: !!file,
      chunkCount: 0,
      cachedBytes: file?.size ?? 0,
      isMerging: false,
      storageUnavailable,
      storageMissing,
    };
  }
  storageLocation(): Promise<FileStorageLocation | null> {
    return this.removed
      ? Promise.resolve(null)
      : this.location();
  }
  async setInfo(
    data: Omit<ChunkMetaData, "id">,
  ): Promise<void> {
    if (this.removed)
      throw new Error("File reference was removed");
    if (
      data.fileSize !== this.reference.fileSize ||
      data.fileName !== this.reference.fileName ||
      data.roomAttachment !==
        this.reference.roomAttachment ||
      data.roomOfferId !== this.reference.roomOfferId ||
      data.from !== this.reference.from
    )
      throw new Error(
        "Cannot change file reference identity",
      );
    // Transfer headers may repeat metadata, but must never replace shared content.
    const { file: _file, ...metadata } = data;
    this.reference = {
      ...this.reference,
      ...metadata,
      isShared: undefined,
      sharedReference: this.reference.sharedReference,
      libraryPinned: this.reference.libraryPinned,
      id: this.id,
      contentKey: this.reference.contentKey,
      fingerprint: this.reference.fingerprint,
    };
    await this.update(this.reference);
    this.dispatchEvent("update", await this.getInfo());
  }
  async getChunk(
    index: number,
  ): Promise<ArrayBuffer | null> {
    const size = this.reference.chunkSize;
    if (!size || !Number.isSafeInteger(index) || index < 0)
      return null;
    const file = await this.getFile();
    if (!file || index * size >= file.size) return null;
    return file
      .slice(index * size, (index + 1) * size)
      .arrayBuffer();
  }
  async getReqRanges() {
    return (await this.getFile()) ? [] : null;
  }
  async isTransferComplete() {
    return !!(await this.getFile());
  }
  async getChunkCount() {
    return 0;
  }
  async getCachedKeys(): Promise<number[]> {
    return [];
  }
  async calcCachedBytes() {
    return (await this.getFile())?.size ?? 0;
  }
  async storeChunk(): Promise<void> {
    throw new Error("Shared file content is immutable");
  }
  async flush(): Promise<void> {}
  mergeFile() {
    return this.getFile();
  }
  async cleanup(): Promise<void> {
    if (!this.removed) await this.release();
  }
  invalidate(): void {
    if (this.removed) return;
    this.removed = true;
    this.snapshot = undefined;
    this.dispatchEvent("cleanup", undefined);
  }
}
