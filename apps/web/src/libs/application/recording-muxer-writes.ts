import type { VfsWrite } from "@weblink/platform";

/** Append media immediately; retain only small ordered metadata rewrites for VFS close. */
export class RecordingMuxerWrites {
  private position = 0;
  private patchBytes = 0;
  private pendingPackets = 0;
  readonly patches: VfsWrite[] = [];

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
