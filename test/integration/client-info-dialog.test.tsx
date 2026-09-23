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
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  ClientInfoPanel,
  default as clientInfoDialog,
  type ClientInfoTab,
} from "@/components/dialogs/client-info-dialog";
import { createDialog } from "@/components/dialogs/dialog";
import { useAppState } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import type { SpeedTestState } from "@/libs/application/speed-test-service";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/components/dialogs/dialog", () => ({
  createDialog: vi.fn(),
}));
vi.mock("@/components/common/connection-badge", () => ({
  ConnectionBadge: () => <span>online</span>,
}));
vi.mock("@/components/icons", () => ({
  IconAssignment: () => <span />,
  IconConnectWithoutContract: () => <span />,
  IconDelete: () => <span />,
  IconInfo: () => <span />,
}));
vi.mock(
  "@/libs/application/messaging/message-store",
  () => ({
    messageStores: {
      deleteConversation: vi.fn(),
      clearConversation: vi.fn(),
    },
  }),
);
vi.mock("@/options", () => ({
  getClientConfig: vi.fn(() => ({
    provideFileList: true,
  })),
  setAppOptions: vi.fn(),
  setClientConfig: vi.fn(),
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    options: {
      redirectToClient: undefined,
      clientConfigs: {},
    },
    session: {
      sessions: {},
      clientViewData: {},
      clientServiceStatus: "connected",
    },
    profile: { clientId: "local" },
    message: {
      clients: [],
      conversations: [
        {
          id: 'direct:["local","peer"]',
          kind: "direct",
          peerId: "peer",
          title: "Peer",
          labelIds: [],
          createdAt: 1,
        },
      ],
    },
  },
}));
const cancel = vi.fn();
const start = vi.fn();
let state: SpeedTestState;
let dialogOptions: Parameters<typeof createDialog>[0];
const report = (sent = 10) =>
  new Map([
    [
      "transport",
      {
        type: "transport",
        selectedCandidatePairId: "pair",
      },
    ],
    [
      "pair",
      {
        type: "candidate-pair",
        localCandidateId: "local",
        remoteCandidateId: "remote",
        currentRoundTripTime: 0.015,
        bytesSent: sent,
        bytesReceived: 20,
      },
    ],
    [
      "local",
      { type: "local-candidate", candidateType: "host" },
    ],
    [
      "remote",
      { type: "remote-candidate", candidateType: "srflx" },
    ],
  ]) as unknown as RTCStatsReport;
