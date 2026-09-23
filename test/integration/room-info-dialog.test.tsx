// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { createRoomInfoDialog } from "@/components/dialogs/room-info-dialog";
import { ModalProvider } from "@/components/dialogs/base";
import {
  MeetingMediaProvider,
  useMeetingMedia,
  type MeetingMediaContextValue,
} from "@/libs/hooks/meeting-media-context";
import { useAppState } from "@/libs/state/app-state-context";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { reconcile } from "solid-js/store";
import { deferred } from "../support/rtc-transport";
import { resolveRoomConfig } from "@/libs/state/app-options";
import type { Conversation } from "@/libs/domain/conversation";

const deletion = vi.hoisted(() => ({
  remove: vi.fn<(id: string) => void>(),
  clear: vi.fn<(id: string) => void>(),
}));
vi.mock(
  "@/libs/application/messaging/message-store",
  () => ({
    messageStores: {
      deleteConversation: deletion.remove,
      clearConversation: deletion.clear,
    },
  }),
);

vi.mock("@/components/icons", () => ({
  IconSync: () => null,
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/routes/home/components/audio-player", () => ({
  useAudioPlayer: () => ({
    outputDeviceId: () => "",
    outputSupported: () => true,
    outputBusy: () => false,
    setOutputDevice: vi.fn(async () => {}),
  }),
}));

