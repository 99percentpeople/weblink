import {
  element,
  encode,
  join,
  uintBytes,
  unsigned,
} from "./recording-ebml";

const CLUSTER = 0x1f43b675;
const TRACKS = 0x1654ae6b;
const INFO = 0x1549a966;
const CUES = 0x1c53bb6b;
const TOP_LEVEL = new Set([
  INFO,
  TRACKS,
  CLUSTER,
  CUES,
  0x114d9b74,
  0x1941a469,
  0x1043a770,
  0x1254c367,
]);
const MAX_CUES = 8192;
// Three fixed-width Seek entries (Info, Tracks, Cues).
export const SEEK_RESERVATION = 68;

interface Cue {
  time: number;
  cluster: number;
  relative: number;
}
interface Frame {
  track: number;
  time: number;
  key: boolean;
}
interface Parent {
  id: number;
  start: number;
  dataAt: number;
  end: number;
  time?: number;
  track?: number;
  type?: number;
  frame?: Frame;
  referenced?: boolean;
}

/** Inspect element/block headers only; encoded frame bytes are never retained.
 * Offsets refer to the output file, including the reserved SeekHead and Duration.
 * The index is thinned for very long recordings to keep memory bounded. */
export class WebmSeekIndex {
  private offset: number;
  private pending = new Uint8Array(0);
  private skip = 0;
  private parents: Parent[] = [];
  private cues: Cue[] = [];
  private stride = 1;
  private frames = 0;
  private video?: number;
  private info?: number;
  private tracks?: number;
  private invalid = false;

  constructor(private readonly segmentAt: number) {
    this.offset = segmentAt;
  }

  write(input: Uint8Array<ArrayBuffer>): void {
    if (this.invalid) return;
    const bytes = this.pending.length
      ? join(this.pending, input)
      : input;
    this.pending = new Uint8Array(0);
    let at = 0;
    const advance = (length: number) => {
      at += length;
      this.offset += length;
    };
    try {
      while (at < bytes.length) {
        if (this.skip) {
          const length = Math.min(
            this.skip,
            bytes.length - at,
          );
          this.skip -= length;
          advance(length);
          continue;
        }
        this.endParents();
        const item = element(bytes, at);
        if (!item) break;
        let parent = this.parents.at(-1);
        if (
          parent?.id === CLUSTER &&
          parent.end === Infinity &&
          TOP_LEVEL.has(item.id)
        ) {
          this.parents.pop();
          parent = undefined;
        }
        const header = item.dataAt - at;
        const end = this.offset + header + item.size;
        if (parent && end > parent.end)
          throw new Error("Invalid WebM element boundary");
        if (!parent) {
          if (item.id === INFO)
            this.info = this.offset - this.segmentAt;
          if (item.id === TRACKS)
            this.tracks = this.offset - this.segmentAt;
          if (item.id === CUES || item.id === 0x114d9b74)
            throw new Error("WebM is already indexed");
        }
        const master =
          (!parent && item.id === CLUSTER) ||
          (!parent && item.id === TRACKS) ||
          (parent?.id === TRACKS && item.id === 0xae) ||
          (parent?.id === CLUSTER && item.id === 0xa0);
        if (master) {
          if (item.size === Infinity && item.id !== CLUSTER)
            throw new Error("Unknown WebM element size");
          this.parents.push({
            id: item.id,
            start: this.offset,
            dataAt: this.offset + header,
            end,
          });
          advance(header);
          continue;
        }
        if (!Number.isFinite(item.size))
          throw new Error("Unknown WebM element size");
        const block =
          (parent?.id === CLUSTER && item.id === 0xa3) ||
          (parent?.id === 0xa0 && item.id === 0xa1);
        const integer =
          (parent?.id === CLUSTER && item.id === 0xe7) ||
          (parent?.id === 0xae &&
            (item.id === 0xd7 || item.id === 0x83));
        let prefix = 0;
        if (block) {
          if (bytes.length <= item.dataAt) break;
          const width = Math.clz32(bytes[item.dataAt]) - 23;
          if (width > 8 || width + 3 > item.size)
            throw new Error("Invalid WebM block header");
          prefix = width + 3;
        } else if (integer) {
          if (item.size > 8)
            throw new Error("Invalid WebM integer");
          prefix = item.size;
        }
        if (item.dataAt + prefix > bytes.length) break;
        const data = bytes.subarray(
          item.dataAt,
          item.dataAt + prefix,
        );
        if (integer) {
          const value = unsigned(data);
          if (item.id === 0xe7) parent!.time = value;
          else if (item.id === 0xd7) parent!.track = value;
          else parent!.type = value;
        } else if (block) {
          const width = prefix - 3;
          const trackBytes = data.slice(0, width);
          trackBytes[0] &= 0xff >> width;
          const frame = {
            track: unsigned(trackBytes),
            time: new DataView(
              data.buffer,
              data.byteOffset + width,
              2,
            ).getInt16(0),
            key: !!(data[width + 2] & 0x80),
          };
          if (parent!.id === CLUSTER) {
            if (frame.key)
              this.add(frame, parent!, this.offset);
          } else parent!.frame = frame;
        } else if (
          parent?.id === 0xa0 &&
          (item.id === 0xfb || item.id === 0xa4)
        ) {
          // ReferenceBlock or CodecState: not an independently decodable frame.
          parent.referenced = true;
        } else if (
          parent?.id === 0xae &&
          item.id === 0x23314f
        ) {
          // Non-default track timestamp scaling isn't produced by MediaRecorder.
          throw new Error(
            "Unsupported WebM track timestamp scale",
          );
        }
        advance(header + prefix);
        this.skip = item.size - prefix;
      }
      // At most an element header and block prefix, independent of frame size.
      this.pending = bytes.slice(at);
    } catch {
      this.invalid = true;
      this.pending = new Uint8Array(0);
      this.cues = [];
    }
  }

