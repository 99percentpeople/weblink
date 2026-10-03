// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { CaptureSource } from "@weblink/platform";
import { createAppCaptureSources } from "@/libs/state/create-app-capture-sources";

const sources: CaptureSource[] = [
  {
    id: "display-1",
    kind: "monitor",
    name: "Display",
    width: 1920,
    height: 1080,
  },
];
const disposers: (() => void)[] = [];
afterEach(() =>
  disposers.splice(0).forEach((dispose) => dispose()),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function fixture() {
  const api = {
    sources: vi.fn().mockResolvedValue(sources),
  };
  const [supported, setSupported] = createSignal(false);
  let dispose!: () => void;
  const state = createRoot((stop) => {
    dispose = stop;
    return createAppCaptureSources({
      capture: api,
      supported,
    });
  });
  disposers.push(dispose);
  return { state, api, setSupported, dispose };
}

it("waits for support, shares discovery, and preserves sources during refresh failures", async () => {
  const { state, api, setSupported } = fixture();
  await state.refresh();
  expect(api.sources).not.toHaveBeenCalled();
  setSupported(true);
  await Promise.all([state.refresh(), state.refresh()]);
  expect(api.sources).toHaveBeenCalledOnce();
  expect(state.sources()).toEqual(sources);
  const next = deferred<CaptureSource[]>();
  api.sources.mockReturnValueOnce(next.promise);
  window.dispatchEvent(new Event("focus"));
  const reading = state.refresh();
  expect(state.refreshing()).toBe(true);
  expect(state.sources()).toEqual(sources);
  next.resolve([]);
  await reading;
  expect(state.sources()).toEqual([]);
  await state.refresh();
  api.sources.mockRejectedValueOnce(
    new Error("Enumeration failed"),
  );
  await state.refresh();
  expect(state.error()).toBe("Enumeration failed");
  expect(state.sources()).toEqual(sources);
  expect(state.refreshing()).toBe(false);
  await state.refresh();
  expect(state.error()).toBeUndefined();
});

it("discards old responses when support is lost and restored", async () => {
  const { state, api, setSupported } = fixture();
  const stale = deferred<CaptureSource[]>();
  api.sources.mockReturnValueOnce(stale.promise);
  setSupported(true);
  const reading = state.refresh();
  await Promise.resolve();
  setSupported(false);
  expect(state.sources()).toEqual([]);
  setSupported(true);
  await state.refresh();
  stale.resolve([]);
  await reading;
  expect(state.sources()).toEqual(sources);
  expect(state.refreshing()).toBe(false);
});

it("releases focus observation and ignores late responses when AppState is disposed", async () => {
  const { state, api, setSupported, dispose } = fixture();
  const late = deferred<CaptureSource[]>();
  api.sources.mockReturnValueOnce(late.promise);
  setSupported(true);
  const reading = state.refresh();
  await Promise.resolve();
  dispose();
  late.resolve(sources);
  await reading;
  window.dispatchEvent(new Event("focus"));
  expect(state.sources()).toEqual([]);
  expect(api.sources).toHaveBeenCalledOnce();
});
