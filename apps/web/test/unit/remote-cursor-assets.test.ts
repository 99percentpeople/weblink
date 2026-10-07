import { expect, it } from "vitest";
import {
  CursorAssets,
  CURSOR_ASSET_SLOTS,
  MAX_CURSOR_FRAMES,
} from "@/libs/domain/protocol/remote-control/cursor-assets";

const image = {
  type: "image",
  png: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLkAAAAASUVORK5CYII=",
  width: 1,
  height: 1,
  sourceScale: 100,
  hotspotX: 0,
  hotspotY: 0,
};
const reference = { type: "cached", assetId: 0 };
const frame = {
  assetId: 0,
  index: 0,
  count: 2,
  durationMs: 50,
  image,
};

it("assembles a complete animation before use and reuses it until its slot is replaced", () => {
  const cache = new CursorAssets();
  cache.receive(frame);
  expect(cache.resolve(reference)).toEqual({
    type: "unknown",
  });
  cache.receive({ ...frame, index: 1, durationMs: 100 });
  const shape = cache.resolve(reference);
  expect(shape).toEqual({
    type: "animation",
    frames: [
      { image, durationMs: 50 },
      { image, durationMs: 100 },
    ],
  });
  expect(cache.resolve(reference)).toBe(shape);
  cache.receive({ ...frame, count: 1 });
  expect(cache.resolve(reference)).toEqual(image);
  expect(new CursorAssets().resolve(reference)).toEqual({
    type: "unknown",
  });
});

it.each([
  { index: 2 },
  { count: MAX_CURSOR_FRAMES + 1 },
  { count: 0 },
  { durationMs: 0 },
  { durationMs: 10001 },
  { durationMs: NaN },
  { image: { ...image, width: 129 } },
  { image: { type: "animation", frames: [] } },
])(
  "rejects invalid or incomplete resource definitions: %j",
  (patch) => {
    const cache = new CursorAssets();
    cache.receive(frame);
    cache.receive({ ...frame, index: 1, ...patch });
    expect(cache.resolve(reference)).toEqual({
      type: "unknown",
    });
  },
);

it("requires consecutive ordered frames and a bounded slot identifier", () => {
  const cache = new CursorAssets();
  cache.receive({ ...frame, index: 1 });
  expect(cache.resolve(reference)).toEqual({
    type: "unknown",
  });
  for (const assetId of [
    -1,
    0.5,
    CURSOR_ASSET_SLOTS,
    "0",
  ]) {
    cache.receive({ ...frame, assetId, count: 1 });
    expect(
      cache.resolve({ type: "cached", assetId }),
    ).toBeUndefined();
  }
  cache.receive(frame);
  cache.receive({ ...frame, index: 1, count: 3 });
  expect(cache.resolve(reference)).toEqual({
    type: "unknown",
  });
});

it("reuses earlier frames with independent durations and rejects forward references", () => {
  const cache = new CursorAssets();
  cache.receive(frame);
  cache.receive({
    ...frame,
    index: 1,
    image: 0,
    durationMs: 150,
  });
  expect(cache.resolve(reference)).toEqual({
    type: "animation",
    frames: [
      { image, durationMs: 50 },
      { image, durationMs: 150 },
    ],
  });
  for (const image of [-1, 1, 2, 0.5]) {
    cache.receive(frame);
    cache.receive({ ...frame, index: 1, image });
    expect(cache.resolve(reference)).toEqual({
      type: "unknown",
    });
  }
});

it("bounds total resource bytes even when each frame individually fits", () => {
  const cache = new CursorAssets();
  // Valid bounded PNG header; trailing bytes exercise the resource cap independently of browser decoding.
  const padded = {
    ...image,
    png: btoa(atob(image.png) + "x".repeat(15000)),
  };
  for (let index = 0; index < 32; index++)
    cache.receive({
      ...frame,
      image: padded,
      index,
      count: 32,
    });
  expect(cache.resolve(reference)).toEqual({
    type: "unknown",
  });
});

it("bounds decoded high-density pixels but does not charge repeated frame references twice", () => {
  const bytes = Uint8Array.from(atob(image.png), (c) =>
    c.charCodeAt(0),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 640);
  view.setUint32(20, 640);
  const large = {
    ...image,
    width: 640,
    height: 640,
    sourceScale: 500,
    png: btoa(String.fromCharCode(...bytes)),
  };
  const cache = new CursorAssets();
  for (let index = 0; index < 3; index++)
    cache.receive({
      ...frame,
      image: large,
      index,
      count: 3,
    });
  expect(cache.resolve(reference)).toEqual({
    type: "unknown",
  });
  for (let index = 0; index < MAX_CURSOR_FRAMES; index++)
    cache.receive({
      ...frame,
      image: index === 0 ? large : 0,
      index,
      count: MAX_CURSOR_FRAMES,
    });
  const shape = cache.resolve(reference);
  expect(shape?.type).toBe("animation");
  if (shape?.type !== "animation")
    throw new Error("missing animation");
  expect(shape.frames).toHaveLength(MAX_CURSOR_FRAMES);
  expect(shape.frames[0].image).toEqual(large);
  expect(shape.frames[1].image).toBe(shape.frames[0].image);
});
