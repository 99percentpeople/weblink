// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MeetingInfoPanel } from "@/routes/home/components/meeting-info-panel";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    roomChatCapabilities: () => ({
      bob: "supported",
      carol: "unsupported",
    }),
    roomFileCapabilities: () => ({
      bob: "supported",
      carol: "supported",
    }),
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  setAppState(reconcile(createInitialAppState()));
  setAppState("roomStatus", {
    roomId: "room-a",
    joinedAt: 5_000,
  });
  setAppState(
    "session",
    "clientServiceStatus",
    "connected",
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const metric = (label: string) =>
  screen.getByText(label).nextElementSibling;
const mount = (onOpenSettings = vi.fn()) =>
  render(() => (
    <MeetingInfoPanel
      roomId={appState.roomStatus.roomId}
      active={!!appState.roomStatus.roomId}
      onOpenSettings={onOpenSettings}
    />
  ));

describe("meeting online information", () => {
  it("keeps elapsed time across remounts and cleans up the display timer", () => {
    const first = mount();
    expect(
      metric("meeting.online_duration"),
    ).toHaveTextContent("00:00:05");
    vi.advanceTimersByTime(3000);
    expect(
      metric("meeting.online_duration"),
    ).toHaveTextContent("00:00:08");
    first.unmount();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    mount();
    expect(
      metric("meeting.online_duration"),
    ).toHaveTextContent("01:00:08");

    setAppState("roomStatus", {
      roomId: null,
      joinedAt: null,
    });
    expect(
      metric("meeting.online_duration"),
    ).toHaveTextContent("—");
    expect(vi.getTimerCount()).toBe(0);
    setAppState("roomStatus", {
      roomId: "room-b",
      joinedAt: Date.now(),
    });
    expect(
      metric("meeting.online_duration"),
    ).toHaveTextContent("00:00:00");
    vi.advanceTimersByTime(1000);
    expect(
      metric("meeting.online_duration"),
    ).toHaveTextContent("00:00:01");
  });

  it("shows current connection and peer availability without repeating room storage details", () => {
    for (const [id, onlineStatus, messageChannel] of [
      ["bob", "online", true],
      ["carol", "online", true],
      ["video-only", "online", false],
      ["offline", "offline", true],
    ] as const) {
      setAppState("session", "clientViewData", id, {
        clientId: id,
        name: id,
        avatar: null,
        createdAt: 0,
        onlineStatus,
        messageChannel,
      });
    }
    const openSettings = vi.fn();
    mount(openSettings);
    expect(
      screen.getByText("meeting.status_online"),
    ).toBeInTheDocument();
    expect(
      metric("room_dialog.online_members"),
    ).toHaveTextContent("4");
    expect(
      metric("meeting.chat_support"),
    ).toHaveTextContent("1 / 2");
    expect(
      metric("meeting.file_support"),
    ).toHaveTextContent("2 / 2");
    expect(
      screen.queryByText("meeting.local_history"),
    ).toBeNull();
    expect(
      screen.queryByText("meeting.history_hint"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "room_dialog.open",
      }),
    );
    expect(openSettings).toHaveBeenCalledOnce();

    setAppState(
      "session",
      "clientViewData",
      "bob",
      "onlineStatus",
      "offline",
    );
    expect(
      metric("room_dialog.online_members"),
    ).toHaveTextContent("3");
    expect(
      metric("meeting.chat_support"),
    ).toHaveTextContent("0 / 1");
    setAppState(
      "session",
      "clientServiceStatus",
      "connecting",
    );
    expect(
      screen.getByText("meeting.status_reconnecting"),
    ).toBeInTheDocument();
    setAppState(
      "session",
      "clientServiceStatus",
      "disconnected",
    );
    expect(
      screen.getByText("meeting.status_offline"),
    ).toBeInTheDocument();
  });

  it("shows no online metrics or timer before joining", () => {
    setAppState("roomStatus", {
      roomId: null,
      joinedAt: null,
    });
    mount();
    for (const key of [
      "meeting.online_duration",
      "room_dialog.online_members",
      "meeting.chat_support",
      "meeting.file_support",
    ]) {
      expect(metric(key)).toHaveTextContent("—");
    }
    expect(vi.getTimerCount()).toBe(0);
    setAppState(
      "session",
      "clientServiceStatus",
      "connecting",
    );
    expect(
      screen.getByText("meeting.status_connecting"),
    ).toBeInTheDocument();
  });
});
