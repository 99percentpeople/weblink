// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  renderHook,
} from "@solidjs/testing-library";
import { createCursorCanvas } from "@/libs/hooks/remote-cursor-canvas";
import type { LocalCursorFrame } from "@/libs/hooks/remote-cursor";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getContext",
  ).mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const queries: {
    media: string;
    change: () => void;
    listeners: Set<() => void>;
  }[] = [];
  vi.stubGlobal("matchMedia", (media: string) => {
    const listeners = new Set<() => void>();
    queries.push({
      media,
      listeners,
      change: () => {
        for (const listener of [...listeners]) listener();
      },
    });
    return {
      addEventListener: (
        _event: string,
        listener: () => void,
      ) => listeners.add(listener),
      removeEventListener: (
        _event: string,
        listener: () => void,
      ) => listeners.delete(listener),
    };
  });
  const { result, cleanup } = renderHook(() =>
    createCursorCanvas(() => document),
  );
  result.move({ clientX: 100, clientY: 200 });
  const frame = (
    sourceScale: number,
  ): LocalCursorFrame => ({
    image: document.createElement("img"),
    durationMs: 100,
    shape: {
      type: "image",
      png: "",
      width: (32 * sourceScale) / 100,
      height: (32 * sourceScale) / 100,
      hotspotX: (16 * sourceScale) / 100,
      hotspotY: (8 * sourceScale) / 100,
      sourceScale,
    },
  });
  const canvas = () => document.querySelector("canvas")!;
  return {
    ...result,
    cleanup,
    context,
    queries,
    frame,
    canvas,
  };
}

it.each([100, 125, 150, 175, 200, 300, 500])(
  "combines host scale %s%% with each viewer DPR without scaling logical size or hotspot twice",
  (sourceScale) => {
    const f = setup();
    const frame = f.frame(sourceScale);
    for (const ratio of [1, 1.25, 1.5, 2, 3]) {
      vi.stubGlobal("devicePixelRatio", ratio);
      expect(f.paint(frame)).toBe(true);
      const canvas = f.canvas();
      expect([canvas.width, canvas.height]).toEqual([
        32 * ratio,
        32 * ratio,
      ]);
      expect([
        canvas.style.width,
        canvas.style.height,
      ]).toEqual(["32px", "32px"]);
      expect(canvas.style.transform).toBe(
        "translate(84px, 192px)",
      );
      expect(f.context.drawImage).toHaveBeenLastCalledWith(
        frame.image,
        0,
        0,
        32 * ratio,
        32 * ratio,
      );
    }
  },
);

it("keeps fractional logical size while rounding only the backing store", () => {
  const f = setup();
  vi.stubGlobal("devicePixelRatio", 1.5);
  const frame = f.frame(125);
  frame.shape.width = 41;
  frame.shape.height = 26;
  frame.shape.hotspotX = 40;
  frame.shape.hotspotY = 25;
  expect(f.paint(frame)).toBe(true);
  const canvas = f.canvas();
  expect([canvas.width, canvas.height]).toEqual([49, 31]);
  expect(parseFloat(canvas.style.width)).toBeCloseTo(32.8);
  expect(parseFloat(canvas.style.height)).toBeCloseTo(20.8);
  expect(canvas.style.transform).toBe(
    "translate(68px, 180px)",
  );
});

it("redraws the current frame when viewer DPI changes, and releases listeners on stopping and cleanup", () => {
  const f = setup();
  vi.stubGlobal("devicePixelRatio", 1);
  const frame = f.frame(200);
  f.paint(frame);
  const first = f.queries[0];
  const retired = [...first.listeners][0];
  expect(first.media).toBe("(resolution: 1dppx)");
  vi.stubGlobal("devicePixelRatio", 2);
  first.change();
  expect(first.listeners.size).toBe(0);
  expect(f.queries[1].media).toBe("(resolution: 2dppx)");
  expect(f.canvas().width).toBe(64);
  expect(f.context.drawImage).toHaveBeenLastCalledWith(
    frame.image,
    0,
    0,
    64,
    64,
  );
  expect(f.canvas().style.transform).toBe(
    "translate(84px, 192px)",
  );
  f.paint(undefined);
  expect(f.queries[1].listeners.size).toBe(0);
  expect(f.canvas()).toBeNull();
  f.paint(frame);
  const calls = f.context.drawImage.mock.calls.length;
  vi.stubGlobal("devicePixelRatio", 3);
  retired();
  expect(f.context.drawImage).toHaveBeenCalledTimes(calls);
  f.cleanup();
  expect(
    f.queries.every((query) => query.listeners.size === 0),
  ).toBe(true);
  expect(f.canvas()).toBeNull();
});

it("reports an asynchronous DPI redraw failure and removes the stale canvas", () => {
  const f = setup();
  vi.stubGlobal("devicePixelRatio", 1);
  const failed = vi.fn();
  const stop = f.watchFailure(failed);
  f.paint(f.frame(200));
  f.context.drawImage.mockImplementationOnce(() => {
    throw new Error("lost drawing context");
  });
  vi.stubGlobal("devicePixelRatio", 2);
  f.queries[0].change();
  expect(failed).toHaveBeenCalledOnce();
  expect(f.canvas()).toBeNull();
  expect(
    f.queries.every((query) => query.listeners.size === 0),
  ).toBe(true);
  stop();
  f.paint(f.frame(200));
  f.context.drawImage.mockImplementationOnce(() => {
    throw new Error("lost drawing context");
  });
  vi.stubGlobal("devicePixelRatio", 3);
  f.refresh();
  expect(failed).toHaveBeenCalledOnce();
  expect(f.canvas()).toBeNull();
});
