import type { VfsWrite } from "@weblink/platform";
import {
  element,
  join,
  sizeBytes,
  unsigned,
  uintBytes,
  type Element,
} from "./recording-ebml";
import {
  SEEK_RESERVATION,
  WebmSeekIndex,
} from "./recording-webm-index";

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const DURATION = 0x4489;
const SCALE = 0x2ad7b1;
const MAX_HEADER = 64 * 1024;

/** Reserve metadata in live WebM's small header, then patch it at close.
 * Media payload is passed through; no full-file buffering or re-encoding.
 * Indexed/finite segments are preserved because inserting bytes would invalidate
 * their offsets. MediaRecorder's live WebM has neither SeekHead nor Cues. */
export class WebmRecordingMetadata {
  private pending = new Uint8Array(0);
  private ready = false;
  private slot?: { offset: number; width: number };
  private scale = 1_000_000;
  private index?: WebmSeekIndex;
  private segment?: Element;
  private versionPatch?: VfsWrite;

  write(
    bytes: Uint8Array<ArrayBuffer>,
  ): Uint8Array<ArrayBuffer> {
    if (this.ready) {
      this.index?.write(bytes);
      return bytes;
    }
    const data = this.pending.length
      ? join(this.pending, bytes)
      : bytes;
    this.pending = new Uint8Array(0);
    try {
      const output = this.prepare(data);
      if (output) {
        this.ready = true;
        if (this.index && this.segment)
          this.index.write(
            output.subarray(this.segment.dataAt),
          );
        return output;
      }
    } catch {
      // Preserve an unfamiliar container rather than corrupting its metadata.
      this.slot = undefined;
      this.index = undefined;
      this.segment = undefined;
      this.versionPatch = undefined;
      this.ready = true;
      return data;
    }
    if (data.length >= MAX_HEADER) {
      this.ready = true;
      return data;
    }
    this.pending = data;
    return new Uint8Array(0);
  }

  private prepare(
    bytes: Uint8Array<ArrayBuffer>,
  ): Uint8Array<ArrayBuffer> | undefined {
    const ebml = element(bytes, 0);
    if (!ebml) return;
    if (ebml.id !== EBML || !Number.isFinite(ebml.size))
      return bytes;
    const segment = element(bytes, ebml.end);
    if (!segment) return;
    if (segment.id !== SEGMENT) return bytes;
    let indexed = false;
    let info: Element | undefined;
    let tracks = false;
    for (let at = segment.dataAt; at < MAX_HEADER; ) {
      const item = element(bytes, at);
      if (!item) return;
      if (item.id === 0x114d9b74 || item.id === 0x1c53bb6b)
        indexed = true;
      if (item.id === 0x1654ae6b) tracks = true;
      if (item.id === 0x1f43b675)
        return info
          ? this.prepareInfo(
              bytes,
              segment,
              info,
              indexed,
              tracks,
            )
          : bytes;
      if (
        !Number.isFinite(item.size) ||
        item.end > MAX_HEADER
      )
        return bytes;
      if (item.end > bytes.length) return;
      if (item.id === INFO) info = item;
      at = item.end;
    }
    return bytes;
  }

