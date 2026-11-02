import type { VfsWrite } from "@weblink/platform";
import { StreamTarget } from "mediabunny";
import type { RecordingEngine } from "./recording-engine";

/** Append media immediately; retain only small ordered metadata rewrites for VFS close. */
export class RecordingMuxerWrites {
  private position = 0;
  private patchBytes = 0;
  private pendingPackets = 0;
  private chunks?: Uint8Array<ArrayBuffer>[] = [];
  private chunkBytes = 0;
  readonly patches: VfsWrite[] = [];

  createTarget(flush: () => void): StreamTarget {
    return new StreamTarget(
      new WritableStream({
        write: (chunk) => {
          if (!this.chunks) return;
          const bytes = this.write(chunk);
          if (!bytes.length) return;
          this.chunks.push(bytes);
          this.chunkBytes += bytes.length;
          if (this.chunkBytes >= 1024 * 1024) flush();
        },
      }),
    );
  }

  flushTo(recorder: RecordingEngine): void {
    if (!this.chunks?.length) return;
    const data = new Blob(this.chunks, {
      type: recorder.mimeType,
    });
    this.chunks = [];
    this.chunkBytes = 0;
    recorder.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data }),
    );
  }

  discard(): void {
    this.chunks = undefined;
    this.chunkBytes = 0;
  }

  /** Interleaving may retain packets if one live audio/video track stops producing. */
  accountPacket(bytes: number): void {
    this.pendingPackets += bytes;
    if (this.pendingPackets > 8 * 1024 * 1024)
      throw new Error(
        "Recording audio/video output stalled; recording stopped before exhausting memory",
      );
  }

  write(chunk: {
    position: number;
    data: Uint8Array;
  }): Uint8Array<ArrayBuffer> {
    if (
      chunk.position < 0 ||
      chunk.position > this.position
    )
      throw new Error(
        "Recording muxer attempted a sparse write",
      );
    const overlap = Math.min(
      chunk.data.length,
      this.position - chunk.position,
    );
    if (overlap) {
      this.patchBytes += overlap;
      if (
        this.patchBytes > 1024 * 1024 ||
        this.patches.length >= 65536
      )
        throw new Error(
          "Recording metadata limit reached; recording stopped before exhausting memory",
        );
      // Preserve write order, including overlapping patches at different offsets.
      this.patches.push({
        offset: chunk.position,
        data: new Uint8Array(
          chunk.data.subarray(0, overlap),
        ),
      });
    }
    const data = new Uint8Array(
      chunk.data.subarray(overlap),
    );
    this.position += data.length;
    this.pendingPackets = Math.max(
      0,
      this.pendingPackets - data.length,
    );
    return data;
  }
}
