// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { onCleanup, type JSX } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Video from "@/routes/video";
import { MeetingSettings } from "@/routes/setting/meeting-settings";
import { MeetingSessionProvider } from "@/routes/video/components/meeting-session-context";
import { MeetingMediaProvider } from "@/libs/hooks/meeting-media-context";

const fixture = vi.hoisted(() => ({
  mobile: false,
  navigate: vi.fn(),
  leaveRoom: vi.fn(),
  clearLocalStream: vi.fn(),
  replaceLocalStream: vi.fn(),
  unmountChat: vi.fn(),
  openRoomInfo: vi.fn(),
  pipError: vi.fn(),
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: { error: string }) =>
    values?.error ?? key,
}));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.pipError, dismiss: vi.fn() },
}));
vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));
vi.mock("@/components/dialogs/room-info-dialog", () => ({
  createRoomInfoDialog: () => ({
    open: fixture.openRoomInfo,
  }),
}));
vi.mock("@solidjs/router", () => ({
  useNavigate: () => fixture.navigate,
  useBeforeLeave: () => {},
  useLocation: () => ({
    pathname: "/video",
    get hash() {
      return window.location.hash;
    },
  }),
  A: (
    props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>,
  ) => <a {...props} />,
}));
vi.mock("@/libs/hooks/create-mobile", () => ({
  createIsMobile: () => () => fixture.mobile,
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    profile: { clientId: "me", name: "Me" },
    roomStatus: { roomId: "Current room" },
    session: {
      clientViewData: {
        bob: {
          clientId: "bob",
          name: "Bob",
          onlineStatus: "online",
        },
        chris: {
          clientId: "chris",
          name: "Chris",
          onlineStatus: "online",
        },
      },
    },
  },
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    localStream: () => null,
    replaceLocalStream: fixture.replaceLocalStream,
    clearLocalStream: fixture.clearLocalStream,
    activeRoomConversationId: () => "current-room-id",
    leaveRoom: fixture.leaveRoom,
  }),
}));
vi.mock("@/routes/video/components/audio-player", () => ({
  useAudioPlayer: () => ({
    playState: () => false,
    hasAudio: () => false,
    setPlay: vi.fn(),
    outputDeviceId: () => "",
    outputSupported: () => false,
    outputBusy: () => false,
    setOutputDevice: vi.fn(async () => {}),
  }),
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: (props: { name: string }) => (
    <span>{props.name.slice(0, 1)}</span>
  ),
}));
vi.mock(
  "@/components/conversations/conversation-sidebar",
  () => ({
    ConversationSidebar: (props: {
      onSelect(id: string): void;
    }) => (
      <nav aria-label="test conversations">
        <button
          onClick={() => props.onSelect("private-alice")}
        >
          Private Alice
        </button>
        <button
          onClick={() => props.onSelect("historical-room")}
        >
          Historical room
        </button>
      </nav>
    ),
  }),
);
vi.mock(
  "@/components/conversations/conversation-view",
  () => ({
    ConversationView: (props: {
      conversationId: string;
    }) => {
      onCleanup(() => fixture.unmountChat());
      return (
        <div data-testid="chat-view">
          {props.conversationId}
        </div>
      );
    },
  }),
);
vi.mock("@/routes/video/components/meeting-tile", () => ({
  MeetingTile: (props: { name: string }) => (
    <article>{props.name}</article>
  ),
}));
vi.mock("@/routes/video/components/video-display", () => ({
  VideoDisplay: (props: { name: string }) => (
    <div>{props.name}</div>
  ),
}));

let animationStyle: HTMLStyleElement;
beforeEach(() => {
  localStorage.removeItem("meeting-toolbar-follows-rail");
  // jsdom does not complete CSS exit animations used by TabsContent presence.
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  history.replaceState(null, "", "/video");
  fixture.mobile = false;
  vi.clearAllMocks();
  vi.stubGlobal("focus", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1440,
  });
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.unstubAllGlobals();
});

