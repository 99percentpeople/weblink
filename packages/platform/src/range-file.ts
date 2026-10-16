import type {
  BinarySource,
  StoredFile,
} from "./filesystem";

const READ_SIZE = 1024 * 1024;

/** File-shaped reader backed by bounded range requests, not a materialized Blob. */
export class RangeFile implements StoredFile {
  constructor(
    readonly name: string,
    readonly size: number,
    readonly type: string,
    readonly lastModified: number,
    private readonly read: (
      offset: number,
      length: number,
    ) => Promise<ArrayBuffer>,
    readonly url?: string,
    private readonly start = 0,
  ) {}
  slice(
    start = 0,
    end = this.size,
    type = "",
  ): BinarySource {
    const position = (n: number) =>
      Math.min(
        this.size,
        Math.max(
          0,
          n < 0 ? this.size + Math.trunc(n) : Math.trunc(n),
        ),
      );
    const from = position(start);
    const to = Math.max(from, position(end));
    return new RangeFile(
      this.name,
      to - from,
      type,
      this.lastModified,
      this.read,
      undefined,
      this.start + from,
    );
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(this.size);
    for (
      let offset = 0;
      offset < this.size;
      offset += READ_SIZE
    ) {
      const length = Math.min(
        READ_SIZE,
        this.size - offset,
      );
      const part = await this.read(
        this.start + offset,
        length,
      );
      if (part.byteLength !== length)
        throw new Error("File changed while reading");
      bytes.set(new Uint8Array(part), offset);
    }
    return bytes.buffer;
  }
  async text(): Promise<string> {
    return new TextDecoder().decode(
      await this.arrayBuffer(),
    );
  }
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    let offset = 0;
    return new ReadableStream({
      pull: async (controller) => {
        if (offset >= this.size) return controller.close();
        const length = Math.min(
          READ_SIZE,
          this.size - offset,
        );
        const part = await this.read(
          this.start + offset,
          length,
        );
        if (part.byteLength !== length)
          throw new Error("File changed while reading");
        offset += length;
        controller.enqueue(new Uint8Array(part));
      },
    });
  }
}
