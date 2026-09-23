// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { onCleanup, Show, type JSX } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Video from "@/routes/home";
import { MeetingSessionProvider } from "@/routes/home/components/meeting-session-context";
import { MeetingMediaProvider } from "@/libs/hooks/meeting-media-context";

const fixture = vi.hoisted(() => ({
  mobile: false,
  navigate: vi.fn(),
  joinRoom: vi.fn(),
  editRoom: vi.fn(),
  setSearch: vi.fn(),
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
vi.mock("@/components/app/account-menu", () => ({
  AccountMenu: () => null,
}));
vi.mock("@/components/app/room-actions", () => ({
  useRoomActions: () => ({
    join: fixture.joinRoom,
    edit: fixture.editRoom,
    busy: () => false,
  }),
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
  useSearchParams: () => [{}, fixture.setSearch],
  useBeforeLeave: () => {},
  useLocation: () => ({
    pathname: "/",
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
    options: {},
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
vi.mock("@/routes/home/components/audio-player", () => ({
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
      onBack?: () => void;
    }) => {
      onCleanup(() => fixture.unmountChat());
      return (
        <>
          <Show when={props.onBack}>
            <button
              aria-label="conversations.back_to_list"
              onClick={() => props.onBack?.()}
            />
          </Show>
          <div data-testid="chat-view">
            {props.conversationId}
          </div>
        </>
      );
    },
  }),
);
vi.mock("@/routes/home/components/meeting-tile", () => ({
  MeetingTile: (props: { name: string }) => (
    <article>{props.name}</article>
  ),
}));
vi.mock("@/routes/home/components/video-display", () => ({
  VideoDisplay: (props: { name: string }) => (
    <div>{props.name}</div>
  ),
}));

let animationStyle: HTMLStyleElement;
beforeEach(() => {
  // Obsolete linking preferences must not affect the independent controls.
  localStorage.setItem(
    "meeting-toolbar-follows-rail",
    "true",
  );
  // jsdom does not complete CSS exit animations used by TabsContent presence.
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  history.replaceState(null, "", "/");
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
  localStorage.removeItem("meeting-toolbar-follows-rail");
  vi.unstubAllGlobals();
});

describe("meeting page navigation and panels", () => {
  it("keeps chat mounted through PiP and shares independent toolbar and thumbnail states", async () => {
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
            <Video />
          </MeetingSessionProvider>
        </MeetingMediaProvider>
      ));
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
      expect(fixture.pipError).not.toHaveBeenCalled();
      const pipScreen = within(child.document.body);
      const showPipSources = pipScreen.getByRole("button", {
        name: "meeting.show_sources",
      });
      expect(
        showPipSources.getAttribute("aria-expanded"),
      ).toBe("false");
      fireEvent.click(
        pipScreen.getByRole("button", {
          name: "meeting.hide_toolbar",
        }),
      );
      await Promise.resolve();
      expect(
        pipScreen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      expect(
        screen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      expect(
        pipScreen.queryByRole("button", {
          name: "meeting.show_sources",
        }),
      ).toBeNull();
      expect(
        pipScreen.queryByRole("button", {
          name: "meeting.hide_sources",
        }),
      ).toBeNull();
      expect(
        pipScreen
          .getByLabelText("meeting.other_sources")
          .getAttribute("aria-hidden"),
      ).toBe("true");
      fireEvent.click(
        pipScreen.getByRole("button", {
          name: "meeting.show_toolbar",
        }),
      );
      await Promise.resolve();
      expect(
        pipScreen.getByLabelText("meeting.controls"),
      ).not.toBeNull();
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
      const restoredPipSources = pipScreen.getByRole(
        "button",
        { name: "meeting.show_sources" },
      );
      expect(
        restoredPipSources.getAttribute("aria-expanded"),
      ).toBe("false");
      fireEvent.click(restoredPipSources);
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.pip_restore",
        }),
      );
      expect(
        screen.getByLabelText("meeting.stage"),
      ).toBeInTheDocument();
      expect(screen.getByTestId("chat-view")).toBe(chat);
      expect(
        screen.getByRole("button", {
          name: "meeting.hide_sources",
        }),
      ).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.hide_toolbar",
        }),
      );
      await Promise.resolve();
      expect(
        screen.queryByRole("button", {
          name: "meeting.hide_sources",
        }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "meeting.show_sources",
        }),
      ).toBeNull();
      expect(
        screen.getByLabelText("meeting.other_sources"),
      ).toHaveAttribute("aria-hidden", "false");
      expect(
        screen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.show_toolbar",
        }),
      );
      await Promise.resolve();
      expect(
        screen.getByRole("button", {
          name: "meeting.hide_sources",
        }),
      ).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.hide_sources",
        }),
      );
      expect(
        screen.getByRole("button", {
          name: "meeting.show_sources",
        }),
      ).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.grid_layout",
        }),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.hide_toolbar",
        }),
      );
      await Promise.resolve();
      expect(
        screen.queryByLabelText("meeting.controls"),
      ).toBeNull();
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.show_toolbar",
        }),
      );
      await Promise.resolve();
      expect(
        screen.getByLabelText("meeting.controls"),
      ).toBeInTheDocument();
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
  it("cycles one control through compact, wide and full panels without remounting chat or media", () => {
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    fireEvent.click(
      screen.getByRole("button", { name: "Private Alice" }),
    );
    const chat = screen.getByTestId("chat-view");
    const tabs = screen.getAllByRole("tab");
    const stage = screen.getByLabelText("meeting.stage");
    const sources = screen.getAllByRole("article");
    const resize = screen.getByRole("button", {
      name: "meeting.expand_chat",
    });
    const conversations = () =>
      screen.queryByRole("navigation", {
        name: "test conversations",
      });

    // Compact -> wide: the conversation list appears beside the same chat.
    fireEvent.click(resize);
    expect(
      screen.getByRole("button", {
        name: "meeting.maximize_sidebar",
      }),
    ).toBe(resize);
    expect(conversations()).toBeInTheDocument();
    expect(
      stage.closest('[aria-hidden="true"]'),
    ).toBeNull();
    expect(screen.getByTestId("chat-view")).toBe(chat);

    // Wide -> full: media remains mounted while the canvas is hidden.
    fireEvent.click(resize);
    expect(
      screen.getByRole("button", {
        name: "meeting.collapse_chat",
      }),
    ).toBe(resize);
    expect(resize).toHaveAttribute("aria-pressed", "true");
    expect(
      stage.closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("chat-view")).toBe(chat);
    for (const source of sources)
      expect(source).toBeInTheDocument();

    // Full -> compact: the list hides and the meeting canvas returns.
    fireEvent.click(resize);
    expect(
      screen.getByRole("button", {
        name: "meeting.expand_chat",
      }),
    ).toBe(resize);
    expect(resize).toHaveAttribute("aria-pressed", "false");
    expect(conversations()).toBeNull();
    expect(
      stage.closest('[aria-hidden="true"]'),
    ).toBeNull();
    expect(screen.getByTestId("chat-view")).toBe(chat);

    // The cycle remains usable after changing tabs; Escape restores wide.
    expect(fixture.unmountChat).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("tab", { name: "meeting.members" }),
    );
    fireEvent.click(resize);
    fireEvent.click(resize);
    fireEvent.keyDown(screen.getByTestId("meeting-page"), {
      key: "Escape",
    });
    expect(
      screen.getByRole("button", {
        name: "meeting.maximize_sidebar",
      }),
    ).toBe(resize);
    expect(
      stage.closest('[aria-hidden="true"]'),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("tab", { name: "meeting.chat" }),
    );
    expect(conversations()).toBeInTheDocument();
    expect(
      screen.getByTestId("chat-view").textContent,
    ).toBe("private-alice");
    expect(screen.getAllByRole("tab")).toEqual(tabs);
    expect(fixture.clearLocalStream).not.toHaveBeenCalled();
    expect(fixture.leaveRoom).not.toHaveBeenCalled();
  });

  it("opens private and historical room conversations without leaving the meeting route or joining another room", () => {
    render(() => (
      <MeetingMediaProvider>
        <MeetingSessionProvider>
          <Video />
        </MeetingSessionProvider>
      </MeetingMediaProvider>
    ));
    expect(screen.queryByTestId("chat-view")).toBeNull();
    expect(
      document.querySelector("#meeting-conversations"),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "meeting.conversations",
      }),
    ).toBeNull();
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
      screen.getByRole("button", {
        name: "conversations.back_to_list",
      }),
    );
    expect(fixture.setSearch).toHaveBeenLastCalledWith(
      { conversation: undefined, panel: "conversations" },
      { replace: true },
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
      screen.getByRole("button", { name: "Private Alice" }),
    );
    const members = screen.getByRole("tab", {
      name: "meeting.members",
    });
    fireEvent.click(members);
    expect(screen.queryByTestId("chat-view")).toBeNull();
    expect(fixture.unmountChat).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(members, { key: "ArrowRight" });
    const info = screen.getByRole("tab", {
      name: "meeting.info",
    });
    expect(info.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(info);
    fireEvent.keyDown(info, { key: "ArrowRight" });
    const chatTab = screen.getByRole("tab", {
      name: "meeting.chat",
    });
    expect(chatTab).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(document.activeElement).toBe(chatTab);
    fireEvent.keyDown(chatTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(info);
    fireEvent.keyDown(info, { key: "Home" });
    expect(document.activeElement).toBe(chatTab);
    fireEvent.keyDown(chatTab, { key: "End" });
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

  it("replaces the mobile canvas with chat and returns without disposing media", () => {
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
    const stage = screen.getByLabelText("meeting.stage");
    const sources = screen.getAllByRole("article");
    const toggle = screen.getByRole("button", {
      name: "meeting.show_panel",
    });
    expect(toggle).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(toggle);
    expect(
      stage.closest('[aria-hidden="true"]'),
    ).not.toBeNull();
    for (const source of sources)
      expect(source).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /meeting\.(expand_chat|maximize_sidebar|collapse_chat)/,
      }),
    ).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute(
      "aria-label",
      "meeting.hide_panel",
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
    fireEvent.click(toggle);
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(
      stage.closest('[aria-hidden="true"]'),
    ).toBeNull();
    expect(screen.getByLabelText("meeting.stage")).toBe(
      stage,
    );
    expect(fixture.clearLocalStream).not.toHaveBeenCalled();
    expect(fixture.leaveRoom).not.toHaveBeenCalled();
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(toggle).toHaveAttribute(
      "aria-label",
      "meeting.show_panel",
    );
  });
});
