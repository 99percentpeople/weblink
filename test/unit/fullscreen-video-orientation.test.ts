import { createRoot, createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createFullscreenVideoOrientation } from "@/libs/hooks/fullscreen-video-orientation";

const cleanup: (() => void)[] = [];
let lock: ReturnType<
  typeof vi.fn<(mode: string) => Promise<void>>
>;
let unlock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  lock = vi.fn(async () => {});
  unlock = vi.fn();
  Object.defineProperty(window.screen, "orientation", {
    configurable: true,
    value: { lock, unlock },
  });
});
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  Reflect.deleteProperty(window.screen, "orientation");
});
function setup() {
  const video = document.createElement("video");
  const [active, setActive] = createSignal(false);
  let dispose!: () => void;
  createRoot((stop) => {
    dispose = stop;
    cleanup.push(stop);
    createFullscreenVideoOrientation(active, () => video);
  });
  const size = (width: number, height: number) => {
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: width },
      videoHeight: { configurable: true, value: height },
    });
    video.dispatchEvent(new Event("resize"));
  };
  return { setActive, size, dispose };
}
describe("fullscreen video orientation", () => {
  it("uses decoded aspect ratio, follows remote rotation, and ignores non-fullscreen video", () => {
    const f = setup();
    f.size(1920, 1080);
    expect(lock).not.toHaveBeenCalled();
    f.setActive(true);
    expect(lock).toHaveBeenLastCalledWith("landscape");
    f.size(1080, 1920);
    expect(lock).toHaveBeenLastCalledWith("portrait");
    f.size(720, 1280);
    expect(lock).toHaveBeenCalledTimes(2);
    f.setActive(false);
    expect(unlock).toHaveBeenCalledOnce();
    f.size(1920, 1080);
    expect(lock).toHaveBeenCalledTimes(2);
  });
  it("waits for dimensions and does not force square video into either orientation", () => {
    const f = setup();
    f.setActive(true);
    expect(lock).not.toHaveBeenCalled();
    f.size(640, 640);
    expect(lock).not.toHaveBeenCalled();
    f.size(640, 480);
    expect(lock).toHaveBeenCalledWith("landscape");
    f.size(640, 640);
    expect(unlock).toHaveBeenCalledOnce();
  });
  it("tolerates missing or rejected orientation support", async () => {
    const f = setup();
    lock.mockRejectedValue(
      new DOMException("Unsupported", "NotSupportedError"),
    );
    f.size(1920, 1080);
    f.setActive(true);
    await Promise.resolve();
    f.dispose();
    Reflect.deleteProperty(window.screen, "orientation");
    const unsupported = setup();
    unsupported.size(1920, 1080);
    expect(() => unsupported.setActive(true)).not.toThrow();
  });
  it("does not unlock a newer fullscreen owner's orientation when an old lock resolves", async () => {
    let resolve!: () => void;
    lock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const first = setup();
    first.size(1920, 1080);
    first.setActive(true);
    first.setActive(false);
    expect(unlock).toHaveBeenCalledOnce();
    const second = setup();
    second.size(720, 1280);
    second.setActive(true);
    resolve();
    await Promise.resolve();
    expect(unlock).toHaveBeenCalledOnce();
    first.dispose();
    expect(unlock).toHaveBeenCalledOnce();
    second.dispose();
    expect(unlock).toHaveBeenCalledTimes(2);
  });
  it("releases a late lock after leaving fullscreen", async () => {
    let resolve!: () => void;
    lock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const f = setup();
    f.size(1920, 1080);
    f.setActive(true);
    f.setActive(false);
    unlock.mockClear();
    resolve();
    await Promise.resolve();
    expect(unlock).toHaveBeenCalledOnce();
  });
});
