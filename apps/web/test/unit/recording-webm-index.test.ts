// @vitest-environment node
import { expect, it } from "vitest";
import { WebmRecordingMetadata } from "@/libs/application/recording-webm";

// Independent fixture writer/reader: offsets are checked against the actual
// encoded elements, not against the production indexer's internal state.
const join = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(
    parts.reduce((n, part) => n + part.length, 0),
  );
  let at = 0;
  for (const part of parts) {
    output.set(part, at);
    at += part.length;
  }
  return output;
};
function uint(value: number): Uint8Array<ArrayBuffer> {
  const hex = value
    .toString(16)
    .padStart(
      Math.ceil(value.toString(16).length / 2) * 2,
      "0",
    );
  return Uint8Array.from(
    hex.match(/../g)!.map((pair) => parseInt(pair, 16)),
  );
}
function element(
  id: number,
  ...data: Uint8Array[]
): Uint8Array<ArrayBuffer> {
  const body = join(...data);
  let width = 1;
  while (body.length >= 2 ** (7 * width) - 1) width++;
  return join(
    uint(id),
    uint(2 ** (7 * width) + body.length),
    body,
  );
}
const tracks = element(
  0x1654ae6b,
  element(
    0xae,
    element(0xd7, uint(1)),
    element(0x83, uint(2)),
  ),
  element(
    0xae,
    element(0xd7, uint(2)),
    element(0x83, uint(1)),
  ),
);
const info = element(
  0x1549a966,
  element(0x2ad7b1, uint(1_000_000)),
);
const frame = (
  track: number,
  time: number,
  key: boolean,
  size = 8,
  block = false,
) => {
  const header = new Uint8Array([
    0x80 | track,
    0,
    0,
    key ? 0x80 : 0,
  ]);
  new DataView(header.buffer).setInt16(1, time);
  const data = new Uint8Array(size);
  data.set([0x1f, 0x43, 0xb6, 0x75]); // Not a real element boundary.
  return element(block ? 0xa1 : 0xa3, header, data);
};
const cluster = (
  time: number,
  frames: Uint8Array[],
  unknown = false,
) => {
  const body = join(element(0xe7, uint(time)), ...frames);
  return unknown
    ? join(uint(0x1f43b675), new Uint8Array([0xff]), body)
    : element(0x1f43b675, body);
};
const live = (...body: Uint8Array[]) =>
  join(
    element(0x1a45dfa3),
    uint(0x18538067),
    new Uint8Array([1, 255, 255, 255, 255, 255, 255, 255]),
    ...body,
  );
function read(bytes: Uint8Array, at: number) {
  const vint = (id = false) => {
    const first = bytes[at++];
    let width = 1;
    while (!(first & (0x80 >> (width - 1)))) width++;
    let value = id ? first : first & (0xff >> width);
    for (let i = 1; i < width; i++)
      value = value * 256 + bytes[at++];
    return value;
  };
  const id = vint(true);
  const size = vint();
  return { id, dataAt: at, end: at + size };
}
const number = (bytes: Uint8Array, at: number) => {
  const item = read(bytes, at);
  return bytes
    .subarray(item.dataAt, item.end)
    .reduce((n, b) => n * 256 + b, 0);
};
const children = (bytes: Uint8Array, at: number) => {
  const parent = read(bytes, at);
  const result = new Map<number, number>();
  for (
    let child = parent.dataAt;
    child < parent.end;
    child = read(bytes, child).end
  )
    result.set(read(bytes, child).id, child);
  return result;
};
function finalize(
  input: Uint8Array<ArrayBuffer>,
  chunk = input.length,
) {
  const metadata = new WebmRecordingMetadata();
  const output = [];
  for (let at = 0; at < input.length; at += chunk)
    output.push(
      metadata.write(input.slice(at, at + chunk)),
    );
  const { tail, patches } = metadata.finish(12000);
  const result = join(...output, tail);
  for (const patch of patches)
    result.set(patch.data, patch.offset);
  return result;
}
function index(bytes: Uint8Array) {
  const segment = read(bytes, read(bytes, 0).end);
  expect(segment.end).toBeGreaterThan(bytes.length);
  const seekHead = read(bytes, segment.dataAt);
  expect(seekHead.id).toBe(0x114d9b74);
  const targets = new Map<number, number>();
  for (
    let at = seekHead.dataAt;
    at < seekHead.end;
    at = read(bytes, at).end
  ) {
    const seek = children(bytes, at);
    const id = number(bytes, seek.get(0x53ab)!);
    const position =
      segment.dataAt + number(bytes, seek.get(0x53ac)!);
    expect(read(bytes, position).id).toBe(id);
    targets.set(id, position);
  }
  expect([...targets.keys()]).toEqual([
    0x1549a966, 0x1654ae6b, 0x1c53bb6b,
  ]);
  const cueAt = targets.get(0x1c53bb6b)!;
  const cues = read(bytes, cueAt);
  expect(cues.end).toBe(bytes.length);
  const points = [];
  for (
    let at = cues.dataAt;
    at < cues.end;
    at = read(bytes, at).end
  ) {
    const cue = children(bytes, at);
    const positions = children(bytes, cue.get(0xb7)!);
    const clusterAt =
      segment.dataAt + number(bytes, positions.get(0xf1)!);
    const blockAt =
      read(bytes, clusterAt).dataAt +
      number(bytes, positions.get(0xf0)!);
    expect(read(bytes, clusterAt).id).toBe(0x1f43b675);
    expect([0xa3, 0xa0]).toContain(read(bytes, blockAt).id);
    expect(number(bytes, positions.get(0xf7)!)).toBe(2);
    points.push({
      time: number(bytes, cue.get(0xb3)!),
      clusterAt,
      blockAt,
    });
  }
  return {
    points,
    cueAt,
    tracksEnd: read(bytes, targets.get(0x1654ae6b)!).end,
  };
}