  private prepareInfo(
    bytes: Uint8Array<ArrayBuffer>,
    segment: Element,
    item: Element,
    indexed: boolean,
    tracks: boolean,
  ): Uint8Array<ArrayBuffer> {
    let duration: Element | undefined;
    let checksum = false;
    for (let childAt = item.dataAt; childAt < item.end; ) {
      const child = element(bytes, childAt);
      if (!child || child.end > item.end)
        throw new Error("Invalid WebM Info");
      if (child.id === 0xbf) checksum = true;
      if (child.id === DURATION) duration = child;
      if (child.id === SCALE) {
        this.scale = 0;
        for (const byte of bytes.subarray(
          child.dataAt,
          child.end,
        ))
          this.scale = this.scale * 256 + byte;
      }
      childAt = child.end;
    }
    if (
      !Number.isSafeInteger(this.scale) ||
      this.scale <= 0 ||
      checksum
    )
      return bytes;
    if (duration) {
      if (duration.size !== 4 && duration.size !== 8)
        return bytes;
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + duration.dataAt,
        duration.size,
      );
      const value =
        duration.size === 4
          ? view.getFloat32(0)
          : view.getFloat64(0);
      if (!(value > 0 && Number.isFinite(value)))
        this.slot = {
          offset: duration.dataAt,
          width: duration.size,
        };
      return this.slot
        ? this.reserveIndex(bytes, segment, indexed, tracks)
        : bytes;
    }
    if (indexed || Number.isFinite(segment.size))
      return bytes;
    const size = sizeBytes(item.size + 11, item.width);
    const value = new Uint8Array(11);
    value.set([0x44, 0x89, 0x88]);
    this.slot = {
      offset: item.sizeAt + size.length + item.size + 3,
      width: 8,
    };
    return this.reserveIndex(
      join(
        bytes.subarray(0, item.sizeAt),
        size,
        bytes.subarray(item.dataAt, item.end),
        value,
        bytes.subarray(item.end),
      ),
      segment,
      indexed,
      tracks,
    );
  }

  private reserveIndex(
    bytes: Uint8Array<ArrayBuffer>,
    segment: Element,
    indexed: boolean,
    tracks: boolean,
  ): Uint8Array<ArrayBuffer> {
    if (indexed || Number.isFinite(segment.size) || !tracks)
      return bytes;
    const header = element(bytes, 0)!;
    for (let at = header.dataAt; at < header.end; ) {
      const child = element(bytes, at);
      if (
        !child ||
        child.end > header.end ||
        child.id === 0xbf
      )
        return bytes;
      if (
        child.id === 0x4287 &&
        child.size > 0 &&
        child.size <= 8 &&
        unsigned(bytes.subarray(child.dataAt, child.end)) <
          4
      ) {
        // CueRelativePosition requires DocTypeVersion 4; ReadVersion can stay 2.
        this.versionPatch = {
          offset: child.dataAt,
          data: uintBytes(4, child.size),
        };
      }
      at = child.end;
    }
    // Void remains valid even if an unfamiliar payload cannot be indexed.
    const reserved = new Uint8Array(SEEK_RESERVATION);
    reserved.set([0xec, 0x80 | (SEEK_RESERVATION - 2)]);
    this.segment = segment;
    this.index = new WebmSeekIndex(segment.dataAt);
    if (this.slot) this.slot.offset += SEEK_RESERVATION;
    return join(
      bytes.subarray(0, segment.dataAt),
      reserved,
      bytes.subarray(segment.dataAt),
    );
  }

  finish(durationMs: number): {
    tail: Uint8Array<ArrayBuffer>;
    patches: VfsWrite[];
  } {
    let tail = this.pending;
    this.pending = new Uint8Array(0);
    const patches: VfsWrite[] = [];
    if (this.slot && Number.isFinite(durationMs)) {
      const data = new Uint8Array(this.slot.width);
      const view = new DataView(data.buffer);
      const ticks =
        (Math.max(1, durationMs) * 1_000_000) / this.scale;
      if (this.slot.width === 4) view.setFloat32(0, ticks);
      else view.setFloat64(0, ticks);
      patches.push({ offset: this.slot.offset, data });
    }
    const index = this.index?.finish();
    if (index && this.segment) {
      tail = join(tail, index.cues);
      patches.push({
        offset: this.segment.dataAt,
        data: index.seekHead,
      });
      if (this.versionPatch)
        patches.push(this.versionPatch);
      // Keep Segment unknown-sized: MediaRecorder's clusters may also have
      // unknown sizes. A finite Segment around them confuses some demuxers.
    }
    return { tail, patches };
  }
}
