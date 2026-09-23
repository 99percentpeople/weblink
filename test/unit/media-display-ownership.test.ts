import { createRoot, createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type Mode = "fullscreen" | "pip";
let createFullscreen: typeof import("@/libs/hooks/fullscreen").createFullscreen;
let createPictureInPicture: typeof import("@/libs/hooks/picture-in-picture").createPictureInPicture;
let fullscreenElement: Element | null = null;
let pipElement: HTMLVideoElement | null = null;
let exitFullscreen: ReturnType<typeof vi.fn>;
let exitPip: ReturnType<typeof vi.fn>;
const cleanups: (() => void)[] = [];

beforeEach(async () => {
  fullscreenElement = null;
  pipElement = null;
  Object.defineProperties(document, {
    fullscreenEnabled: { configurable: true, value: true },
    pictureInPictureEnabled: {
      configurable: true,
      value: true,
    },
    fullscreenElement: {
      configurable: true,
      get: () => fullscreenElement,
    },
    pictureInPictureElement: {
      configurable: true,
      get: () => pipElement,
    },
    exitFullscreen: {
      configurable: true,
      value: (exitFullscreen = vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(
          new Event("fullscreenchange"),
        );
      })),
    },
    exitPictureInPicture: {
      configurable: true,
      value: (exitPip = vi.fn(async () => {
        const previous = pipElement;
        pipElement = null;
        previous?.dispatchEvent(
          new Event("leavepictureinpicture"),
        );
      })),
    },
  });
  ({ createFullscreen } =
    await import("@/libs/hooks/fullscreen"));
  ({ createPictureInPicture } =
    await import("@/libs/hooks/picture-in-picture"));
});
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function mount(
  mode: Mode,
  initial: HTMLVideoElement | null = null,
) {
  return createRoot((dispose) => {
    const [element, setElement] =
      createSignal<HTMLVideoElement | null>(initial);
    cleanups.push(dispose);
    const hook =
      mode === "fullscreen"
        ? createFullscreen(element)
        : createPictureInPicture(element);
    return {
      setElement,
      dispose,
      isThis:
        "isThisElementFullscreen" in hook
          ? hook.isThisElementFullscreen
          : hook.isThisElementInPip,
      exit:
        "exitFullscreen" in hook
          ? hook.exitFullscreen
          : hook.exitPictureInPicture,
    };
  });
}
function activate(mode: Mode, video: HTMLVideoElement) {
  if (mode === "fullscreen") {
    fullscreenElement = video;
    document.dispatchEvent(new Event("fullscreenchange"));
  } else {
    const previous = pipElement;
    pipElement = video;
    previous?.dispatchEvent(
      new Event("leavepictureinpicture"),
    );
    video.dispatchEvent(new Event("enterpictureinpicture"));
  }
}
const exitSpy = (mode: Mode) =>
  mode === "fullscreen" ? exitFullscreen : exitPip;
const current = (mode: Mode) =>
  mode === "fullscreen" ? fullscreenElement : pipElement;
const video = () => document.createElement("video");

describe.each(["fullscreen", "pip"] as const)(
  "%s tile ownership",
  (mode) => {
    it("never treats an absent ref as owning the current display mode", async () => {
      const absent = mount(mode);
      expect(absent.isThis()).toBe(false);
      const active = video();
      const owner = mount(mode, active);
      activate(mode, active);
      expect(owner.isThis()).toBe(true);
      expect(absent.isThis()).toBe(false);
      await absent.exit();
      absent.dispose();
      expect(exitSpy(mode)).not.toHaveBeenCalled();
      expect(current(mode)).toBe(active);
    });

    it("closing or switching another tile leaves the active tile alone", async () => {
      const active = video();
      const owner = mount(mode, active);
      const other = mount(mode, video());
      activate(mode, active);
      other.setElement(video());
      await other.exit();
      other.dispose();
      expect(exitSpy(mode)).not.toHaveBeenCalled();
      expect(current(mode)).toBe(active);
      expect(owner.isThis()).toBe(true);
    });

    it("exits the previous owned element when the tile changes its video or loses its ref", async () => {
      const first = video();
      const owner = mount(mode, first);
      activate(mode, first);
      const second = video();
      owner.setElement(second);
      await Promise.resolve();
      expect(exitSpy(mode)).toHaveBeenCalledOnce();
      expect(current(mode)).toBeNull();
      expect(owner.isThis()).toBe(false);
      activate(mode, second);
      expect(owner.isThis()).toBe(true);
      owner.setElement(null);
      await Promise.resolve();
      expect(exitSpy(mode)).toHaveBeenCalledTimes(2);
      expect(current(mode)).toBeNull();
      expect(owner.isThis()).toBe(false);
    });

    it("does not exit a new owner's mode when the former owner unmounts", async () => {
      const first = video();
      const second = video();
      const previousOwner = mount(mode, first);
      const currentOwner = mount(mode, second);
      activate(mode, first);
      activate(mode, second);
      previousOwner.dispose();
      expect(exitSpy(mode)).not.toHaveBeenCalled();
      expect(current(mode)).toBe(second);
      expect(currentOwner.isThis()).toBe(true);
      currentOwner.dispose();
      await Promise.resolve();
      expect(exitSpy(mode)).toHaveBeenCalledOnce();
      expect(current(mode)).toBeNull();
    });
  },
);
