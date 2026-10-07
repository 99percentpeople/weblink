// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import {
  renderHook,
  cleanup,
} from "@solidjs/testing-library";
import {
  createRemoteCursor,
  type LocalCursorFrame,
  type LocalCursorRenderer,
} from "@/libs/hooks/remote-cursor";
import {
  cursorGeometry,
  parseRemoteCursorShape,
  type RemoteCursorImage,
  type RemoteCursorOwner,
  type RemoteCursorShape,
} from "@/libs/domain/protocol/remote-control/cursor";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLkAAAAASUVORK5CYII=";
const bitmap: RemoteCursorShape = {
  type: "image",
  png,
  width: 1,
  height: 1,
  sourceScale: 100,
  hotspotX: 0,
  hotspotY: 0,
};

it("accepts bounded PNGs and rejects URLs, oversized decoded images and invalid hotspots", () => {
  expect(parseRemoteCursorShape(bitmap)).toEqual(bitmap);
  for (const patch of [
    { png: "https://example.com/cursor.png" },
    { png: "A".repeat(24000) },
    { width: 129 },
    { width: 2 },
    { hotspotX: 1 },
    { hotspotY: -1 },
    { width: 0.5 },
    { png: btoa("<svg></svg>") },
    ...[undefined, 0, 99, 501, 100.5, NaN, Infinity].map(
      (sourceScale) => ({ sourceScale }),
    ),
  ])
    expect(
      parseRemoteCursorShape({ ...bitmap, ...patch }),
    ).toBeUndefined();
  expect(
    parseRemoteCursorShape({
      type: "system",
      name: 'url("x")',
    }),
  ).toBeUndefined();
  const bytes = atob(png);
  const large =
    bytes.slice(0, 16) +
    "\xff\xff\xff\xff" +
    bytes.slice(20);
  expect(
    parseRemoteCursorShape({ ...bitmap, png: btoa(large) }),
  ).toBeUndefined();
});

it("validates source pixels independently of logical size and retains fractional hotspots", () => {
  const sized = (
    width: number,
    height: number,
    sourceScale: number,
  ): RemoteCursorImage => {
    // Header validation is independent of the later browser decode/CRC checks.
    const bytes = Uint8Array.from(atob(png), (c) =>
      c.charCodeAt(0),
    );
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return {
      ...bitmap,
      width,
      height,
      sourceScale,
      hotspotX: width - 1,
      hotspotY: height - 1,
      png: btoa(String.fromCharCode(...bytes)),
    };
  };
  for (const scale of [100, 125, 150, 175, 200, 300, 500]) {
    const image = sized(
      (128 * scale) / 100,
      (64 * scale) / 100,
      scale,
    );
    expect(parseRemoteCursorShape(image)).toEqual(image);
    expect(cursorGeometry(image)).toMatchObject({
      width: 128,
      height: 64,
    });
    expect(
      parseRemoteCursorShape({
        ...image,
        sourceScale: scale - 1,
      }),
    ).toBeUndefined();
    expect(
      parseRemoteCursorShape({ ...image, width: 128 }),
    ).toEqual(scale === 100 ? image : undefined);
  }
  const fractional = sized(41, 26, 125);
  expect(parseRemoteCursorShape(fractional)).toEqual(
    fractional,
  );
  expect(cursorGeometry(fractional)).toEqual({
    width: 32.8,
    height: 20.8,
    hotspotX: 32,
    hotspotY: 20,
  });
});

function setup(paint?: LocalCursorRenderer["paint"]) {
  let failed: (() => void) | undefined;
  let listener:
    | ((
        shape: RemoteCursorShape | undefined,
        owner: RemoteCursorOwner,
      ) => void)
    | undefined;
  const stop = vi.fn(() => {
    listener = undefined;
  });
  const setCursorVisible = vi.fn();
  const control = {
    setCursorVisible,
    watchCursor: vi.fn((next: typeof listener) => {
      listener = next;
      next?.(undefined, "viewer");
      return stop;
    }),
  } as unknown as RemotePointer;
  const [enabled, enable] = createSignal(false);
  const { result, cleanup } = renderHook(() =>
    createRemoteCursor(
      () => control,
      enabled,
      () => true,
      paint
        ? {
            paint,
            watchFailure: (listener) => {
              failed = listener;
              return () => {
                failed = undefined;
              };
            },
          }
        : undefined,
    ),
  );
  return {
    result,
    enable,
    setCursorVisible,
    stop,
    cleanup,
    update: (
      shape: RemoteCursorShape,
      owner: RemoteCursorOwner = "viewer",
    ) => listener?.(shape, owner),
    fail: () => failed?.(),
  };
}

