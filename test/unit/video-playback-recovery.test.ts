// @vitest-environment jsdom
import { createRoot, createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createVideoPlaybackRecovery } from "@/libs/hooks/video-playback-recovery";

class Track extends EventTarget {
  readyState: MediaStreamTrackState = "live";
}
const observers: Observer[] = [];
class Observer {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly callback: IntersectionObserverCallback,
  ) {
    observers.push(this);
  }
  visible(
    video: HTMLVideoElement,
    isIntersecting: boolean,
  ) {
    this.callback(
      [
        {
          target: video,
          isIntersecting,
        } as unknown as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }
}
let visibility: DocumentVisibilityState = "visible";
let dispose = () => {};
beforeEach(() => {
  visibility = "visible";
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", Observer);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});
afterEach(() => {
  dispose();
  document.body.replaceChildren();
  Reflect.deleteProperty(document, "visibilityState");
  vi.unstubAllGlobals();
});
function setup() {
  const video = document.createElement("video");
  video.srcObject = {} as MediaStream;
  let paused = true;
  Object.defineProperty(video, "paused", {
    configurable: true,
    get: () => paused,
  });
  document.body.append(video);
  const track = new Track();
  const [active, setActive] = createSignal(true);
  const [source, setSource] = createSignal(track);
  const resume = vi.fn(() => {
    paused = false;
  });
  createRoot((cleanup) => {
    dispose = cleanup;
    createVideoPlaybackRecovery({
      video: () => video,
      track: () => source() as unknown as MediaStreamTrack,
      active,
      resume,
    });
  });
  return {
    video,
    track,
    resume,
    setActive,
    setSource,
    pause: () => {
      paused = true;
    },
  };
}

describe("live video playback recovery", () => {
  it("resumes the first visible frame and later track interruptions without restarting playing video", () => {
    const f = setup();
    f.video.dispatchEvent(new Event("loadedmetadata"));
    expect(f.resume).not.toHaveBeenCalled();
    observers[0].visible(f.video, true);
    expect(f.resume).toHaveBeenCalledOnce();
    f.video.dispatchEvent(new Event("canplay"));
    observers[0].visible(f.video, true);
    expect(f.resume).toHaveBeenCalledOnce();
    for (let i = 0; i < 2; i++) {
      f.pause();
      f.track.dispatchEvent(new Event("unmute"));
    }
    expect(f.resume).toHaveBeenCalledTimes(3);
  });

  it("resumes a paused video when it enters the viewport", () => {
    const f = setup();
    observers[0].visible(f.video, false);
    f.video.dispatchEvent(new Event("canplay"));
    window.dispatchEvent(new Event("focus"));
    expect(f.resume).not.toHaveBeenCalled();
    observers[0].visible(f.video, true);
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it("resumes when the sidebar or collapsed thumbnail rail reveals a retained video", async () => {
    const f = setup();
    f.setActive(false);
    observers[0].visible(f.video, true);
    window.dispatchEvent(new Event("pageshow"));
    expect(f.resume).not.toHaveBeenCalled();
    const stream = f.video.srcObject;
    f.setActive(true);
    await Promise.resolve();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBe(stream);
  });

  it.each(["visibilitychange", "pageshow", "focus"])(
    "recovers on %s after returning from the background",
    (event) => {
      const f = setup();
      const target =
        event === "visibilitychange" ? document : window;
      visibility = "hidden";
      observers[0].visible(f.video, true);
      target.dispatchEvent(new Event(event));
      expect(f.resume).not.toHaveBeenCalled();
      visibility = "visible";
      target.dispatchEvent(new Event(event));
      expect(f.resume).toHaveBeenCalledOnce();
    },
  );

  it("starts an unattached stream only after the first visible layout", async () => {
    const f = setup();
    f.video.srcObject = null;
    f.video.dispatchEvent(new Event("canplay"));
    expect(f.resume).not.toHaveBeenCalled();
    f.setActive(false);
    observers[0].visible(f.video, true);
    expect(f.resume).not.toHaveBeenCalled();
    f.setActive(true);
    await Promise.resolve();
    expect(f.resume).toHaveBeenCalledOnce();
  });

  it("refreshes a revealed inline presentation even if WebKit still reports playing", async () => {
    const f = setup();
    observers[0].visible(f.video, true);
    const stream = f.video.srcObject;
    observers[0].visible(f.video, false);
    observers[0].visible(f.video, true);
    expect(f.resume).toHaveBeenCalledTimes(2);
    f.video.dispatchEvent(new Event("canplay"));
    expect(f.resume).toHaveBeenCalledTimes(2);
    for (const event of [
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
      "webkitendfullscreen",
      "resize",
    ]) {
      const count = f.resume.mock.calls.length;
      f.video.dispatchEvent(new Event(event));
      await Promise.resolve();
      expect(f.resume).toHaveBeenCalledTimes(count + 1);
    }
    expect(f.video.srcObject).toBe(stream);
  });

  it("ignores removed sources, stale callbacks and cleanup events", () => {
    const f = setup();
    const old = observers[0];
    f.setSource(new Track());
    expect(old.disconnect).toHaveBeenCalledOnce();
    f.track.dispatchEvent(new Event("unmute"));
    old.visible(f.video, true);
    expect(f.resume).not.toHaveBeenCalled();
    dispose();
    window.dispatchEvent(new Event("focus"));
    f.video.dispatchEvent(new Event("canplay"));
    observers[1].visible(f.video, true);
    expect(f.resume).not.toHaveBeenCalled();
  });

  it("does not resume ended or detached sources", () => {
    const f = setup();
    f.track.readyState = "ended";
    f.video.dispatchEvent(new Event("canplay"));
    f.track.readyState = "live";
    f.video.remove();
    window.dispatchEvent(new Event("focus"));
    expect(f.resume).not.toHaveBeenCalled();
  });

  it("keeps lifecycle recovery when intersection observation is unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const f = setup();
    f.video.dispatchEvent(new Event("canplay"));
    expect(f.resume).toHaveBeenCalledOnce();
  });
});
