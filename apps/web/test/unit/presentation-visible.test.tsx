// @vitest-environment jsdom
import { createSignal } from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createPresentationVisible } from "@/libs/hooks/presentation-visible";
import { createSessionDiagnostics } from "@/libs/hooks/session-diagnostics";

const native = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: { watchVisibility: native.watch },
}));
let receive!: (visible: boolean) => void;
const unwatch = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  native.watch.mockImplementation((listener) => {
    receive = listener;
    listener(true);
    return unwatch;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("combines native and document visibility without treating blur as hidden", () => {
  let visible!: ReturnType<
    typeof createPresentationVisible
  >;
  const view = render(() => {
    visible = createPresentationVisible();
    return <span />;
  });
  window.dispatchEvent(new Event("blur"));
  expect(visible()).toBe(true);
  receive(false);
  expect(visible()).toBe(false);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  receive(true);
  expect(visible()).toBe(false);
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  document.dispatchEvent(new Event("visibilitychange"));
  expect(visible()).toBe(true);
  view.unmount();
  expect(unwatch).toHaveBeenCalledOnce();
});

it("rebinds document events when presentation moves to another document", () => {
  const other =
    document.implementation.createHTMLDocument();
  vi.spyOn(other, "hidden", "get").mockReturnValue(true);
  const [owner, setOwner] = createSignal(document);
  let visible!: ReturnType<
    typeof createPresentationVisible
  >;
  render(() => {
    visible = createPresentationVisible(owner);
    return <span />;
  });
  expect(visible()).toBe(true);
  setOwner(other);
  expect(visible()).toBe(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(visible()).toBe(false);
  vi.spyOn(other, "hidden", "get").mockReturnValue(false);
  other.dispatchEvent(new Event("visibilitychange"));
  expect(visible()).toBe(true);
});

it("pauses diagnostics, rejects hidden in-flight results and restarts on show", async () => {
  let resolve!: (value: RTCStatsReport) => void;
  const getStats = vi.fn(
    () =>
      new Promise<RTCStatsReport>((done) => {
        resolve = done;
      }),
  );
  const close = vi.fn();
  const connection = {
    getStats,
    close,
  } as unknown as RTCPeerConnection;
  let state!: ReturnType<typeof createSessionDiagnostics>;
  const view = render(() => {
    state = createSessionDiagnostics(
      () => connection,
      () => true,
    );
    return <span />;
  });
  expect(getStats).toHaveBeenCalledOnce();
  receive(false);
  resolve(
    new Map([
      ["late", { id: "late" }],
    ]) as unknown as RTCStatsReport,
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(state().reports).toEqual([]);
  expect(getStats).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  receive(true);
  expect(getStats).toHaveBeenCalledTimes(2);
  resolve(new Map() as unknown as RTCStatsReport);
  await vi.advanceTimersByTimeAsync(1000);
  expect(getStats).toHaveBeenCalledTimes(3);
  view.unmount();
  resolve(new Map() as unknown as RTCStatsReport);
  await vi.advanceTimersByTimeAsync(5000);
  expect(getStats).toHaveBeenCalledTimes(3);
  expect(close).not.toHaveBeenCalled();
});