it("watches only while enabled and restores the video cursor on leaving the surface", () => {
  const f = setup();
  expect(f.setCursorVisible).not.toHaveBeenCalled();
  f.enable(true);
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(
    false,
  );
  f.update({ type: "system", name: "text" });
  expect(f.result()).toBe("text");
  f.update({ type: "unknown" });
  expect(f.result()).toBe("none");
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
  f.update({ type: "system", name: "none" });
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(
    false,
  );
  f.enable(false);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.result()).toBeUndefined();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
});

it("loads custom images before hiding the video cursor and ignores retired decodes", () => {
  const images: any[] = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        images.push(this);
      }
    },
  );
  const f = setup();
  f.enable(true);
  f.update({ type: "unknown" });
  f.update(bitmap);
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
  const retired = images[0].onload;
  f.update({ type: "system", name: "pointer" });
  retired();
  expect(f.result()).toBe("pointer");
  f.update(bitmap);
  images[1].onload();
  expect(f.result()).toContain("data:image/png;base64,");
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(
    false,
  );
  f.update(bitmap);
  // Reusing an already decoded asset requires neither another decode nor a visibility round trip.
  expect(images).toHaveLength(2);
  f.update({ ...bitmap });
  images[2].onerror();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
  f.update({ ...bitmap });
  const closing = images[3].onload;
  f.cleanup();
  closing();
  expect(f.result()).toBeUndefined();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
});

it("plays variable frame durations locally, reuses decodes, and cancels playback on leaving", () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  const images: any[] = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        images.push(this);
      }
    },
  );
  const paint = vi.fn(
    (_frame: LocalCursorFrame | undefined) => true,
  );
  const f = setup(paint);
  const animation: RemoteCursorShape = {
    type: "animation",
    frames: [
      { image: bitmap, durationMs: 40 },
      { image: bitmap, durationMs: 80 },
    ],
  };
  f.enable(true);
  f.update(animation);
  expect(images).toHaveLength(1); // repeated images share one decode
  images[0].onload();
  expect(paint.mock.lastCall?.[0]).toMatchObject({
    durationMs: 40,
  });
  expect(f.result()).toBe("none");
  const calls = f.setCursorVisible.mock.calls.length;
  vi.advanceTimersByTime(40);
  expect(paint.mock.lastCall?.[0]).toMatchObject({
    durationMs: 80,
  });
  vi.advanceTimersByTime(80);
  expect(paint.mock.lastCall?.[0]).toMatchObject({
    durationMs: 40,
  });
  vi.advanceTimersByTime(1200);
  expect(f.setCursorVisible).toHaveBeenCalledTimes(calls);
  f.update({ type: "system", name: "text" });
  expect(vi.getTimerCount()).toBe(0);
  f.update(animation);
  expect(images).toHaveLength(1);
  f.enable(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(paint).toHaveBeenLastCalledWith(undefined);
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
});

it("restores the video cursor if animation decoding or drawing fails", () => {
  const images: any[] = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        images.push(this);
      }
    },
  );
  const f = setup(() => false);
  const animation: RemoteCursorShape = {
    type: "animation",
    frames: [
      { image: bitmap, durationMs: 40 },
      { image: bitmap, durationMs: 80 },
    ],
  };
  f.enable(true);
  f.update(animation);
  images[0].onload();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
  expect(f.result()).toBe("none");
  f.update({ ...animation });
  images[1].onerror();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
});

