import { createRoot } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDocumentPictureInPicture } from "@/libs/hooks/document-picture-in-picture";
import { createPictureInPicture } from "@/libs/hooks/picture-in-picture";

let element: HTMLVideoElement | null;
let exit: ReturnType<typeof vi.fn>;
const dispose: (() => void)[] = [];
beforeEach(() => {
  element = null;
  exit = vi.fn(async () => {
    const previous = element;
    element = null;
    previous?.dispatchEvent(
      new Event("leavepictureinpicture"),
    );
  });
  Object.defineProperties(document, {
    pictureInPictureEnabled: {
      configurable: true,
      value: true,
    },
    pictureInPictureElement: {
      configurable: true,
      get: () => element,
    },
    exitPictureInPicture: {
      configurable: true,
      value: exit,
    },
  });
});
afterEach(() => {
  dispose.splice(0).forEach((close) => close());
  for (const key of [
    "pictureInPictureEnabled",
    "pictureInPictureElement",
    "exitPictureInPicture",
  ])
    Reflect.deleteProperty(document, key);
});
function fixture() {
  const video = document.createElement("video");
  const enter = vi.fn(async () => {
    element = video;
    video.dispatchEvent(new Event("enterpictureinpicture"));
    return {} as PictureInPictureWindow;
  });
  video.requestPictureInPicture = enter;
  const error = vi.fn();
  const close = vi.fn();
  let stop!: () => void;
  const pip = createRoot((cleanup) => {
    stop = cleanup;
    dispose.push(cleanup);
    return createPictureInPicture(() => video, {
      onError: error,
      onClose: close,
    });
  });
  const ready = () => {
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      videoWidth: { configurable: true, value: 640 },
    });
    video.dispatchEvent(new Event("loadedmetadata"));
  };
  return { video, pip, enter, error, close, stop, ready };
}

describe("video picture-in-picture capabilities and lifecycle", () => {
  it("requires the actual request/exit APIs and metadata, and calls synchronously in the gesture", async () => {
    const f = fixture();
    expect(f.pip.isSupported()).toBe(true);
    await f.pip.requestPictureInPicture();
    expect(f.enter).not.toHaveBeenCalled();
    f.ready();
    const pending = f.pip.requestPictureInPicture();
    expect(f.enter).toHaveBeenCalledOnce();
    await pending;
    expect(f.pip.isThisElementInPip()).toBe(true);
    await f.pip.exitPictureInPicture();
    expect(f.close).toHaveBeenCalledOnce();
    Reflect.deleteProperty(
      f.video,
      "requestPictureInPicture",
    );
    f.video.dispatchEvent(new Event("loadedmetadata"));
    expect(f.pip.isSupported()).toBe(false);
  });

  it.each(["cancel", "dispose"])(
    "closes a delayed native window after %s, without stopping media",
    async (action) => {
      const f = fixture();
      f.ready();
      let resolve!: (
        window: PictureInPictureWindow,
      ) => void;
      f.enter.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = f.pip.requestPictureInPicture();
      expect(f.pip.requestPictureInPicture()).toBe(pending);
      expect(f.pip.isBusy()).toBe(true);
      if (action === "dispose") f.stop();
      else await f.pip.exitPictureInPicture();
      element = f.video;
      resolve({} as PictureInPictureWindow);
      await pending;
      expect(element).toBeNull();
      expect(exit).toHaveBeenCalledOnce();
    },
  );

  it("reports native rejection without entering a retry loop", async () => {
    const f = fixture();
    f.ready();
    const error = new DOMException(
      "blocked",
      "NotAllowedError",
    );
    f.enter.mockRejectedValue(error);
    await f.pip.requestPictureInPicture();
    expect(f.error).toHaveBeenCalledWith(error);
    expect(f.pip.isBusy()).toBe(false);
    expect(f.pip.isThisElementInPip()).toBe(false);
    expect(f.enter).toHaveBeenCalledOnce();
  });

  it("respects WebKit's actual support probe even when standard methods exist", async () => {
    const f = fixture();
    Object.assign(f.video, {
      webkitSupportsPresentationMode: () => false,
    });
    f.ready();
    expect(f.pip.isSupported()).toBe(false);
    await f.pip.requestPictureInPicture();
    expect(f.enter).not.toHaveBeenCalled();
  });

  it("uses WebKit presentation mode and follows its native close event", async () => {
    const f = fixture();
    Reflect.deleteProperty(
      f.video,
      "requestPictureInPicture",
    );
    const webkit = {
      webkitPresentationMode: "inline",
      webkitSupportsPresentationMode: vi.fn(() => true),
      webkitSetPresentationMode: vi.fn((mode: string) => {
        Object.assign(f.video, {
          webkitPresentationMode: mode,
        });
        f.video.dispatchEvent(
          new Event("webkitpresentationmodechanged"),
        );
      }),
    };
    Object.assign(f.video, webkit);
    f.ready();
    expect(f.pip.isSupported()).toBe(true);
    await f.pip.requestPictureInPicture();
    expect(
      webkit.webkitSetPresentationMode,
    ).toHaveBeenCalledWith("picture-in-picture");
    expect(f.pip.isThisElementInPip()).toBe(true);
    webkit.webkitSetPresentationMode("inline");
    expect(f.pip.isThisElementInPip()).toBe(false);
    expect(f.close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});

function documentFixture() {
  const child = new EventTarget();
  const close = vi.fn(() =>
    child.dispatchEvent(new Event("pagehide")),
  );
  Object.assign(child, { close, closed: false });
  const pip = createRoot((cleanup) => {
    dispose.push(cleanup);
    return createDocumentPictureInPicture({
      api: {
        requestWindow: async () => {
          await exit();
          return child as Window;
        },
      },
      onError: vi.fn(),
    });
  });
  return { pip, close };
}

describe("independent video and document PiP lifetimes", () => {
  it("keeps document PiP open after the browser replaces video PiP and the old video tile is removed", async () => {
    const video = fixture();
    video.ready();
    await video.pip.requestPictureInPicture();
    const document = documentFixture();
    await document.pip.open();
    expect(video.pip.isThisElementInPip()).toBe(false);
    expect(document.pip.active()).toBe(true);
    video.stop();
    expect(document.close).not.toHaveBeenCalled();
    expect(document.pip.active()).toBe(true);
  });

  it("keeps video PiP open after a browser-closed document window is cleaned up", async () => {
    const document = documentFixture();
    await document.pip.open();
    const video = fixture();
    video.ready();
    const enter = video.enter.getMockImplementation()!;
    video.enter.mockImplementation(async () => {
      document.close();
      return enter();
    });
    await video.pip.requestPictureInPicture();
    expect(document.pip.active()).toBe(false);
    expect(video.pip.isThisElementInPip()).toBe(true);
    exit.mockClear();
    document.pip.close();
    expect(exit).not.toHaveBeenCalled();
    expect(video.pip.isThisElementInPip()).toBe(true);
  });
});
