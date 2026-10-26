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
import { setAppState } from "@/libs/state/app-state";
import { getAvatarFallbackImage } from "@/libs/utils/avatar";
import type { PeerCapabilities } from "@/libs/domain/protocol/capabilities";
import type { NativeControlStatus } from "@weblink/platform";
import type { Principal } from "@weblink/automation";
import {
  MeetingMediaContext,
  type MeetingMediaContextValue,
} from "@/libs/state/meeting-media-context";
import type { RecordingControls } from "@/libs/state/create-recording";
import type { RecordingState } from "@/libs/application/recording-service";

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
  peerCapabilities:
    vi.fn<() => PeerCapabilities | undefined>(),
  hostStatus: vi.fn<() => NativeControlStatus>(),
  automationController: vi.fn<() => Principal | null>(),
  controlledPeers:
    vi.fn<() => { id: string; name: string }[]>(),
  clipboard: {
    watch: vi.fn(() => () => {}),
    copy: vi.fn(),
    paste: vi.fn(),
  },
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    remoteClipboard: fixture.clipboard,
    peerCapabilities: fixture.peerCapabilities,
    automation: {
      controller: fixture.automationController,
      controlledPeers: fixture.controlledPeers,
    },
  }),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    getRemoteControl: () => fixture.control,
    getScreenControl: () => fixture.screenControl,
    remoteControl: { status: fixture.hostStatus },
  },
}));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));

vi.mock("@/i18n", () => ({
  t: (key: string, values?: { name?: string }) =>
    key === "remote_control.controlled_by"
      ? `Controlled by ${values?.name}`
      : key === "meeting.you"
        ? "You"
        : key,
}));
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
  IconRecord: () => <svg />,
  IconStop: () => <svg />,
  IconPause: () => <svg />,
  IconPlayArrow: () => <svg />,
  IconVolumeUpFilled: () => null,
}));
vi.mock("@/components/common/spinner", () => ({
  Spinner: () => null,
}));
vi.mock(
  "@/components/common/automation-pointer-icon",
  () => ({
    AutomationPointerIcon: () => (
      <svg
        data-testid="automation-pointer"
        aria-hidden="true"
      />
    ),
  }),
);
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  fixture.peerCapabilities.mockReset();
  fixture.hostStatus.mockReset();
  fixture.automationController
    .mockReset()
    .mockReturnValue(null);
  fixture.controlledPeers.mockReset().mockReturnValue([]);
  setAppState("profile", { clientId: "", name: "" });
  setAppState(
    "session",
    "clientViewData",
    "label-controller",
    undefined!,
  );
  fixture.clipboard.watch.mockClear();
  setAppState("capabilities", "clipboard", {
    ready: false,
    write: false,
  });
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    false,
  );
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

it.each([
  { local: true, sourceLabel: "", audioOnly: false },
  { local: true, sourceLabel: "Screen 1", audioOnly: true },
  { local: false, sourceLabel: "Camera", audioOnly: true },
])(
  "uses the participant name for avatars with local=$local and source=$sourceLabel",
  async ({ local, sourceLabel, audioOnly }) => {
    const [name, setName] = createSignal("spinka");
    const displayName = () =>
      local ? `${name()} (You)` : name();
    const audio = new Track("microphone");
    audio.kind = "audio";
    const view = render(() => (
      <MeetingTile
        name={
          sourceLabel
            ? `${displayName()} · ${sourceLabel}`
            : displayName()
        }
        participantName={name()}
        sourceLabel={sourceLabel || undefined}
        local={local}
        stream={
          audioOnly
            ? (new Stream([
                audio as unknown as MediaStreamTrack,
              ]) as unknown as MediaStream)
            : null
        }
        compact
        pinned={false}
      />
    ));
    const avatar = () =>
      view.container.querySelector<HTMLImageElement>(
        'img[src^="data:image/svg+xml,"]',
      );
    await waitFor(() =>
      expect(avatar()?.getAttribute("src")).toBe(
        getAvatarFallbackImage("spinka"),
      ),
    );
    const svg = new DOMParser().parseFromString(
      decodeURIComponent(avatar()!.src.split(",")[1]),
      "image/svg+xml",
    );
    expect(svg.querySelector("text")?.textContent).toBe(
      "SP",
    );
    expect(screen.getByText(displayName())).toBeTruthy();
    setName("Alice Smith");
    await waitFor(() =>
      expect(avatar()?.getAttribute("src")).toBe(
        getAvatarFallbackImage("Alice Smith"),
      ),
    );
    expect(screen.getByText(displayName())).toBeTruthy();
  },
);