it.each([true, false])(
  "preserves high-density pixels and applies the source hotspot once (CSS density support: %s)",
  (supported) => {
    let loaded: (() => void) | undefined;
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 64;
        naturalHeight = 64;
        set onload(value: (() => void) | null) {
          if (value) loaded = value;
        }
      },
    );
    vi.stubGlobal("CSS", {
      supports: vi.fn(() => supported),
    });
    const paint = vi.fn(
      (_frame: LocalCursorFrame | undefined) => true,
    );
    const f = setup(paint);
    const image: RemoteCursorImage = {
      ...bitmap,
      width: 64,
      height: 64,
      hotspotX: 32,
      hotspotY: 24,
      sourceScale: 200,
    };
    f.enable(true);
    f.update(image);
    const visibilityCalls =
      f.setCursorVisible.mock.calls.length;
    loaded!();
    if (supported) {
      expect(f.result()).toBe(
        `image-set(url("data:image/png;base64,${png}") 2x) 16 12, default`,
      );
      expect(paint).toHaveBeenLastCalledWith(undefined);
    } else {
      expect(f.result()).toBe("none");
      expect(paint.mock.lastCall?.[0]?.shape).toBe(image);
    }
    expect(f.setCursorVisible).toHaveBeenCalledTimes(
      visibilityCalls + 1,
    );
    expect(f.setCursorVisible).toHaveBeenLastCalledWith(
      false,
    );
    f.update({ type: "system", name: "wait" });
    expect(f.result()).toBe("wait");
    expect(paint).toHaveBeenLastCalledWith(undefined);
  },
);

it("cancels animation when a later DPR redraw fails and detaches the failure listener on leaving", () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  let loaded: (() => void) | undefined;
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      set onload(value: (() => void) | null) {
        if (value) loaded = value;
      }
    },
  );
  const paint = vi.fn(
    (_frame: LocalCursorFrame | undefined) => true,
  );
  const f = setup(paint);
  f.enable(true);
  f.update({
    type: "animation",
    frames: [
      { image: bitmap, durationMs: 40 },
      { image: bitmap, durationMs: 80 },
    ],
  });
  loaded!();
  expect(vi.getTimerCount()).toBe(1);
  f.fail();
  expect(vi.getTimerCount()).toBe(0);
  expect(paint).toHaveBeenLastCalledWith(undefined);
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
  const draws = paint.mock.calls.length;
  vi.advanceTimersByTime(1000);
  expect(paint).toHaveBeenCalledTimes(draws);
  f.enable(false);
  const calls = f.setCursorVisible.mock.calls.length;
  f.fail();
  expect(f.setCursorVisible).toHaveBeenCalledTimes(calls);
});

it("yields animation to native host movement without a visibility echo and resumes cached frames on viewer movement", () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  const images: { onload?: () => void }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 1;
      naturalHeight = 1;
      constructor() {
        images.push(this);
      }
      onload?: () => void;
    },
  );
  const paint = vi.fn(
    (_frame: LocalCursorFrame | undefined) => true,
  );
  const f = setup(paint);
  const animation: RemoteCursorShape = {
    type: "animation",
    frames: [
      { image: bitmap, durationMs: 40 },
      { image: bitmap, durationMs: 80 },
    ],
  };
  f.enable(true);
  f.update(animation);
  images[0].onload!();
  expect(vi.getTimerCount()).toBe(1);
  const calls = f.setCursorVisible.mock.calls.length;
  f.update({ type: "unknown" }, "host");
  expect(vi.getTimerCount()).toBe(0);
  expect(f.result()).toBe("none");
  expect(paint).toHaveBeenLastCalledWith(undefined);
  expect(f.setCursorVisible).toHaveBeenCalledTimes(calls);
  vi.advanceTimersByTime(1000);
  expect(paint).toHaveBeenLastCalledWith(undefined);
  f.update(animation, "viewer");
  expect(images).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(1);
  expect(paint.mock.lastCall?.[0]?.shape).toBe(bitmap);
  f.update({ ...bitmap });
  const lateDecode = images[1].onload!;
  f.update({ type: "unknown" }, "host");
  const before = f.setCursorVisible.mock.calls.length;
  lateDecode();
  expect(paint).toHaveBeenLastCalledWith(undefined);
  expect(f.setCursorVisible).toHaveBeenCalledTimes(before);
  f.update({ type: "system", name: "text" }, "viewer");
  expect(f.result()).toBe("text");
});
