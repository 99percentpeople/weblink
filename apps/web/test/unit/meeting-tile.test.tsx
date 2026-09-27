// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MeetingTile } from "@/routes/home/components/meeting-tile";

vi.hoisted(() => {
  Object.defineProperty(document, "fullscreenEnabled", {
    configurable: true,
    value: true,
  });
});

const fixture = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconVolumeUpFilled: () => null,
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: () => <span>Avatar</span>,
}));
vi.mock("@/components/common/spinner", () => ({
  Spinner: () => null,
}));
vi.mock("@/libs/hooks/check-volume", () => ({
  createCheckVolume: () => () => false,
}));

class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  enabled = true;
  stop = vi.fn();
  constructor(readonly id: string) {
    super();
  }
}
class Stream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return [...this.tracks];
  }
}

let fullscreenElement: Element | null = null;
const activateFullscreen = (element: Element | null) => {
  fullscreenElement = element;
  document.dispatchEvent(new Event("fullscreenchange"));
};

beforeEach(() => {
  vi.stubGlobal("innerWidth", 390);
  window.dispatchEvent(new Event("resize"));
  fixture.error.mockClear();
  fullscreenElement = null;
  Object.defineProperties(document, {
    fullscreenEnabled: { configurable: true, value: true },
    fullscreenElement: {
      configurable: true,
      get: () => fullscreenElement,
    },
    exitFullscreen: {
      configurable: true,
      value: vi.fn(async () => activateFullscreen(null)),
    },
  });
  vi.stubGlobal("MediaStream", Stream);
  vi.spyOn(
    HTMLMediaElement.prototype,
    "play",
  ).mockResolvedValue();
  vi.spyOn(
    HTMLMediaElement.prototype,
    "pause",
  ).mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of [
    "pictureInPictureEnabled",
    "pictureInPictureElement",
    "exitPictureInPicture",
  ])
    Reflect.deleteProperty(document, key);
  Reflect.deleteProperty(window.screen, "orientation");
});

function setup() {
  const [local, setLocal] = createSignal(true);
  const [kind, setKind] = createSignal("screen");
  const [pinned, setPinned] = createSignal(false);
  const [track, setTrack] = createSignal(
    new Track("screen-1"),
  );
  const onStop = vi.fn();
  const onVideoPipEnter = vi.fn(() => setPinned(true));
  const view = render(() => (
    <MeetingTile
      name="Alice"
      sourceId="source"
      sourceKind={kind()}
      trackId={track().id}
      stream={
        new Stream([
          track() as unknown as MediaStreamTrack,
        ]) as unknown as MediaStream
      }
      local={local()}
      pinned={pinned()}
      onPin={() => setPinned((value) => !value)}
      onVideoPipEnter={onVideoPipEnter}
      onStop={onStop}
    />
  ));
  const video = view.container.querySelector("video")!;
  const display = video.parentElement!;
  display.requestFullscreen = vi.fn(async () =>
    activateFullscreen(display),
  );
  return {
    ...view,
    video,
    display,
    track,
    setTrack,
    setLocal,
    setKind,
    setPinned,
    pinned,
    onVideoPipEnter,
    onStop,
  };
}
const cover = () =>
  screen.queryByRole("button", {
    name: "meeting.show_screen_preview",
  });

it("omits the tile action container when no actions are available", () => {
  const view = render(() => (
    <MeetingTile name="Alice" pinned={false} />
  ));
  expect(
    view.container.querySelector(".meeting-tile-actions"),
  ).toBeNull();
});

it("reflects shared member mute state and delegates audio changes to its owner", () => {
  const audio = new Track("remote-audio");
  audio.kind = "audio";
  const [muted, setMuted] = createSignal(false);
  const toggle = vi.fn(() => setMuted((value) => !value));
  render(() => (
    <MeetingTile
      name="Alice"
      stream={
        new Stream([
          audio as unknown as MediaStreamTrack,
        ]) as unknown as MediaStream
      }
      pinned={false}
      onPin={() => {}}
      audioMuted={muted()}
      onToggleAudio={toggle}
    />
  ));
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.mute",
    }),
  );
  expect(toggle).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", {
      name: "common.action.unmute",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  // A member-list change updates the same control without remounting the tile.
  setMuted(false);
  expect(
    screen.getByRole("button", {
      name: "common.action.mute",
    }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(audio.enabled).toBe(true);
  expect(audio.stop).not.toHaveBeenCalled();
});

