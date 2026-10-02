// @vitest-environment jsdom
import { ScreenControlRequest } from "@/libs/domain/native-screen/control-request";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import {
  createSignal,
  type ComponentProps,
} from "solid-js";
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

const fixture = vi.hoisted(() => ({
  error: vi.fn(),
  control: undefined as any,
  screenControl: undefined as any,
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    getRemoteControl: () => fixture.control,
    getScreenControl: () => fixture.screenControl,
  },
}));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
// Test tile media/control lifetimes with actions exposed, independently of
// the mobile menu presentation. Keep the real action registration and cleanup.
vi.mock(
  "@/routes/home/components/meeting-tile-actions",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/routes/home/components/meeting-tile-actions")
      >();
    return {
      ...actual,
      MeetingTileActions: (
        props: ComponentProps<
          typeof actual.MeetingTileActions
        >,
      ) => (
        <actual.MeetingTileActions
          {...props}
          compact={false}
        />
      ),
    };
  },
);
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
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal("innerWidth", 390);
  window.dispatchEvent(new Event("resize"));
  fixture.error.mockClear();
  fixture.control = undefined;
  fixture.screenControl = undefined;
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

function setup(main = true) {
  const [local, setLocal] = createSignal(true);
  const [kind, setKind] = createSignal("screen");
  const [pinned, setPinned] = createSignal(main);
  const [track, setTrack] = createSignal(
    new Track("screen-1"),
  );
  const onStop = vi.fn();
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
    const view = setup(false);
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
    const restore = screen.getByRole("button", {
      name: "common.action.exit_fullscreen",
    });
    await waitFor(() => expect(restore).toBeEnabled());
    fireEvent.click(restore);
    await waitFor(() =>
      expect(document.fullscreenElement).toBeNull(),
    );
    expect(cover()).not.toBeNull();
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
    expect(view.pinned()).toBe(true);
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
    const restore = screen.getByRole("button", {
      name: "common.action.exit_fullscreen",
    });
    await waitFor(() => expect(restore).toBeEnabled());
    fireEvent.click(restore);
    await waitFor(() =>
      expect(unlock).toHaveBeenCalledOnce(),
    );
    expect(document.fullscreenElement).toBeNull();
  });
});

it("keeps non-fullscreen keyboard input alive when IME collapses the meeting layout", () => {
  class Control extends EventTarget {
    state = () => "active";
    supportsText = () => true;
    supportsKeyboard = () => true;
    input = vi.fn(() => true);
    resetInput = vi.fn();
    cancel = vi.fn();
  }
  fixture.control = new Control();
  const [visible, setVisible] = createSignal(true);
  const [active, setActive] = createSignal(true);
  const track = new Track("keyboard-video");
  const stream = new Stream([
    track as unknown as MediaStreamTrack,
  ]) as unknown as MediaStream;
  render(() => (
    <MeetingTile
      name="Host"
      stream={stream}
      pinned
      layoutVisible={visible()}
      playbackActive={active()}
    />
  ));
  const video = document.querySelector("video");
  const editor = screen.getByRole("textbox");
  fireEvent.click(
    screen.getByRole("button", {
      name: "remote_control.keyboard_show",
    }),
  );
  expect(document.activeElement).toBe(editor);
  expect(document.fullscreenElement).toBeNull();
  setVisible(false);
  expect(screen.getByRole("textbox")).toBe(editor);
  expect(document.activeElement).toBe(editor);
  expect(screen.getByRole("application")).toBeDefined();
  expect(document.querySelector("video")).toBe(video);
  setActive(false);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(document.activeElement).not.toBe(editor);
});

it("keeps one remote control action across request, cancellation, active control and recovery", () => {
  class Control extends EventTarget {
    value = "viewing";
    state = () => this.value;
    update(value: string) {
      this.value = value;
      this.dispatchEvent(new Event("change"));
    }
    request = vi.fn(() => this.update("requesting"));
    cancel = vi.fn(() => this.update("viewing"));
    resetInput = vi.fn();
    supportsKeyboard = () => false;
    supportsText = () => false;
  }
  const control = (fixture.control = new Control());
  const view = setup();
  view.setLocal(false);
  const button = screen.getByRole("button", {
    name: "remote_control.request",
  });
  expect(
    button.closest(".meeting-tile-actions"),
  ).not.toBeNull();
  fireEvent.click(button);
  expect(
    screen.getByRole("button", {
      name: "remote_control.cancel",
    }),
  ).toBe(button);
  fireEvent.click(button);
  expect(control.cancel).toHaveBeenCalledOnce();
  fireEvent.click(button);
  control.update("active");
  expect(
    screen.getByRole("button", {
      name: "remote_control.end",
    }),
  ).toBe(button);
  expect(
    screen.queryByRole("button", {
      name: "remote_control.pause",
    }),
  ).toBeNull();
  control.update("activating");
  expect(
    screen.getByRole("button", {
      name: "remote_control.end",
    }),
  ).toBe(button);
  fireEvent.click(button);
  expect(
    screen.getByRole("button", {
      name: "remote_control.request",
    }),
  ).toBe(button);
  control.update("unavailable");
  expect(
    screen.getByRole("button", {
      name: "remote_control.reconnecting",
    }),
  ).toBe(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  control.update("viewing");
  expect((button as HTMLButtonElement).disabled).toBe(
    false,
  );
  view.unmount();
});

it("offers request and cancel on the avatar and hides them when hosting capability is withdrawn", () => {
  const send = vi.fn();
  const control = new ScreenControlRequest(send);
  fixture.screenControl = control;
  render(() => (
    <MeetingTile clientId="host" name="Host" pinned />
  ));
  expect(
    screen.queryByRole("button", {
      name: "remote_control.request",
    }),
  ).toBeNull();
  control.setAvailable(true);
  fireEvent.click(
    screen.getByRole("button", {
      name: "remote_control.request",
    }),
  );
  expect(send.mock.calls[0][0].type).toBe(
    "control-request",
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "remote_control.cancel",
    }),
  );
  expect(send.mock.calls[1][0].type).toBe("control-cancel");
  control.setAvailable(false);
  expect(
    screen.queryByRole("button", {
      name: "remote_control.request",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "remote_control.reconnecting",
    }),
  ).toBeNull();
});