it.each([1, 2, 5, 8, 13, 31, 65536])(
  "indexes real element boundaries across %i-byte writes",
  (chunk) => {
    const media = join(
      cluster(
        1000,
        [
          frame(1, 0, true),
          frame(2, -2, true, 70_000),
          frame(2, 250, false),
          frame(2, 500, true),
        ],
        true,
      ),
      cluster(2000, [frame(2, 0, true)]),
    );
    const bytes = finalize(
      live(info, tracks, media),
      chunk,
    );
    const result = index(bytes);
    expect(result.points.map((cue) => cue.time)).toEqual([
      998, 1500, 2000,
    ]);
    expect(result.points[0].clusterAt).toBe(
      result.points[1].clusterAt,
    );
    expect(result.points[1].blockAt).toBeGreaterThan(
      result.points[0].blockAt + 70_000,
    );
    expect(
      bytes.subarray(result.tracksEnd, result.cueAt),
    ).toEqual(media);
  },
);

it("indexes independent BlockGroups and excludes referenced video and audio", () => {
  const media = cluster(0, [
    element(0xa0, frame(2, 0, false, 8, true)),
    element(
      0xa0,
      frame(2, 500, false, 8, true),
      element(0xfb, uint(1)),
    ),
    element(
      0xa0,
      element(0xfb, uint(1)),
      frame(2, 1000, false, 8, true),
    ),
    element(0xa0, frame(1, 1200, false, 8, true)),
    element(0xa0, frame(2, 1500, false, 8, true)),
  ]);
  expect(
    index(
      finalize(live(info, tracks, media), 3),
    ).points.map((cue) => cue.time),
  ).toEqual([0, 1500]);
});

it("bounds the index for long recordings while retaining seek points throughout", () => {
  const media = Array.from({ length: 20_000 }, (_, i) =>
    cluster(i * 1000, [frame(2, 0, true)]),
  );
  const { points } = index(
    finalize(live(info, tracks, ...media), 1024),
  );
  expect(points.length).toBeLessThan(8192);
  expect(points[0].time).toBe(0);
  expect(points.at(-1)!.time).toBeGreaterThan(19_990_000);
});

it("does not publish a misleading index for truncated or malformed media", () => {
  const media = cluster(0, [frame(2, 0, true)]);
  for (const body of [
    media.slice(0, -1),
    join(media, new Uint8Array([0])),
    join(media, new Uint8Array([0xa3])),
  ]) {
    const bytes = finalize(live(info, tracks, body), 3);
    const segment = read(bytes, read(bytes, 0).end);
    expect(read(bytes, segment.dataAt).id).toBe(0xec);
    expect(bytes.slice(-body.length)).toEqual(body);
  }
});

it("preserves previously indexed segments even when SeekHead follows Info", () => {
  const input = live(
    info,
    element(0x114d9b74),
    tracks,
    cluster(0, [frame(2, 0, true)]),
  );
  expect(finalize(input, 3)).toEqual(input);
});

it("declares version 4 for precise cues without raising the minimum reader version", () => {
  const input = live(
    info,
    tracks,
    cluster(0, [frame(2, 0, true)]),
  );
  const header = element(
    0x1a45dfa3,
    element(0x4287, uint(2)),
    element(0x4285, uint(2)),
  );
  const bytes = finalize(
    join(header, input.subarray(read(input, 0).end)),
    7,
  );
  index(bytes);
  const fields = children(bytes, 0);
  expect(number(bytes, fields.get(0x4287)!)).toBe(4);
  expect(number(bytes, fields.get(0x4285)!)).toBe(2);
});