const peer = (
  getStats = vi.fn().mockResolvedValue(report()),
) => ({ peerConnection: { getStats } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  state = {
    id: "active",
    startedAt: 1,
    peerId: "peer",
    status: "running",
    progress: { phase: "upload", bytes: 1024 },
  };
  vi.mocked(useAppState).mockReturnValue({
    speedTestState: () => state,
    getSpeedTestState: (id: string) =>
      state.peerId === id ? state : undefined,
    startSpeedTest: start,
    cancelSpeedTest: cancel,
  } as any);
  appState.session.sessions = {
    peer: peer(),
    other: peer(),
  };
  appState.session.clientViewData = {
    peer: { createdAt: 1, onlineStatus: "online" },
    other: { createdAt: 2, onlineStatus: "online" },
  } as any;
  appState.message.clients = [
    { clientId: "peer", name: "Peer" },
    { clientId: "other", name: "Other" },
  ] as any;
  vi.mocked(createDialog).mockImplementation((options) => {
    dialogOptions = options;
    return {
      open: vi.fn().mockResolvedValue({ cancel: true }),
      close: () => options.onCancel?.(),
      submit: vi.fn(),
    };
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount(initial: ClientInfoTab = "session") {
  const [tab, setTab] =
    createSignal<ClientInfoTab>(initial);
  const [active, setActive] = createSignal(true);
  const [id, setId] = createSignal("peer");
  const view = render(() => (
    <ClientInfoPanel
      clientId={id()}
      active={active()}
      tab={tab()}
      onTabChange={setTab}
    />
  ));
  return { ...view, setActive, setId };
}

describe("tabbed client information", () => {
  it("keeps clear history available in online private settings and disables deletion", () => {
    mount("settings");
    expect(
      screen.getByRole("button", {
        name: "conversations.clear",
      }),
    ).toBeEnabled();
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
  });
  it("shows four accessible tabs and keeps raw data out of the session pane", async () => {
    mount();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(
      screen.getByRole("tab", {
        name: "common.client_info_dialog.tabs.session",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("textbox", {
        name: "common.client_info_dialog.stats_reports",
      }),
    ).toBeNull();
    await screen.findByText("host → srflx");
    expect(screen.getByText("15.0 ms")).toBeInTheDocument();
  });
  it("shows client preferences in the settings tab without opening another info dialog", () => {
    mount("settings");
    expect(
      screen.getByRole("tab", {
        name: "common.client_info_dialog.tabs.settings",
      }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(
      screen.getByText("client.config.redirect.title"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "client.config.provide_file_list.title",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "client.menu.connection_status",
      }),
    ).toBeNull();
  });

  it("announces when the speed-test tab becomes visible", async () => {
    const visible = vi.fn();
    window.addEventListener(
      "weblink:client-info-dialog-tab-visible",
      visible,
    );

    mount();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "common.client_info_dialog.tabs.speed",
      }),
    );

    await waitFor(() => expect(visible).toHaveBeenCalled());
    expect(
      (visible.mock.calls.at(-1)?.[0] as CustomEvent)
        .detail,
    ).toEqual({ clientId: "peer", tab: "speed" });

    window.removeEventListener(
      "weblink:client-info-dialog-tab-visible",
      visible,
    );
  });

  it("changing tabs does not cancel a running test and returning shows its phase", () => {
    mount("speed");
    expect(
      screen.getByRole("meter", {
        name: /speed_test\.phases\.upload/,
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "common.client_info_dialog.tabs.raw",
      }),
    );
    expect(
      screen.getByRole("textbox", {
        name: "common.client_info_dialog.stats_reports",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("tab", {
        name: "common.client_info_dialog.tabs.speed",
      }),
    );
    expect(
      screen.getByRole("meter", {
        name: /speed_test\.phases\.upload/,
      }),
    ).toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("hiding, changing peers and unmounting do not cancel an application task", () => {
    const view = mount("speed");
    view.setActive(false);
    view.setId("other");
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
    expect(state.status).toBe("running");
    mount("speed");
    expect(
      screen.getByRole("meter", {
        name: /speed_test\.phases\.upload/,
      }),
    ).toBeInTheDocument();
  });
  it("the dialog close handler and switching target never invoke cancellation", () => {
    let dialog!: ReturnType<typeof clientInfoDialog>;
    const view = render(() => {
      dialog = clientInfoDialog();
      return <span>host</span>;
    });
    void dialog.open("peer", "speed");
    dialogOptions.onCancel?.();
    void dialog.open("other");
    dialog.close();
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("only explicit Stop calls the cancellation API", () => {
    mount("speed");
    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.cancel",
      }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("peer");
  });
  it("does not apply late statistics from the previously selected peer", async () => {
    let resolve!: (value: RTCStatsReport) => void;
    appState.session.sessions.peer = peer(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    appState.session.sessions.other = peer(
      vi.fn().mockResolvedValue(report(200)),
    );
    const view = mount();
    view.setId("other");
    await screen.findByText("200.00 B");
    resolve(report(900));
    await Promise.resolve();
    expect(screen.queryByText("900.00 B")).toBeNull();
  });
  it("stops statistics polling while hidden and restarts on reopen", async () => {
    vi.useFakeTimers();
    const getStats = vi.fn().mockResolvedValue(report());
    appState.session.sessions.peer = peer(getStats);
    const view = mount();
    await vi.advanceTimersByTimeAsync(1);
    expect(getStats).toHaveBeenCalledTimes(1);
    view.setActive(false);
    await vi.advanceTimersByTimeAsync(4000);
    expect(getStats).toHaveBeenCalledTimes(1);
    view.setActive(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(getStats).toHaveBeenCalledTimes(2);
  });
  it("does not overlap slow getStats requests", async () => {
    vi.useFakeTimers();
    const getStats = vi.fn(
      () => new Promise<RTCStatsReport>(() => {}),
    );
    appState.session.sessions.peer = peer(getStats);
    mount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getStats).toHaveBeenCalledTimes(1);
  });
  it("handles statistics rejection without an unhandled promise or stale data", async () => {
    appState.session.sessions.peer = peer(
      vi.fn().mockRejectedValue(new Error("closed")),
    );
    mount();
    await screen.findByText(
      "common.client_info_dialog.stats_error",
    );
    expect(screen.queryByText("host → srflx")).toBeNull();
  });
  it("copies the raw JSON report and handles unavailable clipboard access", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mount("raw");
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "common.action.copy",
        }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.copy",
      }),
    );
    await screen.findByText(
      "common.client_info_dialog.copied",
    );
    expect(
      JSON.parse(writeText.mock.calls[0][0]),
    ).toHaveLength(4);
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.copy",
      }),
    );
    await screen.findByText(
      "common.client_info_dialog.error",
    );
  });
});