describe("local screen preview cover", () => {
  it("covers only a local screen featured in the main view", () => {
    const view = setup();
    expect(cover()).toBeNull();
    view.setPinned(true);
    expect(cover()).not.toBeNull();
    view.setLocal(false);
    expect(cover()).toBeNull();
    view.setLocal(true);
    view.setKind("camera");
    expect(cover()).toBeNull();
    view.setKind("screen");
    fireEvent.click(cover()!);
    expect(cover()).toBeNull();
    view.setPinned(false);
    view.setPinned(true);
    expect(cover()).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    expect(cover()).toBeNull();
    view.setTrack(new Track("screen-2"));
    expect(cover()).not.toBeNull();
  });

  it("keeps the cover and controls inside fullscreen and releases fullscreen when removed", async () => {
    const view = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    expect(document.fullscreenElement).toBe(view.display);
    expect(
      document.fullscreenElement?.contains(cover()),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.exit_fullscreen",
      }),
    );
    expect(document.fullscreenElement).toBeNull();
    expect(cover()).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    fireEvent.click(cover()!);
    expect(cover()).toBeNull();
    expect(document.fullscreenElement).toBe(view.display);
    view.unmount();
    await Promise.resolve();
    expect(document.fullscreenElement).toBeNull();
  });

  it("keeps the shared track and preview element alive while covered or revealed", () => {
    const view = setup();
    const source = view.track();
    const stream = view.video.srcObject;
    view.setPinned(true);
    expect(cover()).not.toBeNull();
    expect(view.video.srcObject).toBe(stream);
    fireEvent.click(cover()!);
    expect(view.container.querySelector("video")).toBe(
      view.video,
    );
    expect(view.video.srcObject).toBe(stream);
    expect(source.enabled).toBe(true);
    expect(source.stop).not.toHaveBeenCalled();
    expect(
      HTMLMediaElement.prototype.pause,
    ).not.toHaveBeenCalled();
    expect(view.onStop).not.toHaveBeenCalled();
  });
});

function nativeVideoPip(view: ReturnType<typeof setup>) {
  let current: HTMLVideoElement | null = null;
  const exit = vi.fn(async () => {
    const previous = current;
    current = null;
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
      get: () => current,
    },
    exitPictureInPicture: {
      configurable: true,
      value: exit,
    },
  });
  const enter = vi.fn(async () => {
    current = view.video;
    view.video.dispatchEvent(
      new Event("enterpictureinpicture"),
    );
    return {} as PictureInPictureWindow;
  });
  view.video.requestPictureInPicture = enter;
  Object.defineProperties(view.video, {
    readyState: { configurable: true, value: 4 },
    videoWidth: { configurable: true, value: 1920 },
    videoHeight: { configurable: true, value: 1080 },
  });
  fireEvent.loadedMetadata(view.video);
  return { enter, exit };
}

