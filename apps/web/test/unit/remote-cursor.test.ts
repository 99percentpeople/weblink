// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import {
  renderHook,
  cleanup,
} from "@solidjs/testing-library";
import { createRemoteCursor } from "@/libs/hooks/remote-cursor";
import {
  parseRemoteCursorShape,
  type RemoteCursorShape,
} from "@/libs/domain/protocol/remote-control/cursor";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLkAAAAASUVORK5CYII=";
const bitmap: RemoteCursorShape = {
  type: "image",
  png,
  width: 1,
  height: 1,
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

function setup() {
  let listener:
    | ((shape: RemoteCursorShape | undefined) => void)
    | undefined;
  const stop = vi.fn(() => {
    listener = undefined;
  });
  const setCursorVisible = vi.fn();
  const control = {
    setCursorVisible,
    watchCursor: vi.fn((next: typeof listener) => {
      listener = next;
      next?.(undefined);
      return stop;
    }),
  } as unknown as RemotePointer;
  const [enabled, enable] = createSignal(false);
  const { result, cleanup } = renderHook(() =>
    createRemoteCursor(() => control, enabled),
  );
  return {
    result,
    enable,
    setCursorVisible,
    stop,
    cleanup,
    update: (shape: RemoteCursorShape) => listener?.(shape),
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
  images[2].onerror();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
  f.update(bitmap);
  const closing = images[3].onload;
  f.cleanup();
  closing();
  expect(f.result()).toBeUndefined();
  expect(f.setCursorVisible).toHaveBeenLastCalledWith(true);
});