class Track extends EventTarget {
  constructor(
    readonly kind = "audio",
    readonly deviceId = "mic-1",
  ) {
    super();
  }
  enabled = true;
  readyState = "live";
  contentHint = "";
  id = "captured";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings() {
    return { deviceId: this.deviceId };
  }
}
class Stream extends EventTarget {
  constructor(readonly tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
}
const getUserMedia =
  vi.fn<
    (
      constraints: MediaStreamConstraints,
    ) => Promise<MediaStream>
  >();
const getDisplayMedia = vi.fn();
let animationStyle: HTMLStyleElement;
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom reports an empty animation-name; presence treats it as a pending
  // exit animation, but jsdom never dispatches animationend.
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("navigator", {
    ...navigator,
    mediaDevices: {
      getSupportedConstraints: () => ({}),
      enumerateDevices: vi.fn(async () => [
        {
          kind: "audioinput",
          deviceId: "mic-1",
          label: "Desk microphone",
        },
        {
          kind: "audioinput",
          deviceId: "mic-2",
          label: "Headset microphone",
        },
        {
          kind: "videoinput",
          deviceId: "cam-1",
          label: "Camera",
        },
        {
          kind: "videoinput",
          deviceId: "cam-2",
          label: "External camera",
        },
        {
          kind: "audiooutput",
          deviceId: "speaker-1",
          label: "Speaker",
        },
      ]),
      getUserMedia,
      getDisplayMedia,
    },
  });
  setAppState(reconcile(createInitialAppState()));
  setAppState("roomStatus", "roomId", "Current room");
  setAppState("message", "conversations", [
    {
      id: "current",
      kind: "room",
      title: "Current room",
      roomId: "Current room",
      namespace: "test",
      labelIds: [],
      createdAt: 0,
    },
    {
      id: "history",
      kind: "room",
      title: "Previous room",
      roomId: "Previous room",
      namespace: "test",
      labelIds: [],
      createdAt: 0,
    },
  ]);
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(initial: MediaStream | null = null) {
  const [activeRoom, setActiveRoom] = createSignal<
    string | null
  >("current");
  const [stream, setStream] =
    createSignal<MediaStream | null>(initial);
  const joinRoom = vi.fn();
  vi.mocked(useAppState).mockReturnValue({
    activeRoomConversationId: activeRoom,
    localStream: stream,
    replaceLocalStream: setStream,
    clearLocalStream: () => setStream(null),
    roomChatCapabilities: () => ({}),
    roomFileCapabilities: () => ({}),
    joinRoom,
  } as unknown as AppStateContextProps);
  let controls!: MeetingMediaContextValue;
  const Harness = () => {
    controls = useMeetingMedia();
    const dialog = createRoomInfoDialog();
    return (
      <>
        <button onClick={() => void dialog.open("current")}>
          Current settings
        </button>
        <button onClick={() => void dialog.open("history")}>
          Historical settings
        </button>
        <output data-testid="toolbar-microphone">
          {controls.devices.microphoneId()}
        </output>
      </>
    );
  };
  render(() => (
    <MeetingMediaProvider>
      <ModalProvider>
        <Harness />
      </ModalProvider>
    </MeetingMediaProvider>
  ));
  return {
    setActiveRoom,
    stream,
    joinRoom,
    get controls() {
      return controls;
    },
  };
}
const openDevices = async (name = "Current settings") => {
  fireEvent.click(screen.getByRole("button", { name }));
  const dialog = screen.getByRole("dialog");
  await userEvent.click(
    within(dialog).getByRole("tab", {
      name: "room_dialog.devices",
    }),
  );
  return dialog;
};

describe("room dialog and shared meeting device ownership", () => {
  it("allows clearing an active room but requires leaving before deletion", async () => {
    const f = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Current settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("tab", {
        name: "room_dialog.settings",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "conversations.delete",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "conversations.delete_requires_exit",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", {
        name: "conversations.clear",
      }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "conversations.clear_title",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", {
        name: "conversations.clear",
      }),
    );
    await waitFor(() =>
      expect(deletion.clear).toHaveBeenCalledWith(
        "current",
      ),
    );
    expect(deletion.remove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", {
        name: "room_dialog.title",
      }),
    ).toBeInTheDocument();
    expect(
      appState.message.conversations.some(
        (item) => item.id === "current",
      ),
    ).toBe(true);
    f.setActiveRoom(null);
    expect(
      screen.getByRole("button", {
        name: "conversations.delete",
      }),
    ).toBeEnabled();
  });

  it("rechecks room membership if the room is joined while deletion confirmation is open", async () => {
    const f = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Historical settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("tab", {
        name: "room_dialog.settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "conversations.delete",
      }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "conversations.delete_title",
    });
    f.setActiveRoom("history");
    await userEvent.click(
      within(confirmation).getByRole("button", {
        name: "common.action.delete",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "conversations.delete_title",
        }),
      ).toBeNull(),
    );
    expect(deletion.remove).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: "conversations.delete",
      }),
    ).toBeDisabled();
  });
  it("keeps the room conversation when removal is canceled", async () => {
    setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Historical settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("tab", {
        name: "room_dialog.settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "conversations.delete",
      }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "conversations.delete_title",
    });
    expect(deletion.remove).not.toHaveBeenCalled();
    await userEvent.click(
      within(confirmation).getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "conversations.delete",
        }),
      ).toBeEnabled(),
    );
    expect(deletion.remove).not.toHaveBeenCalled();
    expect(
      appState.message.conversations.some(
        (room) => room.id === "history",
      ),
    ).toBe(true);
  });

  it("removes the selected room after confirmation and closes its settings", async () => {
    const f = setup();
    deletion.remove.mockImplementationOnce((id) => {
      setAppState("message", "conversations", (items) =>
        items.filter((item) => item.id !== id),
      );
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Historical settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("tab", {
        name: "room_dialog.settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "conversations.delete",
      }),
    );
    const confirmation = screen.getByRole("dialog", {
      name: "conversations.delete_title",
    });
    await userEvent.click(
      within(confirmation).getByRole("button", {
        name: "common.action.delete",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    expect(deletion.remove).toHaveBeenCalledOnce();
    expect(deletion.remove).toHaveBeenCalledWith("history");
    expect(
      appState.message.conversations.map((room) => room.id),
    ).toEqual(["current"]);
    expect(f.joinRoom).not.toHaveBeenCalled();
  });

  it("shows live members and retained room contacts, updating when a private conversation is deleted", async () => {
    setup();
    setAppState("profile", {
      clientId: "me",
      name: "Myself",
      avatar: null,
    });
    const contacts: Conversation[] = [
      {
        id: "alice-chat",
        kind: "direct",
        peerId: "alice",
        title: "Alice",
        roomConversationIds: ["current"],
        labelIds: [],
        createdAt: 0,
      },
      {
        id: "bob-chat",
        kind: "direct",
        peerId: "bob",
        title: "Bob",
        roomConversationIds: ["current"],
        labelIds: [],
        createdAt: 0,
      },
      {
        id: "other-chat",
        kind: "direct",
        peerId: "other",
        title: "Other room member",
        roomConversationIds: ["history"],
        labelIds: [],
        createdAt: 0,
      },
    ];
    setAppState("message", "conversations", (items) => [
      ...items,
      ...contacts,
    ]);
    setAppState("session", "clientViewData", "alice", {
      clientId: "alice",
      name: "Alice",
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Current settings",
      }),
    );
    await userEvent.click(
      screen.getByRole("tab", {
        name: "room_dialog.members",
      }),
    );
    const online = screen.getByRole("list", {
      name: /^room_dialog.online_members/,
    });
    expect(within(online).getByText("Myself")).toBeTruthy();
    expect(within(online).getByText("Alice")).toBeTruthy();
    const previous = () =>
      screen.getByRole("list", {
        name: /^room_dialog.previous_members/,
      });
    expect(
      within(previous()).getByText("Bob"),
    ).toBeTruthy();
    expect(
      screen.queryByText("Other room member"),
    ).toBeNull();

    setAppState(
      "session",
      "clientViewData",
      "alice",
      undefined!,
    );
    expect(
      within(previous()).getByText("Alice"),
    ).toBeTruthy();
    setAppState("message", "conversations", (items) =>
      items.filter((item) => item.id !== "bob-chat"),
    );
    expect(screen.queryByText("Bob")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("configures small-file downloads for the selected room without opening devices", async () => {
    setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Current settings",
      }),
    );
    const dialog = screen.getByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("tab", {
        name: "room_dialog.settings",
      }),
    );
    const toggle = within(dialog).getByRole("switch", {
      name: "room_dialog.auto_download.title",
    });
    expect(toggle).not.toBeChecked();
    const limit = within(dialog).getByRole("combobox", {
      name: /^room_dialog\.auto_download\.limit/,
    });
    expect(limit).toBeDisabled();
    expect(limit).toHaveTextContent("5 MB");
    fireEvent.click(toggle);
    expect(limit).toBeEnabled();
    await userEvent.click(limit);
    await userEvent.click(
      await screen.findByRole("option", { name: "10 MB" }),
    );
    expect(
      resolveRoomConfig(appState.options, "current"),
    ).toEqual({
      autoDownloadFiles: true,
      autoDownloadMaxSize: 10 * 1024 * 1024,
    });
    expect(
      resolveRoomConfig(appState.options, "history")
        .autoDownloadFiles,
    ).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("requests device access without publishing or changing existing meeting tracks", async () => {
    const enumerate = vi.mocked(
      navigator.mediaDevices.enumerateDevices,
    );
    const available = await enumerate();
    enumerate.mockResolvedValue(
      available.map((device) => ({
        ...device,
        label: "",
        deviceId: "",
      })),
    );
    const live = new Track();
    live.enabled = false;
    const initial = new Stream([
      live as unknown as MediaStreamTrack,
    ]) as unknown as MediaStream;
    const f = setup(initial);
    const dialog = await openDevices();
    const field = dialog.querySelector<HTMLElement>(
      '[data-device-kind="videoinput"]',
    )!;
    await waitFor(() =>
      expect(
        within(field).getByRole("button"),
      ).toBeEnabled(),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    const probe = new Track("video", "cam-1");
    getUserMedia.mockImplementationOnce(async () => {
      enumerate.mockResolvedValue(available);
      return new Stream([
        probe as unknown as MediaStreamTrack,
      ]) as unknown as MediaStream;
    });
    fireEvent.click(within(field).getByRole("button"));
    await waitFor(() =>
      expect(probe.stop).toHaveBeenCalledOnce(),
    );
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: true,
    });
    expect(f.stream()).toBe(initial);
    expect(live.stop).not.toHaveBeenCalled();
    expect(live.enabled).toBe(false);
    expect(f.controls.media.cameraOn()).toBe(false);
    expect(
      within(field).getByRole("combobox"),
    ).toBeEnabled();
    expect(within(field).queryByRole("button")).toBeNull();
  });

  it("shows denied device access instead of claiming there are no connected devices", async () => {
    const enumerate = vi.mocked(
      navigator.mediaDevices.enumerateDevices,
    );
    enumerate.mockResolvedValue([]);
    const f = setup();
    const dialog = await openDevices();
    getUserMedia.mockRejectedValueOnce(
      new DOMException("Blocked", "NotAllowedError"),
    );
    const field = dialog.querySelector<HTMLElement>(
      '[data-device-kind="videoinput"]',
    )!;
    await waitFor(() =>
      expect(
        within(field).getByRole("button"),
      ).toBeEnabled(),
    );
    fireEvent.click(within(field).getByRole("button"));
    await waitFor(() =>
      expect(
        within(field).getByRole("status"),
      ).toHaveTextContent("meeting.device_disabled"),
    );
    expect(within(field).queryByRole("button")).toBeNull();
    expect(
      within(field).getByRole("combobox"),
    ).toBeDisabled();
    expect(f.stream()).toBeNull();
  });

  it("shows room information without starting capture or joining another room", () => {
    const f = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Current settings",
      }),
    );
    expect(
      within(screen.getByRole("dialog")).getByDisplayValue(
        "Current room",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("room_dialog.file_hint"),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(f.joinRoom).not.toHaveBeenCalled();
  });

  it("keeps an off-device preference shared with the toolbar across dialog close/reopen", async () => {
    const f = setup();
    await openDevices();
    expect(screen.queryByRole("switch")).toBeNull();
    const microphone = screen.getByRole("combobox", {
      name: /^meeting\.microphone_device/,
    });
    await waitFor(() =>
      expect(microphone).not.toBeDisabled(),
    );
    await userEvent.click(microphone);
    await userEvent.click(
      screen.getByRole("option", {
        name: "Headset microphone",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("toolbar-microphone"),
      ).toHaveTextContent("mic-2"),
    );
    expect(getUserMedia).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    expect(f.controls.devices.microphoneId()).toBe("mic-2");
    await openDevices();
    expect(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }),
    ).toHaveTextContent("Headset microphone");
    await f.controls.media.selectMicrophone("mic-1");
    expect(
      screen.getByRole("combobox", {
        name: /^meeting\.microphone_device/,
      }),
    ).toHaveTextContent("Desk microphone");
  });

  it("keeps historical room information separate and prevents changing current-room devices there", async () => {
    const f = setup();
    await openDevices("Historical settings");
    expect(
      screen.getByText("room_dialog.inactive_devices"),
    ).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(f.joinRoom).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "selects devices without touching existing tracks when microphone enabled is %s",
    async (enabled) => {
      const mic = new Track();
      mic.enabled = enabled;
      const camera = new Track("video", "cam-1");
      const initial = new Stream([
        mic,
        camera,
      ] as unknown as MediaStreamTrack[]) as unknown as MediaStream;
      const f = setup(initial);
      await openDevices();
      expect(screen.queryByRole("switch")).toBeNull();
      for (const [name, label] of [
        ["meeting.microphone_device", "Headset microphone"],
        ["meeting.camera_device", "External camera"],
      ]) {
        const field = screen.getByRole("combobox", {
          name: new RegExp(name),
        });
        await waitFor(() =>
          expect(field).not.toBeDisabled(),
        );
        await userEvent.click(field);
        await userEvent.click(
          screen.getByRole("option", { name: label }),
        );
        await waitFor(() =>
          expect(field).toHaveTextContent(label),
        );
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: "meeting.refresh_devices",
        }),
      );
      f.controls.media.sync();
      expect(f.controls.devices.microphoneId()).toBe(
        "mic-2",
      );
      expect(f.controls.devices.cameraId()).toBe("cam-2");
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(getDisplayMedia).not.toHaveBeenCalled();
      expect(f.stream()).toBe(initial);
      expect(mic.enabled).toBe(enabled);
      expect(camera.enabled).toBe(true);
      expect(mic.stop).not.toHaveBeenCalled();
      expect(camera.stop).not.toHaveBeenCalled();
    },
  );

  it("cancels a pending capture when the room changes and hides stale device controls", async () => {
    const f = setup();
    const pending = deferred<MediaStream>();
    getUserMedia.mockReturnValueOnce(pending.promise);
    await openDevices();
    void f.controls.media.toggleMicrophone();
    expect(getUserMedia).toHaveBeenCalledOnce();
    f.setActiveRoom(null);
    await waitFor(() =>
      expect(screen.queryByRole("combobox")).toBeNull(),
    );
    const track = new Track();
    pending.resolve(
      new Stream([
        track as unknown as MediaStreamTrack,
      ]) as unknown as MediaStream,
    );
    await waitFor(() =>
      expect(track.stop).toHaveBeenCalledOnce(),
    );
    expect(f.stream()).toBeNull();
  });
});
