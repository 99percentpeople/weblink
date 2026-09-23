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
  constructor(
    private reference: FileReference,
    private readonly read: () => Promise<File | null>,
    private readonly update: (
      reference: FileReference,
    ) => Promise<void>,
    private readonly release: () => Promise<void>,
  ) {
    super();
    this.id = reference.id;
  }
  async refresh(reference: FileReference): Promise<void> {
    this.reference = reference;
    await this.initialize();
  }
  async initialize(): Promise<void> {
    this.dispatchEvent("update", await this.getInfo());
  }
  async getFile(): Promise<File | null> {
    if (this.removed) return null;
    const file = await this.read();
    if (
      !file ||
      this.removed ||
      file.size !== this.reference.fileSize
    )
      return null;
    return new File([file], this.reference.fileName, {
      type: this.reference.mimetype,
      lastModified: this.reference.lastModified,
    });
  }
  async getInfo(): Promise<FileMetaData> {
    const file = await this.getFile();
    return {
      ...this.reference,
      file: file ?? undefined,
      isComplete: !!file,
      chunkCount: 0,
      cachedBytes: file?.size ?? 0,
      isMerging: false,
    };
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
    this.dispatchEvent("cleanup", undefined);
  }
}