it("keeps source details in icon hints and tracks the controller of this screen", () => {
  const [capabilities, setCapabilities] =
    createSignal<PeerCapabilities>({});
  fixture.peerCapabilities.mockImplementation(capabilities);
  const [kind, setKind] = createSignal("screen");
  render(() => (
    <MeetingTile
      name="Alice · Team · Screen 2"
      participantName="Alice · Team"
      sourceKind={kind()}
      sourceLabel="Screen 2"
      controlSourceId="screen-2"
      clientId="host"
      compact
      pinned={false}
    />
  ));
  expect(screen.getByText("Alice · Team")).toBeTruthy();
  expect(
    screen.queryByText("Alice · Team · Screen 2"),
  ).toBeNull();
  expect(screen.queryByText("Screen 2")).toBeNull();
  expect(
    screen.getByRole("img", { name: "Screen 2" }).title,
  ).toBe("Screen 2");
  const control = (
    sourceId: string,
    clientId = "unlisted-controller",
  ) => ({
    control: {
      request: true,
      host: true,
      occupancy: {
        state: "controlled" as const,
        sourceId,
        clientId,
      },
    },
  });
  setCapabilities(control("screen-1"));
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
  setCapabilities(control("screen-2"));
  expect(
    screen.getByRole("img", {
      name: "Controlled by unlisted-controller",
    }).title,
  ).toBe("Controlled by unlisted-controller");
  setAppState(
    "session",
    "clientViewData",
    "label-controller",
    {
      clientId: "label-controller",
      name: "Carol",
      avatar: null,
      createdAt: 0,
      onlineStatus: "online",
      messageChannel: true,
    },
  );
  setCapabilities(control("screen-2", "label-controller"));
  expect(
    screen.getByRole("img", {
      name: "Controlled by Carol",
    }),
  ).toBeTruthy();
  setAppState("profile", {
    clientId: "self-controller",
    name: "Bob",
  });
  setCapabilities(control("screen-2", "self-controller"));
  expect(
    screen.getByRole("img", { name: "Controlled by Bob" }),
  ).toBeTruthy();
  setAppState("profile", "name", "Bobby");
  expect(
    screen.getByRole("img", {
      name: "Controlled by Bobby",
    }),
  ).toBeTruthy();
  setKind("camera");
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
  setKind("screen");
  setCapabilities({
    control: {
      request: true,
      host: true,
      occupancy: {
        state: "pending",
        sourceId: "screen-2",
        clientId: "self-controller",
      },
    },
  });
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
  setCapabilities(control("screen-2"));
  setCapabilities({});
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
});

it("shows control on the matching local screen and clears it when control ends", () => {
  const [status, setStatus] =
    createSignal<NativeControlStatus>({
      closed: false,
      pending: [],
      clientId: "viewer",
      sourceId: "local-screen",
    });
  fixture.hostStatus.mockImplementation(status);
  render(() => (
    <MeetingTile
      name="My screen"
      sourceKind="screen"
      controlSourceId="local-screen"
      local
      compact
      pinned={false}
    />
  ));
  expect(
    screen.getByRole("img", {
      name: "Controlled by viewer",
    }),
  ).toBeTruthy();
  setStatus({ closed: false, pending: [], clientId: null });
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
});

it("uses the header's AI lease only for the matching remote screen and returns to manual control on release", () => {
  setAppState("profile", { clientId: "self", name: "Bob" });
  const [peers, setPeers] = createSignal<
    { id: string; name: string }[]
  >([]);
  fixture.controlledPeers.mockImplementation(peers);
  const [capabilities, setCapabilities] =
    createSignal<PeerCapabilities>({});
  fixture.peerCapabilities.mockImplementation(capabilities);
  const occupancy = (
    sourceId: string,
    clientId = "self",
  ): PeerCapabilities => ({
    control: {
      host: true,
      request: true,
      occupancy: {
        state: "controlled",
        sourceId,
        clientId,
      },
    },
  });
  render(() => (
    <MeetingTile
      name="Host"
      clientId="host"
      sourceKind="screen"
      controlSourceId="screen-2"
      pinned={false}
      compact
    />
  ));
  setCapabilities(occupancy("screen-2"));
  const indicator = screen.getByRole("img", {
    name: "Controlled by Bob",
  });
  expect(
    screen.queryByTestId("automation-pointer"),
  ).toBeNull();
  setPeers([{ id: "other-host", name: "Other host" }]);
  expect(
    screen.queryByTestId("automation-pointer"),
  ).toBeNull();
  setPeers([{ id: "host", name: "Host" }]);
  expect(
    screen.getByTestId("automation-pointer"),
  ).toBeTruthy();
  expect(
    screen.getByRole("img", { name: "Controlled by Bob" }),
  ).toBe(indicator);
  setCapabilities(occupancy("screen-1"));
  expect(
    screen.queryByTestId("automation-pointer"),
  ).toBeNull();
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
  setCapabilities(
    occupancy("screen-2", "another-controller"),
  );
  expect(
    screen.queryByTestId("automation-pointer"),
  ).toBeNull();
  setCapabilities(occupancy("screen-2"));
  expect(
    screen.getByTestId("automation-pointer"),
  ).toBeTruthy();
  setPeers([]);
  expect(
    screen.queryByTestId("automation-pointer"),
  ).toBeNull();
  expect(
    screen.getByRole("img", { name: "Controlled by Bob" }),
  ).toBeTruthy();
  setCapabilities({});
  expect(
    screen.queryByRole("img", { name: /Controlled by/ }),
  ).toBeNull();
});