describe("meeting page navigation and panels", () => {
  it("replaces only the stage during PiP, keeps chat mounted, and restores the layout from the placeholder", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const child = frame.contentWindow!;
    Object.defineProperty(child, "close", {
      value: vi.fn(),
    });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => child),
    });
    try {
      render(() => (
        <MeetingMediaProvider>
          <MeetingSessionProvider>
            <MeetingSettings />
            <Video />
          </MeetingSessionProvider>
        </MeetingMediaProvider>
      ));
      fireEvent.click(
        screen.getByRole("tab", {
          name: "meeting.conversations",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "Private Alice",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.focus_layout",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.hide_sources",
        }),
      );
      const chat = screen.getByTestId("chat-view");
      expect(
        screen.getByRole("switch", {
          name: "setting.meeting.toolbar_follows_rail.title",
        }),
      ).not.toBeChecked();
      // The default only collapses thumbnails, leaving media controls available.
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
      const unmounts =
        fixture.unmountChat.mock.calls.length;
      fireEvent.click(
        screen.getByRole("button", {
          name: "common.action.picture_in_picture",
        }),
      );
      await waitFor(() =>
        expect(
          screen.queryByLabelText("meeting.stage"),
        ).toBeNull(),
      );
      expect(screen.getByTestId("chat-view")).toBe(chat);
      expect(fixture.unmountChat).toHaveBeenCalledTimes(
        unmounts,
      );
      expect(
        screen.getByRole("heading", {
          name: "meeting.pip_elsewhere",
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
      expect(fixture.pipError).not.toHaveBeenCalled();
      expect(
        child.document.querySelector("main"),
      ).not.toBeNull();
      const pipScreen = within(child.document.body);
      const showPipSources = pipScreen.getByRole("button", {
        name: "meeting.show_sources",
      });
      expect(
        showPipSources.getAttribute("aria-expanded"),
      ).toBe("false");
      fireEvent.click(
        screen.getByRole("switch", {
          name: "setting.meeting.toolbar_follows_rail.title",
        }),
      );
      expect(
        localStorage.getItem(
          "meeting-toolbar-follows-rail",
        ),
      ).toBe("true");
      expect(
        pipScreen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      // The opener has a placeholder instead of a rail and keeps its controls.
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
      fireEvent.click(showPipSources);
      expect(
        pipScreen.queryByLabelText("meeting.controls"),
      ).not.toBeNull();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.pip_restore",
        }),
      );
      expect(
        screen.getByLabelText("meeting.stage"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("chat-view"),
      ).toHaveTextContent("private-alice");
      expect(screen.getByTestId("chat-view")).toBe(chat);
      expect(
        screen.getByRole("button", {
          name: "meeting.hide_sources",
        }),
      ).toHaveAttribute("aria-expanded", "true");
      expect(
        screen.getByRole("switch", {
          name: "setting.meeting.toolbar_follows_rail.title",
        }),
      ).toBeChecked();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.hide_sources",
        }),
      );
      expect(
        screen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("switch", {
          name: "setting.meeting.toolbar_follows_rail.title",
        }),
      );
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.grid_layout",
        }),
      );
      fireEvent.click(
        screen.getByRole("switch", {
          name: "setting.meeting.toolbar_follows_rail.title",
        }),
      );
      expect(
        screen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.show_toolbar",
        }),
      );
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.hide_toolbar",
        }),
      );
      expect(
        screen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      expect(
        fixture.clearLocalStream,
      ).not.toHaveBeenCalled();
      expect(fixture.leaveRoom).not.toHaveBeenCalled();
    } finally {
      cleanup();
      frame.remove();
    }
  });
  it("opens device settings from the right header when permission is missing without starting capture", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia,
      },
    });
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "meeting.get_permission",
        }),
      ).toBeEnabled(),
    );
    const entry = screen.getByRole("button", {
      name: "meeting.get_permission",
    });
    expect(
      entry.closest(".meeting-header-actions"),
    ).not.toBeNull();
    fireEvent.click(entry);
    expect(fixture.openRoomInfo).toHaveBeenCalledWith(
      "current-room-id",
      "devices",
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(
      fixture.replaceLocalStream,
    ).not.toHaveBeenCalled();
  });
  it("opens private and historical room conversations without leaving the meeting route or joining another room", () => {
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    expect(
      screen.getByTestId("chat-view").textContent,
    ).toBe("current-room-id");
    expect(
      document.querySelector("#meeting-conversations"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: /meeting\.(show|hide)_conversations/,
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "meeting.conversations",
      }),
    );
    expect(screen.getByRole("tabpanel")).toContainElement(
      screen.getByRole("navigation", {
        name: "test conversations",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Private Alice" }),
    );
    expect(
      screen.getByTestId("chat-view").textContent,
    ).toBe("private-alice");
    expect(
      screen.getByRole("tab", { name: "meeting.chat" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("navigation", {
        name: "test conversations",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "meeting.conversations",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Historical room",
      }),
    );
    expect(
      screen.getByTestId("chat-view").textContent,
    ).toBe("historical-room");
    expect(screen.getByTestId("meeting-page")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Current room" }),
    ).toBeTruthy();
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.leaveRoom).not.toHaveBeenCalled();
  });

  it("unmounts hidden chat, supports keyboard tabs, and reopens the selected conversation", () => {
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    fireEvent.click(
      screen.getByRole("tab", {
        name: "meeting.conversations",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Private Alice" }),
    );
    const members = screen.getByRole("tab", {
      name: "meeting.members",
    });
    fireEvent.click(members);
    expect(screen.queryByTestId("chat-view")).toBeNull();
    expect(fixture.unmountChat).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(members, { key: "ArrowRight" });
    const info = screen.getByRole("tab", {
      name: "meeting.info",
    });
    expect(info.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(info);
    fireEvent.keyDown(info, { key: "ArrowRight" });
    const conversations = screen.getByRole("tab", {
      name: "meeting.conversations",
    });
    expect(conversations).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.activeElement).toBe(conversations);
    fireEvent.keyDown(conversations, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(info);
    fireEvent.keyDown(info, { key: "Home" });
    expect(document.activeElement).toBe(conversations);
    fireEvent.keyDown(conversations, { key: "End" });
    expect(document.activeElement).toBe(info);
    fireEvent.click(
      screen.getByRole("tab", { name: "meeting.chat" }),
    );
    expect(
      screen.getByTestId("chat-view").textContent,
    ).toBe("private-alice");
    fireEvent.keyDown(screen.getByTestId("meeting-page"), {
      key: "Escape",
    });
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("retains views across layout switches and thumbnail visibility changes without stopping media", () => {
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    const views = [...screen.getAllByRole("article")];
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.focus_layout",
      }),
    );
    const rail = screen.getByLabelText(
      "meeting.other_sources",
    );
    const tile = rail.querySelector("article");
    expect(tile).toBeTruthy();
    for (const view of views)
      expect(view).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.hide_sources",
      }),
    );
    expect(rail).toHaveAttribute("aria-hidden", "true");
    expect(rail.querySelector("article")).toBe(tile);
    const expand = screen.getByRole("button", {
      name: "meeting.show_sources",
    });
    expect(expand).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(expand);
    expect(rail).toHaveAttribute("aria-hidden", "false");
    expect(rail.querySelector("article")).toBe(tile);
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.grid_layout",
      }),
    );
    for (const view of views)
      expect(view).toBeInTheDocument();
    expect(fixture.clearLocalStream).not.toHaveBeenCalled();
    expect(
      fixture.replaceLocalStream,
    ).not.toHaveBeenCalled();
  });

  it("stops local media before leaving the room and returning home", () => {
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.leave_room",
      }),
    );
    expect(fixture.clearLocalStream).toHaveBeenCalledOnce();
    expect(fixture.leaveRoom).toHaveBeenCalledOnce();
    expect(fixture.navigate).toHaveBeenCalledWith("/");
    expect(
      fixture.clearLocalStream.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fixture.leaveRoom.mock.invocationCallOrder[0],
    );
  });

  it("does not disconnect or stop published media when navigating away", () => {
    const view = render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    view.unmount();
    expect(fixture.leaveRoom).not.toHaveBeenCalled();
    expect(fixture.clearLocalStream).not.toHaveBeenCalled();
  });

  it("opens the hash-selected conversation on a mobile meeting mount", () => {
    fixture.mobile = true;
    window.innerWidth = 390;
    history.replaceState(
      null,
      "",
      "/video#/media/historical-room/photo",
    );
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    expect(
      screen.getByTestId("chat-view"),
    ).toHaveTextContent("historical-room");
    expect(
      screen.getByRole("tab", { name: "meeting.chat" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.leaveRoom).not.toHaveBeenCalled();
  });

  it("starts with a closed mobile panel and switches from conversations to selected chat in that panel", () => {
    fixture.mobile = true;
    window.innerWidth = 390;
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    expect(
      screen.queryByRole("navigation", {
        name: "test conversations",
      }),
    ).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.show_panel",
      }),
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: "meeting.conversations",
      }),
    );
    const panel = document.querySelector(
      "#meeting-side-panel",
    );
    expect(panel).toContainElement(
      screen.getByRole("navigation", {
        name: "test conversations",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Private Alice" }),
    );
    expect(
      screen.queryByRole("navigation", {
        name: "test conversations",
      }),
    ).toBeNull();
    expect(
      screen.getByTestId("chat-view").textContent,
    ).toBe("private-alice");
    expect(
      document.querySelector("#meeting-side-panel"),
    ).toBe(panel);
    expect(
      screen.getByRole("tab", { name: "meeting.chat" }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.click(
      screen.getByRole("button", {
        name: "meeting.close_panels",
      }),
    );
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(fixture.navigate).not.toHaveBeenCalled();
  });
});
