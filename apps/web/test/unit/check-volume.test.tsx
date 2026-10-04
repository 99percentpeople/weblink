// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createCheckVolume } from "@/libs/hooks/check-volume";

const native = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: { watchVisibility: native.watch },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("releases analysis while hidden and cancels queued work without stopping borrowed tracks", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  let visibility!: (visible: boolean) => void;
  const unwatch = vi.fn();
  native.watch.mockImplementation((listener) => {
    visibility = listener;
    listener(true);
    return unwatch;
  });
  const contexts: Analysis[] = [];
  class Analysis {
    state = "running";
    close = vi.fn(async () => {
      this.state = "closed";
    });
    source = { connect: vi.fn(), disconnect: vi.fn() };
    analyser = {
      fftSize: 0,
      getByteFrequencyData: vi.fn((data: Uint8Array) =>
        data.fill(40),
      ),
      disconnect: vi.fn(),
    };
    constructor() {
      contexts.push(this);
    }
    createMediaStreamSource() {
      return this.source;
    }
    createAnalyser() {
      return this.analyser;
    }
  }
  vi.stubGlobal("AudioContext", Analysis);
  let frame!: FrameRequestCallback;
  vi.spyOn(
    window,
    "requestAnimationFrame",
  ).mockImplementation((callback) => {
    frame = callback;
    return 42;
  });
  const cancel = vi.spyOn(window, "cancelAnimationFrame");
  const track = { stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  let speaking!: ReturnType<typeof createCheckVolume>;
  const view = render(() => {
    speaking = createCheckVolume(() => stream);
    return <span />;
  });
  expect(speaking()).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  visibility(false);
  expect(cancel).toHaveBeenCalledWith(42);
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(
    contexts[0].source.disconnect,
  ).toHaveBeenCalledOnce();
  expect(speaking()).toBe(false);
  frame(100); // A callback already queued by the browser cannot restart analysis.
  await vi.advanceTimersByTimeAsync(5000);
  expect(
    contexts[0].analyser.getByteFrequencyData,
  ).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  visibility(true);
  expect(contexts).toHaveLength(2);
  expect(speaking()).toBe(true);
  view.unmount();
  expect(contexts[1].close).toHaveBeenCalledOnce();
  expect(unwatch).toHaveBeenCalledOnce();
  expect(track.stop).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
