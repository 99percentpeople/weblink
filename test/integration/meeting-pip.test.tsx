// @vitest-environment jsdom
import {
  render,
  cleanup,
  waitFor,
  fireEvent,
  within,
} from "@solidjs/testing-library";
import {
  MemoryRouter,
  Route,
  createMemoryHistory,
  useNavigate,
} from "@solidjs/router";
import { type ParentProps } from "solid-js";
import { reconcile } from "solid-js/store";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import {
  MeetingSessionProvider,
  useMeetingSession,
} from "@/routes/video/components/meeting-session-context";

const fixture = vi.hoisted(() => ({
  clear: vi.fn(),
  leave: vi.fn(),
  microphone: vi.fn(),
  camera: vi.fn(),
  sharing: vi.fn(),
  sharingBusy: vi.fn(() => false),
  sound: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));
vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    localStream: () => appState.session.localStream,
    activeRoomConversationId: () =>
      appState.roomStatus.roomId,
    leaveRoom: fixture.leave,
  }),
}));
vi.mock("@/libs/hooks/meeting-media-context", () => ({
  useMeetingMedia: () => ({
    media: {
      microphoneOn: () => false,
      cameraOn: () => false,
      sharing: () => false,
      microphoneBusy: () => false,
      cameraBusy: () => false,
      sharingBusy: fixture.sharingBusy,
      toggleMicrophone: fixture.microphone,
      toggleCamera: fixture.camera,
      toggleSharing: fixture.sharing,
      clear: fixture.clear,
    },
  }),
}));
vi.mock("@/routes/video/components/audio-player", () => ({
  useAudioPlayer: () => ({
    hasAudio: () => true,
    playState: () => true,
    setPlay: fixture.sound,
  }),
}));
vi.mock("@/routes/video/components/video-display", () => ({
  VideoDisplay: (props: ParentProps<{ name: string }>) => (
    <div data-testid="pip-source">
      <span>{props.name}</span>
      {props.children}
    </div>
  ),
}));

let session!: ReturnType<typeof useMeetingSession>;
let navigate!: ReturnType<typeof useNavigate>;
let mediaAction:
  | ((details?: {
      enterPictureInPictureReason?: string;
    }) => void)
  | null;
let windowFocused = true;
let userActivation = false;
class FakeTrack extends EventTarget {
  id = "shared-video";
  kind = "video";
  enabled = true;
  muted = false;
  readyState: MediaStreamTrackState = "live";
  constructor(private screen = false) {
    super();
  }
  getSettings() {
    return this.screen ? { displaySurface: "monitor" } : {};
  }
}
class FakeStream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
}
const sharedStream = (track = new FakeTrack()) =>
  new FakeStream([
    track as unknown as MediaStreamTrack,
  ]) as unknown as MediaStream;
const windows: {
  frame: HTMLIFrameElement;
  window: Window;
  close: ReturnType<typeof vi.fn>;
}[] = [];
function newPipWindow(): Window {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const child = frame.contentWindow!;
  let closed = false;
  const close = vi.fn(() => {
    if (closed) return;
    closed = true;
    child.dispatchEvent(new Event("pagehide"));
  });
  Object.defineProperties(child, {
    closed: { get: () => closed },
    close: { value: close },
  });
  windows.push({ frame, window: child, close });
  return child;
}
function setup(
  requestWindow = vi.fn(async () => newPipWindow()),
) {
  vi.stubGlobal("documentPictureInPicture", {
    requestWindow,
  });
  const history = createMemoryHistory();
  history.set({ value: "/video", scroll: false });
  function Capture() {
    session = useMeetingSession();
    navigate = useNavigate();
    return null;
  }
  function Shell(props: ParentProps) {
    return (
      <MeetingSessionProvider>
        <Capture />
        {props.children}
      </MeetingSessionProvider>
    );
  }
  const result = render(() => (
    <MemoryRouter history={history} root={Shell}>
      <Route
        path="/video"
        component={() => <div>Meeting page</div>}
      />
      <Route
        path="/"
        component={() => <div>Chat page</div>}
      />
      <Route
        path="/setting"
        component={() => <div>Settings page</div>}
      />
    </MemoryRouter>
  ));
  return { ...result, requestWindow, history };
}
const current = () => windows.at(-1)!;
const source = () =>
  current().window.document.querySelector(
    '.meeting-featured-frame [data-testid="pip-source"]',
  )?.textContent;
