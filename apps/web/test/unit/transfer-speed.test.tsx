// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, type Accessor } from "solid-js";
import {
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import createTransferSpeed from "@/libs/hooks/transfer-speed";

const native = vi.hoisted(() => ({ watch: vi.fn() }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: { watchVisibility: native.watch },
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() =>
    Date.now(),
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("samples changes, ignores restored progress, decays to zero, then sleeps", async () => {
  const [bytes, setBytes] = createSignal(0);
  let speed!: Accessor<number | null>;
  const view = render(() => {
    speed = createTransferSpeed(bytes, { windowSize: 3 });
    return <span />;
  });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(speed()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  setBytes(1024); // initial cache progress
  expect(vi.getTimerCount()).toBe(0);
  setBytes(1280);
  await vi.advanceTimersByTimeAsync(250);
  expect(speed()).toBe(1024);
  await vi.advanceTimersByTimeAsync(750);
  expect(speed()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  setBytes(1536);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("suspends native/document-hidden sampling and resets counters on restore or restart", async () => {
  let visible!: (value: boolean) => void;
  const unwatch = vi.fn();
  native.watch.mockImplementation((listener) => {
    visible = listener;
    return unwatch;
  });
  const [bytes, setBytes] = createSignal(0);
  let speed!: Accessor<number | null>;
  const view = render(() => {
    speed = createTransferSpeed(bytes);
    return <span />;
  });
  setBytes(1024);
  setBytes(1280);
  visible(false);
  expect(vi.getTimerCount()).toBe(0);
  setBytes(1024 * 1024);
  await vi.advanceTimersByTimeAsync(30_000);
  visible(true);
  expect(speed()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  setBytes(1024 * 1024 + 256);
  setBytes(1024 * 1024 + 512);
  await vi.advanceTimersByTimeAsync(250);
  expect(speed()).toBe(1024);
  setBytes(0);
  expect(speed()).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  setBytes(1024);
  setBytes(1280);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
  expect(unwatch).toHaveBeenCalledOnce();
});