  private endParents(): void {
    while (
      this.parents.length &&
      this.parents.at(-1)!.end <= this.offset
    ) {
      const parent = this.parents.pop()!;
      if (parent.end !== this.offset)
        throw new Error("Invalid WebM parent boundary");
      if (parent.id === 0xae && parent.type === 1)
        this.video = parent.track;
      if (
        parent.id === 0xa0 &&
        parent.frame &&
        !parent.referenced
      ) {
        const cluster = this.parents.at(-1);
        if (cluster?.id === CLUSTER)
          this.add(parent.frame, cluster, parent.start);
      }
    }
  }

  private add(
    frame: Frame,
    cluster: Parent,
    blockAt: number,
  ): void {
    if (
      !this.video ||
      frame.track !== this.video ||
      cluster.time === undefined
    )
      return;
    const time = cluster.time + frame.time;
    if (time < 0 || time <= (this.cues.at(-1)?.time ?? -1))
      return;
    if (this.frames++ % this.stride) return;
    this.cues.push({
      time,
      cluster: cluster.start - this.segmentAt,
      relative: blockAt - cluster.dataAt,
    });
    if (this.cues.length >= MAX_CUES) {
      this.cues = this.cues.filter(
        (_, index) => index % 2 === 0,
      );
      this.stride *= 2;
    }
  }

  finish():
    | {
        cues: Uint8Array<ArrayBuffer>;
        seekHead: Uint8Array<ArrayBuffer>;
      }
    | undefined {
    if (this.invalid || this.skip || this.pending.length)
      return;
    this.endParents();
    if (
      this.parents.some(
        (parent) => parent.end !== Infinity,
      ) ||
      !this.cues.length ||
      !this.video ||
      this.info === undefined ||
      this.tracks === undefined
    )
      return;
    const cues = encode(
      CUES,
      ...this.cues.map((cue) =>
        encode(
          0xbb,
          encode(0xb3, uintBytes(cue.time)),
          encode(
            0xb7,
            encode(0xf7, uintBytes(this.video!)),
            encode(0xf1, uintBytes(cue.cluster)),
            encode(0xf0, uintBytes(cue.relative)),
          ),
        ),
      ),
    );
    const seekHead = encode(
      0x114d9b74,
      ...[
        [INFO, this.info],
        [TRACKS, this.tracks],
        [CUES, this.offset - this.segmentAt],
      ].map(([id, offset]) =>
        encode(
          0x4dbb,
          encode(0x53ab, uintBytes(id)),
          encode(0x53ac, uintBytes(offset, 8)),
        ),
      ),
    );
    return { cues, seekHead };
  }
}
