// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { createRoot } from "solid-js";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import {
  initializeAppOptions,
  setClientConfig,
  setRoomConfig,
  forgetClientConfig,
  forgetRoomConfig,
} from "@/options";
import PermissionsSettings from "@/components/settings/permissions-settings";

vi.mock("@/i18n", () => ({
  t: (key: string, values?: { name: string }) =>
    values ? `${key}: ${values.name}` : key,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    activeRoomConversationId: () => "room-current",
  }),
}));
vi.mock(
  "@/components/conversations/conversation-actions",
  () => ({ ConversationActions: () => null }),
);
beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("forgets offline entries but resets visible clients and the current room to defaults", () => {
  setClientConfig("online", {
    name: "Alice",
    remoteControl: "deny",
    provideFileList: false,
  });
  setClientConfig("offline", {
    name: "Bob",
    remoteControl: "allow",
  });
  setRoomConfig("room-current", {
    name: "Current",
    autoDownloadFiles: true,
  });
  setRoomConfig("room-offline", {
    name: "Past",
    autoDownloadFiles: true,
  });
  setAppState("session", "clientViewData", "online", {
    clientId: "online",
    name: "Alice",
    avatar: null,
    createdAt: 1,
    onlineStatus: "online",
    messageChannel: true,
  });
  forgetClientConfig("online");
  expect(appState.options.clientConfigs.online).toEqual({
    name: "Alice",
    provideFileList: true,
  });
  forgetClientConfig("offline");
  expect(
    appState.options.clientConfigs.offline,
  ).toBeUndefined();
  forgetRoomConfig("room-current", "room-current");
  expect(
    appState.options.roomConfigs["room-current"],
  ).toEqual({
    name: "Current",
    autoDownloadFiles: false,
    autoDownloadMaxSize: 5 * 1024 * 1024,
  });
  forgetRoomConfig("room-offline", "room-current");
  expect(
    appState.options.roomConfigs["room-offline"],
  ).toBeUndefined();
});

it("opens independent client and room settings and preserves the other entry's permissions", async () => {
  setClientConfig("alice", {
    name: "Alice",
    remoteControl: "allow",
  });
  setClientConfig("bob", {
    name: "Bob",
    provideFileList: false,
  });
  setRoomConfig("room-current", {
    name: "Meeting",
    autoDownloadFiles: false,
  });
  render(() => <PermissionsSettings />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.permissions.configure: Alice",
    }),
  );
  expect(
    await screen.findByRole("dialog"),
  ).toHaveTextContent("Alice");
  const files = screen.getByRole("switch", {
    name: "client.config.provide_file_list.title",
  });
  fireEvent.click(files);
  expect(
    appState.options.clientConfigs.alice?.provideFileList,
  ).toBe(false);
  expect(
    appState.options.clientConfigs.bob?.provideFileList,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.permissions.configure: Meeting",
    }),
  );
  expect(
    await screen.findByRole("dialog"),
  ).toHaveTextContent("Meeting");
  fireEvent.click(
    screen.getByRole("switch", {
      name: "room_dialog.auto_download.title",
    }),
  );
  expect(
    appState.options.roomConfigs["room-current"]
      ?.autoDownloadFiles,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.permissions.remove: Bob",
    }),
  );
  expect(screen.getByText("Bob")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.confirm",
    }),
  );
  expect(screen.queryByText("Bob")).toBeNull();
});

it("imports existing history once and does not resurrect forgotten records on later history updates", () => {
  localStorage.clear();
  let dispose!: () => void;
  createRoot((cleanup) => {
    dispose = cleanup;
    initializeAppOptions();
  });
  setAppState("message", "clients", [
    {
      clientId: "historic",
      name: "Historical peer",
      avatar: null,
    },
  ]);
  setAppState("message", "conversations", [
    {
      id: "room-old",
      kind: "room",
      roomId: "old",
      namespace: "server",
      title: "Old room",
      labelIds: [],
      createdAt: 1,
    },
  ]);
  setAppState("message", "status", "ready");
  expect(
    appState.options.clientConfigs.historic?.name,
  ).toBe("Historical peer");
  expect(
    appState.options.roomConfigs["room-old"]?.name,
  ).toBe("Old room");
  forgetClientConfig("historic");
  forgetRoomConfig("room-old", undefined);
  setAppState("message", "clients", [
    { clientId: "historic", name: "Updated", avatar: null },
  ]);
  expect(
    appState.options.clientConfigs.historic,
  ).toBeUndefined();
  expect(
    appState.options.roomConfigs["room-old"],
  ).toBeUndefined();
  expect(appState.options.permissionHistoryImported).toBe(
    true,
  );
  dispose();
});