it.each([
  { kind: "peer", controllerKind: "remote" },
  { kind: "peer", controllerKind: "automation" },
  { kind: "mcp", controllerKind: "automation" },
] as const)(
  "shows local $kind control ($controllerKind) without revealing token identity",
  ({ kind, controllerKind }) => {
    const principal: Principal = {
      id: "agent-id",
      label: "Private token name",
      kind,
    };
    const [active, setActive] =
      createSignal<Principal | null>(principal);
    fixture.automationController.mockImplementation(active);
    const [status, setStatus] =
      createSignal<NativeControlStatus>({
        closed: false,
        pending: [],
        clientId: principal.id,
        sourceId: "screen-2",
        controllerKind,
      });
    fixture.hostStatus.mockImplementation(status);
    render(() => (
      <MeetingTile
        name="My screen"
        sourceKind="screen"
        controlSourceId="screen-2"
        local
        compact
        pinned={false}
      />
    ));
    const label =
      kind === "mcp"
        ? "remote_control.host_active_short"
        : `Controlled by ${principal.label}`;
    const indicator = screen.getByRole("img", {
      name: label,
    });
    expect(
      screen.getByTestId("automation-pointer"),
    ).toBeTruthy();
    if (kind === "mcp") {
      expect(indicator.title).not.toContain(principal.id);
      expect(indicator.title).not.toContain(
        principal.label,
      );
    }
    setStatus((previous) => ({
      ...previous,
      sourceId: "other-screen",
    }));
    expect(
      screen.queryByTestId("automation-pointer"),
    ).toBeNull();
    setStatus((previous) => ({
      ...previous,
      sourceId: "screen-2",
    }));
    expect(
      screen.getByTestId("automation-pointer"),
    ).toBeTruthy();
    setActive(null);
    expect(
      screen.queryByTestId("automation-pointer"),
    ).toBeNull();
    if (controllerKind === "remote")
      expect(
        screen.getByRole("img", {
          name: `Controlled by ${principal.id}`,
        }),
      ).toBeTruthy();
    else
      expect(
        screen.queryByRole("img", { name: label }),
      ).toBeNull();
    setStatus((previous) => ({
      ...previous,
      closed: true,
    }));
    expect(
      screen.queryByRole("img", { name: /Controlled by/ }),
    ).toBeNull();
  },
);

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

it("enables remote input for an unpinned fullscreen tile and releases it on exit", () => {
  class Control extends EventTarget {
    gamepadSlots = () => 0;
    state = () => "active";
    supportsText = () => false;
    supportsKeyboard = () => false;
    resetInput = vi.fn();
    setCursorVisible = vi.fn();
  }
  const control = (fixture.control = new Control());
  const view = setup(false);
  view.setLocal(false);
  expect(screen.queryByRole("application")).toBeNull();
  activateFullscreen(view.display);
  expect(screen.getByRole("application")).toBeDefined();
  expect(view.pinned()).toBe(false);
  control.resetInput.mockClear();
  activateFullscreen(null);
  expect(screen.queryByRole("application")).toBeNull();
  expect(control.resetInput).toHaveBeenCalled();
});