describe("native PiP on a meeting tile", () => {
  it.each([false, true])(
    "features the mobile video after confirmed PiP entry without toggling an existing pin (%s)",
    async (alreadyPinned) => {
      const view = setup();
      view.setPinned(alreadyPinned);
      const { enter, exit } = nativeVideoPip(view);
      expect(view.onVideoPipEnter).not.toHaveBeenCalled();
      await enter();
      await waitFor(() =>
        expect(view.onVideoPipEnter).toHaveBeenCalledOnce(),
      );
      expect(view.pinned()).toBe(true);
      fireEvent.loadedMetadata(view.video);
      view.video.dispatchEvent(
        new Event("enterpictureinpicture"),
      );
      await Promise.resolve();
      expect(view.onVideoPipEnter).toHaveBeenCalledOnce();
      await exit();
      expect(view.pinned()).toBe(true);
      expect(view.onVideoPipEnter).toHaveBeenCalledOnce();
    },
  );

  it("does not feature native PiP in the desktop layout, but does when returning to mobile", async () => {
    vi.stubGlobal("innerWidth", 1440);
    window.dispatchEvent(new Event("resize"));
    const view = setup();
    const { enter } = nativeVideoPip(view);
    await enter();
    expect(view.onVideoPipEnter).not.toHaveBeenCalled();
    expect(view.pinned()).toBe(false);
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(view.onVideoPipEnter).toHaveBeenCalledOnce(),
    );
    expect(view.pinned()).toBe(true);
  });

  it("cancels a queued main-view change when the video is removed", async () => {
    const view = setup();
    const { enter } = nativeVideoPip(view);
    const entering = enter();
    view.unmount();
    await entering;
    expect(view.onVideoPipEnter).not.toHaveBeenCalled();
    expect(view.track().stop).not.toHaveBeenCalled();
  });

  it("offers the button only for a supported video, keeps the actual element alive under its placeholder, and restores it", async () => {
    const view = setup();
    expect(
      screen.queryByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    ).toBeNull();
    const { enter, exit } = nativeVideoPip(view);
    const stream = view.video.srcObject;
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    );
    expect(enter).toHaveBeenCalledOnce();
    expect(
      screen.getByText("meeting.pip_video_elsewhere"),
    ).toBeInTheDocument();
    expect(view.container.querySelector("video")).toBe(
      view.video,
    );
    expect(view.video.srcObject).toBe(stream);
    expect(view.track().stop).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.pip_video_restore",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("meeting.pip_video_elsewhere"),
      ).toBeNull(),
    );
    expect(exit).toHaveBeenCalledOnce();
    expect(view.video.srcObject).toBe(stream);
  });

  it("keeps mobile video PiP independent when document PiP also exists", () => {
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(),
    });
    const view = setup();
    nativeVideoPip(view);
    expect(
      screen.queryByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    ).not.toBeNull();
  });

  it("shows the native video entry only in the mobile layout", () => {
    vi.stubGlobal("innerWidth", 1440);
    window.dispatchEvent(new Event("resize"));
    const view = setup();
    nativeVideoPip(view);
    expect(
      screen.queryByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    ).toBeNull();
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    expect(
      screen.getByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    ).toBeInTheDocument();
  });

  it("follows a browser close and exits on removal without stopping the source track", async () => {
    const view = setup();
    const { exit } = nativeVideoPip(view);
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    );
    await exit();
    expect(
      screen.queryByText("meeting.pip_video_elsewhere"),
    ).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "common.action.picture_in_picture",
        }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("meeting.pip_video_elsewhere"),
      ).toBeInTheDocument(),
    );
    view.unmount();
    await waitFor(() =>
      expect(exit).toHaveBeenCalledTimes(2),
    );
    expect(view.track().stop).not.toHaveBeenCalled();
  });

  it("translates browser denial without exposing internal error text", async () => {
    const view = setup();
    const { enter } = nativeVideoPip(view);
    enter.mockRejectedValue(
      new DOMException(
        "Internal renderer detail",
        "NotAllowedError",
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.picture_in_picture",
      }),
    );
    await waitFor(() =>
      expect(fixture.error).toHaveBeenCalledWith(
        "meeting.pip_permission_denied",
      ),
    );
    expect(
      screen.queryByText("meeting.pip_video_elsewhere"),
    ).toBeNull();
    expect(view.onVideoPipEnter).not.toHaveBeenCalled();
    expect(view.pinned()).toBe(false);
  });

  it("requests fullscreen before locking to the actual video ratio and releases orientation on exit", async () => {
    const lock = vi.fn(async () => {
      expect(document.fullscreenElement).not.toBeNull();
    });
    const unlock = vi.fn();
    Object.defineProperty(window.screen, "orientation", {
      configurable: true,
      value: { lock, unlock },
    });
    const view = setup();
    Object.defineProperties(view.video, {
      videoWidth: { value: 720 },
      videoHeight: { value: 1280 },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.fullscreen",
      }),
    );
    await waitFor(() =>
      expect(lock).toHaveBeenCalledWith("portrait"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.exit_fullscreen",
      }),
    );
    expect(unlock).toHaveBeenCalledOnce();
    expect(document.fullscreenElement).toBeNull();
  });
});
