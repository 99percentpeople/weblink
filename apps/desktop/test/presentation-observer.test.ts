import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { notifyPresentationLayout } from "@weblink/platform";
import { observePresentationLayout } from "../src/presentation-observer";

let frames: Map<number, FrameRequestCallback>;
let resize: () => void;
let observe: ReturnType<typeof vi.fn>;
let disconnect: ReturnType<typeof vi.fn>;
const step = () => {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
};
const tick = async () => {
  await Promise.resolve();
};
const cleanups: (() => void)[] = [];
function fixture() {
  const tile = document.createElement("div");
  const video = document.createElement("video");
  tile.append(video);
  document.body.append(tile);
  const update = vi.fn();
  const observer = observePresentationLayout(video, update);
  cleanups.push(observer.close);
  return { tile, video, update, observer };
}
beforeEach(() => {
  frames = new Map();
  let sequence = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => {
      frames.set(++sequence, callback);
      return sequence;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    frames.delete(id),
  );
  observe = vi.fn();
  disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("sleeps at rest and coalesces resize, scroll and style invalidations", async () => {
  const { tile, update } = fixture();
  expect(update).toHaveBeenCalledOnce();
  expect(frames.size).toBe(0);
  resize();
  tile.dispatchEvent(new Event("scroll"));
  tile.style.opacity = "0.8";
  await tick();
  expect(frames.size).toBe(1);
  step();
  expect(update).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
  step();
  expect(update).toHaveBeenCalledTimes(2);
});
it("follows compositor-only animations and returns to sleep when finished", () => {
  const { tile, update } = fixture();
  const animation = {
    pending: false,
    playState: "running",
  };
  Object.assign(tile, { getAnimations: () => [animation] });
  notifyPresentationLayout(tile);
  step();
  step();
  expect(update).toHaveBeenCalledTimes(3);
  expect(frames.size).toBe(1);
  animation.playState = "finished";
  step();
  expect(update).toHaveBeenCalledTimes(4);
  expect(frames.size).toBe(0);
});
it("refreshes visibility synchronously and cancels background animation work", () => {
  const { tile, update } = fixture();
  Object.assign(tile, {
    getAnimations: () => [{ playState: "running" }],
  });
  notifyPresentationLayout(tile);
  expect(frames.size).toBe(1);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(update).toHaveBeenCalledTimes(2);
  expect(frames.size).toBe(0);
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  document.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(1);
});
it("reconnects after reparenting and releases all observers and queued frames", async () => {
  const { tile, video, update, observer } = fixture();
  const parent = document.createElement("section");
  document.body.append(parent);
  parent.append(video);
  await tick();
  step();
  expect(observe).toHaveBeenCalledWith(parent);
  video.remove();
  await tick();
  step();
  const calls = update.mock.calls.length;
  observer.request();
  observer.close();
  resize();
  document.dispatchEvent(new Event("visibilitychange"));
  tile.style.opacity = "0.5";
  await tick();
  step();
  expect(update).toHaveBeenCalledTimes(calls);
  expect(frames.size).toBe(0);
  expect(disconnect).toHaveBeenCalled();
});
it("does not wake for unrelated chat text or generated mask geometry", async () => {
  const chat = document.createElement("aside");
  const label = document.createElement("span");
  chat.append(label);
  document.body.append(chat);
  const { update } = fixture();
  label.textContent = "new message";
  await tick();
  expect(frames.size).toBe(0);
  expect(update).toHaveBeenCalledOnce();
});