const click = (name: string) => {
  const button =
    current().window.document.querySelector<HTMLButtonElement>(
      `button[aria-label="${name}"]`,
    )!;
  expect(button).not.toBeNull();
  button.click();
};
const setVisibility = (value: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};
beforeEach(() => {
  localStorage.removeItem("meeting-toolbar-follows-rail");
  localStorage.removeItem(
    "meeting-auto-picture-in-picture",
  );
  vi.clearAllMocks();
  fixture.sharingBusy.mockReturnValue(false);
  vi.stubGlobal("MediaStream", FakeStream);
  windowFocused = true;
  userActivation = false;
  vi.spyOn(document, "hasFocus").mockImplementation(
    () => windowFocused,
  );
  Object.defineProperty(navigator, "userActivation", {
    configurable: true,
    value: {
      get isActive() {
        return userActivation;
      },
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mediaAction = null;
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      setActionHandler: vi.fn((action, handler) => {
        if (action === "enterpictureinpicture")
          mediaAction = handler;
      }),
    },
  });
  vi.stubGlobal("scrollTo", vi.fn());
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  vi.spyOn(window, "focus").mockImplementation(() => {});
  setAppState(reconcile(createInitialAppState()));
  setAppState("roomStatus", "roomId", "room");
  setAppState("profile", "clientId", "me");
  setAppState("profile", "name", "Me");
  setAppState("session", "clientViewData", {
    bob: {
      clientId: "bob",
      name: "Bob",
      createdAt: Date.now(),
      avatar: null,
      onlineStatus: "online",
      messageChannel: true,
      stream: sharedStream(),
    },
  });
});
afterEach(() => {
  cleanup();
  windows.splice(0).forEach(({ frame }) => frame.remove());
  document.documentElement.removeAttribute("data-kb-theme");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("meeting PiP across routes and documents", () => {
  it("only opens automatically for an active camera or screen, while manual entry still works without video", async () => {
    setAppState(
      "session",
      "clientViewData",
      "bob",
      "stream",
      undefined,
    );
    const f = setup();
    session.controls.setAutomatic(true);
    session.controls.toggle();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    session.controls.toggle();
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    f.requestWindow.mockClear();
    windowFocused = false;
    userActivation = true;
    setVisibility("hidden");
    const audio = new FakeTrack();
    audio.kind = "audio";
    const disabled = new FakeTrack();
    disabled.enabled = false;
    const muted = new FakeTrack();
    muted.muted = true;
    const ended = new FakeTrack();
    ended.readyState = "ended";
    const inactive: {
      stream?: MediaStream;
      streamState?: "placeholder" | "media";
    }[] = [
      {},
      { stream: sharedStream(audio) },
      {
        stream: sharedStream(),
        streamState: "placeholder",
      },
      { stream: sharedStream(disabled) },
      { stream: sharedStream(muted) },
      { stream: sharedStream(ended) },
    ];
    for (const value of inactive) {
      setAppState("session", "clientViewData", "bob", {
        stream: value.stream,
        streamState: value.streamState ?? "media",
      });
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
      mediaAction!();
    }
    navigate("/setting");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Settings page",
      ),
    );
    expect(f.requestWindow).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
    // A remote camera can qualify even when the local participant is pinned.
    session.setPinnedId(session.sources()[0].id);
    setAppState(
      "session",
      "clientViewData",
      "bob",
      "stream",
      sharedStream(),
    );
    mediaAction!();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    session.controls.toggle();
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    setAppState(
      "session",
      "clientViewData",
      "bob",
      "stream",
      undefined,
    );
    setAppState(
      "session",
      "localStream",
      sharedStream(new FakeTrack(true)),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    expect(f.requestWindow).toHaveBeenCalledTimes(2);
    expect(fixture.clear).not.toHaveBeenCalled();
  });
  it("discards an automatic window if video ends while the request is pending", async () => {
    const video = new FakeTrack();
    setAppState(
      "session",
      "clientViewData",
      "bob",
      "stream",
      sharedStream(video),
    );
    let resolve!: (window: Window) => void;
    setup(
      vi.fn(
        () =>
          new Promise<Window>((done) => {
            resolve = done;
          }),
      ),
    );
    session.controls.setAutomatic(true);
    setVisibility("hidden");
    mediaAction!();
    expect(session.pip.busy()).toBe(true);
    video.readyState = "ended";
    resolve(newPipWindow());
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    expect(session.pip.active()).toBe(false);
    expect(current().close).toHaveBeenCalledOnce();
    expect(fixture.error).not.toHaveBeenCalled();
  });
  it("keeps the pinned participant and controls live after leaving the route, without stopping capture on close", async () => {
    setup();
    session.setPinnedId(session.sources()[1].id);
    session.controls.toggle();
    await waitFor(() => expect(source()).toBe("Bob"));
    const views = [
      ...current().window.document.querySelectorAll(
        "[data-source-id]",
      ),
    ];
    expect(views).toHaveLength(2);
    expect(
      current().window.document.querySelector(
        'button[aria-label="meeting.grid_layout"], button[aria-label="meeting.focus_layout"]',
      ),
    ).toBeNull();
    click("meeting.feature_source");
    expect(source()).toBe("Me (meeting.you)");
    expect(session.selected()?.participantId).toBe("me");
    click("meeting.feature_source");
    expect(source()).toBe("Bob");
    for (const view of views)
      expect(
        current().window.document.body.contains(view),
      ).toBe(true);
    navigate("/setting");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Settings page",
      ),
    );
    expect(session.pip.active()).toBe(true);
    // Background tabs can stop receiving animation frames; the PiP document
    // must still commit new sources on its own rendering loop.
    const openerFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 0);
    setAppState("session", "clientViewData", "carol", {
      clientId: "carol",
      name: "Carol",
      createdAt: Date.now(),
      avatar: null,
      onlineStatus: "online",
      messageChannel: true,
    });
    await waitFor(() =>
      expect(
        current().window.document.querySelectorAll(
          "[data-source-id]",
        ),
      ).toHaveLength(3),
    );
    openerFrame.mockRestore();
    click("meeting.enable_microphone");
    click("meeting.enable_camera");
    click("meeting.share_screen");
    click("video.global_mute");
    expect(fixture.microphone).toHaveBeenCalledOnce();
    expect(fixture.camera).toHaveBeenCalledOnce();
    expect(fixture.sharing).toHaveBeenCalledOnce();
    expect(fixture.sound).toHaveBeenCalledWith(false);
    setAppState(
      "session",
      "clientViewData",
      "bob",
      "name",
      "Bobby",
    );
    expect(source()).toBe("Bobby");
    document.documentElement.setAttribute(
      "data-kb-theme",
      "dark",
    );
    await waitFor(() =>
      expect(
        current().window.document.documentElement.getAttribute(
          "data-kb-theme",
        ),
      ).toBe("dark"),
    );
    session.setToolbarFollowsRail(true);
    setAppState("session", "clientViewData", reconcile({}));
    const pipScreen = within(
      current().window.document.body,
    );
    const hideToolbar = await pipScreen.findByRole(
      "button",
      {
        name: "meeting.hide_toolbar",
      },
    );
    fireEvent.click(hideToolbar);
    expect(session.railCollapsed()).toBe(true);
    expect(
      pipScreen.queryByLabelText("meeting.controls"),
    ).toBeNull();
    fireEvent.click(
      pipScreen.getByRole("button", {
        name: "meeting.show_toolbar",
      }),
    );
    expect(session.railCollapsed()).toBe(false);
    expect(
      pipScreen.queryByLabelText("meeting.controls"),
    ).not.toBeNull();
    current().close();
    expect(session.pip.active()).toBe(false);
    expect(
      current().window.document.body.children,
    ).toHaveLength(0);
    expect(fixture.clear).not.toHaveBeenCalled();
    expect(fixture.leave).not.toHaveBeenCalled();
  });
  it("opens during navigation when enabled, returns to the meeting, and never reopens while leaving the room", async () => {
    const f = setup();
    expect(session.controls.automatic()).toBe(false);
    session.controls.setAutomatic(true);
    navigate("/video#details");
    expect(f.requestWindow).not.toHaveBeenCalled();
    navigate("/setting");
    expect(f.requestWindow).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Settings page",
      ),
    );
    click("meeting.pip_return");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Meeting page",
      ),
    );
    expect(session.pip.active()).toBe(false);
    session.controls.toggle();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    click("meeting.leave_room");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Chat page",
      ),
    );
    expect(session.pip.active()).toBe(false);
    expect(fixture.clear).toHaveBeenCalledOnce();
    expect(fixture.leave).toHaveBeenCalledOnce();
    expect(f.requestWindow).toHaveBeenCalledTimes(2);
    expect(mediaAction).toBeNull();
  });
  it("registers browser auto PiP only when enabled and respects native dismissal", async () => {
    const f = setup();
    expect(mediaAction).toBeNull();
    session.controls.setAutomatic(true);
    expect(mediaAction).toBeTypeOf("function");
    setVisibility("hidden");
    mediaAction!();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    current().close();
    mediaAction!();
    expect(f.requestWindow).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    setVisibility("visible");
    setVisibility("hidden");
    mediaAction!();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    session.controls.setAutomatic(false);
    expect(mediaAction).toBeNull();
    setAppState("roomStatus", "roomId", null);
    expect(session.pip.active()).toBe(false);
  });
  it("keeps automatic PiP through visible-but-unfocused events and rearms on focus return without a visibility change", async () => {
    const f = setup();
    session.controls.setAutomatic(true);
    windowFocused = false;
    setVisibility("hidden");
    mediaAction!();
    // Opening the child can make the page visible without returning focus to it.
    setVisibility("visible");
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    expect(session.pip.active()).toBe(true);
    windowFocused = true;
    window.dispatchEvent(new Event("focus"));
    expect(session.pip.active()).toBe(false);
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    // The browser can report occlusion while visibilityState remains visible.
    for (let departure = 2; departure <= 3; departure++) {
      windowFocused = false;
      window.dispatchEvent(new Event("blur"));
      expect(f.requestWindow).toHaveBeenCalledTimes(
        departure - 1,
      );
      mediaAction!({
        enterPictureInPictureReason: "contentoccluded",
      });
      await waitFor(() =>
        expect(session.pip.active()).toBe(true),
      );
      expect(f.requestWindow).toHaveBeenCalledTimes(
        departure,
      );
      windowFocused = true;
      window.dispatchEvent(new Event("focus"));
      expect(session.pip.active()).toBe(false);
      await waitFor(() =>
        expect(session.pip.busy()).toBe(false),
      );
    }
    expect(fixture.error).not.toHaveBeenCalled();
  });

  it("clears a native-close dismissal on focus return even when visibility does not change", async () => {
    const f = setup();
    session.controls.setAutomatic(true);
    windowFocused = false;
    setVisibility("hidden");
    mediaAction!();
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    current().close();
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    windowFocused = true;
    window.dispatchEvent(new Event("focus"));
    windowFocused = false;
    setVisibility("hidden");
    mediaAction!();
    await waitFor(() =>
      expect(f.requestWindow).toHaveBeenCalledTimes(2),
    );
    expect(session.pip.active()).toBe(true);
  });
  it("ignores focus loss and browser callbacks while visible, and suppresses background entry during a screen picker", async () => {
    const f = setup();
    session.controls.setAutomatic(true);
    windowFocused = false;
    userActivation = true;
    // Opening browser chrome or a system dialog loses focus but stays visible.
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
    mediaAction!();
    expect(f.requestWindow).not.toHaveBeenCalled();
    // A picker that fully covers the page must not count as leaving it either.
    fixture.sharingBusy.mockReturnValue(true);
    setVisibility("hidden");
    mediaAction!();
    mediaAction!({
      enterPictureInPictureReason: "contentoccluded",
    });
    expect(f.requestWindow).not.toHaveBeenCalled();
    // Accepting/canceling the picker does not itself request a window.
    setVisibility("visible");
    fixture.sharingBusy.mockReturnValue(false);
    mediaAction!();
    expect(f.requestWindow).not.toHaveBeenCalled();
    setVisibility("hidden");
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    expect(f.requestWindow).toHaveBeenCalledOnce();
    expect(fixture.error).not.toHaveBeenCalled();
  });
  it("opens only when hidden, enabled and activated, and respects return and dismissal", async () => {
    const f = setup();
    windowFocused = false;
    userActivation = true;
    setVisibility("hidden");
    expect(f.requestWindow).not.toHaveBeenCalled();
    session.controls.setAutomatic(true);
    userActivation = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(f.requestWindow).not.toHaveBeenCalled();
    expect(fixture.error).not.toHaveBeenCalled();
    userActivation = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    expect(f.requestWindow).toHaveBeenCalledOnce();
    // Repeated hidden events must not create another window.
    document.dispatchEvent(new Event("visibilitychange"));
    expect(session.pip.active()).toBe(true);
    current().close();
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    mediaAction!();
    expect(f.requestWindow).toHaveBeenCalledOnce();
    windowFocused = true;
    setVisibility("visible");
    windowFocused = false;
    setVisibility("hidden");
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    // Visibility alone can come from opening PiP; wait for actual focus return.
    setVisibility("visible");
    expect(session.pip.active()).toBe(true);
    windowFocused = true;
    window.dispatchEvent(new Event("focus"));
    expect(session.pip.active()).toBe(false);
    expect(f.requestWindow).toHaveBeenCalledTimes(2);
    session.controls.setAutomatic(false);
    navigate("/setting");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Settings page",
      ),
    );
    session.controls.setAutomatic(true);
    windowFocused = false;
    setVisibility("hidden");
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    windowFocused = true;
    setVisibility("visible");
    expect(session.pip.active()).toBe(true);
    navigate("/video");
    await waitFor(() =>
      expect(session.pip.active()).toBe(false),
    );
    expect(f.requestWindow).toHaveBeenCalledTimes(3);
    f.unmount();
    setVisibility("hidden");
    expect(f.requestWindow).toHaveBeenCalledTimes(3);
    expect(fixture.clear).not.toHaveBeenCalled();
  });
  it("cancels a pending background window when visible again and preserves manually opened windows", async () => {
    let resolve!: (window: Window) => void;
    setup(
      vi.fn(
        () =>
          new Promise<Window>((done) => {
            resolve = done;
          }),
      ),
    );
    session.controls.setAutomatic(true);
    windowFocused = false;
    userActivation = true;
    setVisibility("hidden");
    expect(session.pip.busy()).toBe(true);
    windowFocused = true;
    setVisibility("visible");
    resolve(newPipWindow());
    await waitFor(() =>
      expect(session.pip.busy()).toBe(false),
    );
    expect(current().close).toHaveBeenCalledOnce();
    expect(session.pip.active()).toBe(false);
    session.controls.toggle();
    resolve(newPipWindow());
    await waitFor(() =>
      expect(session.pip.active()).toBe(true),
    );
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(session.pip.active()).toBe(true);
  });
  it("does not block navigation on denial or publish a window after a quick return", async () => {
    const denied = vi.fn(async () => {
      throw new DOMException(
        "Activation required",
        "NotAllowedError",
      );
    });
    const f = setup(denied);
    session.controls.setAutomatic(true);
    navigate("/setting");
    await waitFor(() =>
      expect(fixture.error).toHaveBeenCalledOnce(),
    );
    expect(document.body.textContent).toContain(
      "Settings page",
    );
    expect(session.pip.active()).toBe(false);
    navigate("/video");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Meeting page",
      ),
    );
    let resolve!: (window: Window) => void;
    f.requestWindow.mockImplementationOnce(
      () =>
        new Promise<Window>((done) => {
          resolve = done;
        }),
    );
    navigate("/setting");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Settings page",
      ),
    );
    navigate("/video");
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Meeting page",
      ),
    );
    const child = newPipWindow();
    resolve(child);
    await waitFor(() =>
      expect(current().close).toHaveBeenCalledOnce(),
    );
    expect(session.pip.active()).toBe(false);
  });
});
