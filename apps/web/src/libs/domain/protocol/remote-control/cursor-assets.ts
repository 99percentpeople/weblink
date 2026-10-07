import {
  parseRemoteCursorShape,
  type RemoteCursorFrame,
  type RemoteCursorShape,
} from "./cursor";

export const CURSOR_ASSET_SLOTS = 16;
export const MAX_CURSOR_FRAMES = 64;
export const MAX_CURSOR_ASSET_BYTES = 256 * 1024;
export const MAX_CURSOR_ASSET_PIXELS = 1024 * 1024;

function integer(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** A watch-scoped cache on the ordered control channel. Definitions precede uses;
 * slot replacement is explicit, so neither eviction acknowledgements nor fetches are needed. */
export class CursorAssets {
  private readonly slots = new Map<
    number,
    RemoteCursorShape
  >();
  private pending?: {
    id: number;
    count: number;
    bytes: number;
    pixels: number;
    frames: RemoteCursorFrame[];
  };

  receive(packet: Record<string, unknown>): void {
    const {
      assetId: id,
      index,
      count,
      durationMs,
    } = packet;
    if (!integer(id, 0, CURSOR_ASSET_SLOTS - 1)) return;
    if (index === 0) {
      this.slots.delete(id);
      this.pending = undefined;
    }
    if (
      !integer(count, 1, MAX_CURSOR_FRAMES) ||
      !integer(index, 0, count - 1) ||
      !integer(durationMs, 16, 10000)
    ) {
      this.slots.delete(id);
      this.pending = undefined;
      return;
    }
    if (index === 0)
      this.pending = {
        id,
        count,
        bytes: 0,
        pixels: 0,
        frames: [],
      };
    const pending = this.pending;
    if (
      !pending ||
      pending.id !== id ||
      pending.count !== count ||
      pending.frames.length !== index
    ) {
      this.slots.delete(id);
      this.pending = undefined;
      return;
    }
    // An earlier frame can be reused with a different duration without retransmitting its PNG.
    const repeated = integer(packet.image, 0, index - 1);
    const image = repeated
      ? pending.frames[packet.image as number].image
      : parseRemoteCursorShape(packet.image);
    if (image?.type !== "image") {
      this.pending = undefined;
      return;
    }
    if (!repeated) {
      pending.bytes += image.png.length;
      pending.pixels += image.width * image.height;
    }
    if (
      pending.bytes >
        Math.ceil(MAX_CURSOR_ASSET_BYTES / 3) * 4 ||
      pending.pixels > MAX_CURSOR_ASSET_PIXELS
    ) {
      this.pending = undefined;
      return;
    }
    pending.frames.push({ image, durationMs });
    if (pending.frames.length === count) {
      this.slots.set(
        id,
        count === 1
          ? image
          : { type: "animation", frames: pending.frames },
      );
      this.pending = undefined;
    }
  }

  resolve(value: unknown): RemoteCursorShape | undefined {
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "cached"
    ) {
      const id =
        "assetId" in value ? value.assetId : undefined;
      // A corrupt/incomplete definition must restore the video cursor, never leave a stale local one.
      return integer(id, 0, CURSOR_ASSET_SLOTS - 1)
        ? (this.slots.get(id) ?? { type: "unknown" })
        : undefined;
    }
    return parseRemoteCursorShape(value);
  }
}
