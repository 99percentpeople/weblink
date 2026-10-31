import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createNativePresentation } from "../src/presentation";

const pixels = vi.hoisted(() => ({
  stop: vi.fn(),
  requestFrame: vi.fn(),
}));
vi.mock("../src/presentation-layout", () => ({
  createPresentationLayout: () => ({
    show: vi.fn(),
    hide: vi.fn(),
  }),
}));
const tick = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Object.defineProperty(
    HTMLCanvasElement.prototype,
    "captureStream",
    {
      configurable: true,
      value: () => ({ getVideoTracks: () => [pixels] }),
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (
    HTMLCanvasElement.prototype as unknown as Record<
      string,
      unknown
    >
  ).captureStream;
  delete (document as unknown as Record<string, unknown>)
    .fullscreenElement;
  document.body.replaceChildren();
});
it("releases a native surface when close races its pending open", async () => {
  let finish!: () => void;
  const calls: string[] = [];
  mockIPC((command) => {
    calls.push(command);
    if (command === "presentation_open")
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
  });
  const presentation = createNativePresentation();
  const surface = presentation.create(
    "receiver",
    false,
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  const opening = surface.open();
  const rejected = expect(opening).rejects.toMatchObject({
    name: "AbortError",
  });
  surface.close();
  surface.close();
  expect(pixels.stop).toHaveBeenCalledOnce();
  expect(
    presentation.recording(
      pixels as unknown as MediaStreamTrack,
    ),
  ).toBeUndefined();
  expect(
    presentation.sample(
      pixels as unknown as MediaStreamTrack,
    ),
  ).toBeUndefined();
  expect(calls).toEqual(["presentation_open"]);
  finish();
  await rejected;
  await tick();
  expect(calls).toEqual([
    "presentation_open",
    "presentation_close",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps an unbound live surface leased and ignores a renewal that fails after close", async () => {
  let renewals = 0;
  let rejectRenewal!: (error: Error) => void;
  const fail = vi.fn();
  mockIPC((command) => {
    if (command !== "presentation_stats") return;
    renewals++;
    if (renewals === 4)
      return new Promise((_, reject) => {
        rejectRenewal = reject;
      });
    return { presentedFrames: 0 };
  });
  const surface = createNativePresentation().create(
    "receiver",
    false,
    vi.fn(),
    vi.fn(),
    fail,
  );
  surface.statsAt = performance.now();
  await surface.open();
  // An unmounted view must survive the native service's 45-second lease.
  await vi.advanceTimersByTimeAsync(46000);
  expect(renewals).toBe(3);
  await vi.advanceTimersByTimeAsync(15000);
  expect(renewals).toBe(4);
  // A slow IPC request must not accumulate another renewal every timer tick.
  await vi.advanceTimersByTimeAsync(30000);
  expect(renewals).toBe(4);
  surface.close();
  rejectRenewal(new Error("Native presentation closed"));
  await tick();
  expect(fail).not.toHaveBeenCalled();
  expect(pixels.stop).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("updates native visibility immediately without waiting for a background animation frame", async () => {
  let visibility!: (visible: boolean) => void;
  const unwatch = vi.fn();
  const presentation = createNativePresentation(
    (changed) => {
      visibility = changed;
      return unwatch;
    },
  );
  const layouts: { visible: boolean }[] = [];
  mockIPC((command, payload) => {
    if (command === "presentation_stats")
      return { presentedFrames: 1 };
    if (command === "presentation_layout")
      layouts.push(
        (payload as { layout: { visible: boolean } })
          .layout,
      );
  });
  const surface = presentation.create(
    "receiver",
    false,
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  surface.size = { width: 640, height: 360 };
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflowX: "visible",
    overflowY: "visible",
  } as CSSStyleDeclaration);
  const video = document.createElement("video");
  document.body.append(video);
  vi.spyOn(video, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 640, 360),
  );
  const unbind = presentation.bind(
    pixels as unknown as MediaStreamTrack,
    video,
  )!;
  await tick();
  expect(layouts.at(-1)?.visible).toBe(true);
  visibility(false);
  await tick();
  expect(layouts.at(-1)?.visible).toBe(false);
  visibility(true);
  await tick();
  expect(layouts.at(-1)?.visible).toBe(true);
  // The top layer escapes a tile whose old ancestor now clips all content.
  const ancestor = document.createElement("div");
  document.body.append(ancestor);
  ancestor.append(video);
  const normal = getComputedStyle(video);
  vi.mocked(getComputedStyle).mockImplementation(
    (element) =>
      element === ancestor
        ? ({
            ...normal,
            overflowX: "hidden",
            overflowY: "hidden",
          } as CSSStyleDeclaration)
        : normal,
  );
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => video,
  });
  document.dispatchEvent(new Event("fullscreenchange"));
  await tick();
  expect(layouts.at(-1)?.visible).toBe(true);
  unbind();
  await tick();
  const count = layouts.length;
  document.dispatchEvent(new Event("visibilitychange"));
  visibility(true);
  await tick();
  expect(layouts).toHaveLength(count);
  expect(unwatch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  surface.close();
  await tick();
});