it("keeps non-fullscreen keyboard input alive when IME collapses the meeting layout", () => {
  class Control extends EventTarget {
    gamepadSlots = () => 0;
    state = () => "active";
    supportsText = () => true;
    supportsKeyboard = () => true;
    input = vi.fn(() => true);
    resetInput = vi.fn();
    setCursorVisible = vi.fn();
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
    gamepadSlots = () => 0;
    value = "viewing";
    state = () => this.value;
    update(value: string) {
      this.value = value;
      this.dispatchEvent(new Event("change"));
    }
    request = vi.fn(() => this.update("requesting"));
    cancel = vi.fn(() => this.update("viewing"));
    resetInput = vi.fn();
    setCursorVisible = vi.fn();
    supportsKeyboard = () => false;
    supportsText = () => false;
  }
  const control = (fixture.control = new Control());
  const view = setup();
  view.setLocal(false);
  const button = screen.getByRole("button", {
    name: "remote_control.request",
  });
  const trigger = screen.getByRole("button", {
    name: "meeting.source_actions",
  });
  const menu = document.getElementById(
    trigger.getAttribute("aria-controls")!,
  );
  expect(menu?.contains(button)).toBe(true);
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

it.each([false, true])(
  "requests control from the avatar without promoting it (pinned=%s)",
  (pinned) => {
    const send = vi.fn();
    const activate = vi.fn();
    const control = new ScreenControlRequest(send);
    fixture.screenControl = control;
    render(() => (
      <MeetingTile
        clientId="host"
        name="Host"
        pinned={pinned}
        onActivate={activate}
      />
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
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "remote_control.cancel",
      }),
    );
    expect(send.mock.calls[1][0].type).toBe(
      "control-cancel",
    );
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
  },
);

it("synchronizes the screen peer clipboard without adding action buttons", () => {
  setAppState("capabilities", "clipboard", {
    ready: true,
    write: true,
  });
  class Control extends EventTarget {
    gamepadSlots = () => 0;
    state = () => "active";
    supportsText = () => false;
    supportsKeyboard = () => false;
    clipboardGrant = () => "grant";
    resetInput = vi.fn();
    setCursorVisible = vi.fn();
    cancel = vi.fn();
  }
  const control = (fixture.control = new Control());
  const stream = new Stream([
    new Track(
      "remote-screen",
    ) as unknown as MediaStreamTrack,
  ]) as unknown as MediaStream;
  render(() => (
    <MeetingTile
      clientId="host"
      sourceKind="screen"
      name="Host"
      stream={stream}
      pinned
    />
  ));
  expect(
    screen.getByRole("button", {
      name: "remote_control.end",
    }),
  ).toBeEnabled();
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    true,
  );
  expect(fixture.clipboard.watch).toHaveBeenCalledWith(
    "host",
    control,
    expect.any(Function),
  );
  expect(
    screen.queryByRole("button", {
      name: "remote_control.clipboard_copy",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "remote_control.clipboard_paste",
    }),
  ).toBeNull();
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    false,
  );
  expect(
    screen.queryByRole("button", {
      name: "remote_control.clipboard_paste",
    }),
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "remote_control.end",
    }),
  ).toBeEnabled();
});

it("delegates recording to its application owner and disables other sources until saving finishes", async () => {
  const [state, setState] =
    createSignal<RecordingState | null>(null);
  const start = vi.fn<RecordingControls["start"]>(
    (options) =>
      setState({
        sourceId: options.id,
        name: options.name,
        phase: "recording",
        bytes: 0,
        elapsed: 0,
      }),
  );
  const stop = vi.fn(() =>
    setState(
      (current) =>
        current && { ...current, phase: "saving" as const },
    ),
  );
  const recording: RecordingControls = {
    onSaved: () => () => {},
    state,
    start,
    stop,
    pause: vi.fn(() =>
      setState(
        (current) =>
          current && {
            ...current,
            phase: "paused" as const,
          },
      ),
    ),
    resume: vi.fn(() =>
      setState(
        (current) =>
          current && {
            ...current,
            phase: "recording" as const,
          },
      ),
    ),
    supported: () => true,
  };
  const track = new Track("selected");
  const view = render(() => (
    <MeetingMediaContext.Provider
      value={{ recording } as MeetingMediaContextValue}
    >
      <MeetingTile
        name="Camera"
        participantName="Alice"
        avatar="https://example.test/alice.png"
        sourceLabel="Camera 1"
        sourceId="selected"
        sourceKind="camera"
        local
        pinned={false}
        stream={
          new Stream([
            track as unknown as MediaStreamTrack,
          ]) as unknown as MediaStream
        }
      />
      <MeetingTile
        name="Screen"
        sourceId="other"
        sourceKind="screen"
        local
        pinned={false}
        stream={
          new Stream([
            new Track(
              "other",
            ) as unknown as MediaStreamTrack,
          ]) as unknown as MediaStream
        }
      />
    </MeetingMediaContext.Provider>
  ));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", {
        name: "recording.start",
      }),
    ).toHaveLength(2),
  );
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "recording.start",
    })[0],
  );
  expect(start).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "selected",
      kind: "camera",
      video: track,
      local: true,
      participantName: "Alice",
      avatar: "https://example.test/alice.png",
      sourceLabel: "Camera 1",
    }),
  );
  expect(
    screen.getAllByRole("img", {
      name: "recording.recording",
    }),
  ).toHaveLength(1);
  expect(
    (
      screen.getByRole("button", {
        name: "recording.start",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "recording.pause" }),
  );
  expect(recording.pause).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("img", { name: "recording.paused" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "recording.stop" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "recording.start" }),
  ).toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "recording.resume",
    }),
  );
  expect(recording.resume).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("img", {
      name: "recording.recording",
    }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "recording.pause" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "recording.stop" }),
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("img", {
      name: "recording.recording",
    }),
  ).toBeNull();
  expect(
    (
      screen.getByRole("button", {
        name: "recording.stop",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
});
