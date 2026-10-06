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
  within,
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { createRoot } from "solid-js";
import userEvent from "@testing-library/user-event";
import { resolveRoomConfig } from "@/libs/state/app-options";
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
import { MessageStores } from "@/libs/application/messaging/message-store";
import { roomConversationId } from "@/libs/domain/conversation";
import { createMessageRepository } from "../support/message-repository";
import { summarizeConversations } from "@/libs/application/messaging/conversation-query";

const fixture = vi.hoisted(() => ({
  store: undefined as MessageStores | undefined,
}));
vi.mock(
  "@/libs/application/messaging/message-store",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/libs/application/messaging/message-store")
    >()),
    get messageStores() {
      return fixture.store;
    },
  }),
);
vi.mock("@/libs/application/room-identity", () => ({
  getRoomNamespace: () => "server",
}));

vi.mock("@/i18n", () => ({
  t: (key: string, values?: { name: string }) =>
    values ? `${key}: ${values.name}` : key,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    activeRoomConversationId: () =>
      appState.roomStatus.roomId,
  }),
}));
vi.mock(
  "@/components/conversations/conversation-actions",
  () => ({ ConversationActions: () => null }),
);
let animationStyle: HTMLStyleElement;
beforeEach(() => {
  // jsdom does not finish the select's exit animation.
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  setAppState(reconcile(createInitialAppState()));
  setAppState("roomStatus", "roomId", "room-current");
  fixture.store = undefined;
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("sorts permission groups by the same persisted activity as chat and reacts to online and message updates", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  setAppState("profile", "clientId", "local");
  const store = new MessageStores(
    createMessageRepository(),
  );
  fixture.store = store;
  await store.initialize();
  for (const name of ["Alice", "Bob"]) {
    setClientConfig(name, { name });
    await store.setClient({
      clientId: name,
      name,
      avatar: null,
    });
  }
  await store.recordClientOnline("Alice", 100);
  await store.recordClientOnline("Bob", 200);
  await store.recordRoomJoin("Old", "server", null, 100);
  await store.recordRoomJoin("New", "server", null, 200);
  for (const name of ["Old", "New"])
    setRoomConfig(roomConversationId("server", name), {
      name,
    });
  setRoomConfig("orphan", { name: "Unknown" });
  render(() => <PermissionsSettings />);
  const names = () =>
    screen
      .getAllByRole("button", {
        name: /^setting.permissions.configure:/,
      })
      .map(
        (button) =>
          button.getAttribute("aria-label")!.split(": ")[1],
      );
  expect(names()).toEqual([
    "Bob",
    "Alice",
    "New",
    "Old",
    "Unknown",
  ]);
  now.mockReturnValue(300);
  await store.setSendMessage({
    id: "new-private",
    type: "send-text",
    client: "local",
    target: "Alice",
    data: "hello",
    createdAt: 300,
  });
  expect(names()).toEqual([
    "Alice",
    "Bob",
    "New",
    "Old",
    "Unknown",
  ]);
  now.mockReturnValue(400);
  await store.putRoomMessage({
    id: "new-room",
    type: "text",
    client: "Bob",
    target: "local",
    data: "hello",
    createdAt: 1,
    conversationId: roomConversationId("server", "Old"),
    room: {
      roomId: "Old",
      senderName: "Bob",
      senderAvatar: null,
    },
  });
  expect(names()).toEqual([
    "Alice",
    "Bob",
    "Old",
    "New",
    "Unknown",
  ]);
  const summaries = summarizeConversations(
    store.conversations,
    store.clients,
    store.messages,
    "local",
    new Set(),
    roomConversationId("server", "New"),
  );
  expect(summaries.map((summary) => summary.title)).toEqual(
    ["Old", "Alice", "Bob", "New"],
  );
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
  });
  forgetRoomConfig("room-offline", "room-current");
  expect(
    appState.options.roomConfigs["room-offline"],
  ).toBeUndefined();
});

it("edits client and room permissions through selects and preserves the other entry's permissions", async () => {
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
  const clientDialog = await screen.findByRole("dialog");
  expect(clientDialog).toHaveTextContent("Alice");
  expect(
    within(clientDialog).queryByRole("switch"),
  ).toBeNull();
  const choose = async (
    label: string,
    decision: string,
  ) => {
    await userEvent.click(
      screen.getByRole("button", {
        name: (name) => name.startsWith(label),
      }),
    );
    await userEvent.click(
      await screen.findByRole("option", {
        name: `setting.permissions.${decision}`,
      }),
    );
  };
  for (const decision of [
    "deny",
    "ask",
    "allow",
  ] as const) {
    await choose(
      "app_menu.settings_remote_control",
      decision,
    );
    expect(
      appState.options.clientConfigs.alice?.remoteControl,
    ).toBe(decision === "ask" ? undefined : decision);
  }
  await choose(
    "client.config.provide_file_list.title",
    "disallowed",
  );
  expect(
    appState.options.clientConfigs.alice?.provideFileList,
  ).toBe(false);
  expect(
    appState.options.clientConfigs.bob?.provideFileList,
  ).toBe(false);
  await choose(
    "client.config.provide_file_list.title",
    "allowed",
  );
  expect(
    appState.options.clientConfigs.alice?.provideFileList,
  ).toBe(true);
  expect(
    appState.options.clientConfigs.alice?.remoteControl,
  ).toBe("allow");
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.permissions.configure: Meeting",
    }),
  );
  const roomDialog = await screen.findByRole("dialog");
  expect(roomDialog).toHaveTextContent("Meeting");
  expect(
    within(roomDialog).queryByRole("switch"),
  ).toBeNull();
  await choose(
    "room_dialog.auto_download.title",
    "allowed",
  );
  expect(
    appState.options.roomConfigs["room-current"]
      ?.autoDownloadFiles,
  ).toBe(true);
  await choose(
    "room_dialog.auto_download.title",
    "disallowed",
  );
  expect(
    appState.options.roomConfigs["room-current"]
      ?.autoDownloadFiles,
  ).toBe(false);
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

it.each(["room-current", "room-offline"])(
  "resets %s permissions without removing join history, passwords or chats",
  async (id) => {
    const room = {
      id,
      kind: "room" as const,
      roomId: "Meeting",
      namespace: "server",
      title: "Meeting",
      labelIds: [],
      createdAt: 1,
      lastJoinedAt: 2,
      joinPassword: "saved-password",
    };
    const message = {
      id: "message",
      conversationId: id,
      client: "peer",
      target: "local",
      type: "text" as const,
      data: "Saved chat",
      createdAt: 3,
    };
    setAppState("message", "conversations", [room]);
    setAppState("message", "messages", [message]);
    setAppState("profile", {
      roomId: "Meeting",
      password: "saved-password",
    });
    setRoomConfig(id, { autoDownloadFiles: true });
    setRoomConfig("unrelated", {
      name: "Unrelated",
      autoDownloadFiles: true,
    });
    render(() => <PermissionsSettings />);
    expect(
      screen.queryByRole("button", {
        name: "setting.permissions.reset: Meeting",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.permissions.configure: Meeting",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "setting.permissions.reset: Meeting",
      }),
    );
    expect(
      resolveRoomConfig(appState.options, id)
        .autoDownloadFiles,
    ).toBe(false);
    expect(appState.message.conversations).toEqual([room]);
    expect(appState.message.messages).toEqual([message]);
    expect(appState.profile.password).toBe(
      "saved-password",
    );
    expect(
      appState.options.roomConfigs.unrelated
        ?.autoDownloadFiles,
    ).toBe(true);
    expect(appState.options.roomConfigs[id]).toMatchObject({
      name: "Meeting",
      autoDownloadFiles: false,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss" }),
    );
    expect(
      screen.getByRole("button", {
        name: "setting.permissions.configure: Meeting",
      }),
    ).toBeInTheDocument();
  },
);

async function seedRoomHistory(withConversation = true) {
  const id = roomConversationId("server", "Meeting");
  const room = {
    id,
    kind: "room" as const,
    roomId: "Meeting",
    namespace: "server",
    title: "Meeting",
    labelIds: [],
    createdAt: 1,
    lastJoinedAt: 2,
    joinPassword: "saved-password",
  };
  const repo = createMessageRepository(
    {},
    {
      clients: [],
      conversations: withConversation ? [room] : [],
      messages: withConversation
        ? [
            {
              id: "message",
              conversationId: id,
              client: "peer",
              target: "local",
              type: "text",
              data: "Saved chat",
              createdAt: 3,
              room: {
                roomId: "Meeting",
                senderName: "Peer",
                senderAvatar: null,
              },
            },
          ]
        : [],
    },
  );
  fixture.store = new MessageStores(repo);
  await fixture.store.initialize();
  setAppState("profile", {
    roomId: "Meeting",
    password: "saved-password",
  });
  setRoomConfig(id, {
    name: "Meeting",
    autoDownloadFiles: true,
  });
  setRoomConfig("unrelated", {
    name: "Unrelated",
    autoDownloadFiles: true,
  });
  return { id, room, repo };
}

it.each([true, false])(
  "deletes inactive room history from the permissions list, including permissions-only entries (conversation=%s)",
  async (withConversation) => {
    const { id, repo } = await seedRoomHistory(
      withConversation,
    );
    render(() => <PermissionsSettings />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.permissions.delete_room: Meeting",
      }),
    );
    const confirmation = await screen.findByRole("dialog");
    expect(confirmation).toHaveTextContent(
      "conversations.delete_room_description: Meeting",
    );
    expect(appState.options.roomConfigs[id]).toBeDefined();
    fireEvent.click(
      within(confirmation).getByRole("button", {
        name: "common.action.confirm",
      }),
    );
    expect(
      appState.options.roomConfigs[id],
    ).toBeUndefined();
    expect(
      appState.options.roomConfigs.unrelated
        ?.autoDownloadFiles,
    ).toBe(true);
    expect(appState.profile.password).toBeNull();
    expect(appState.profile.roomId).toBe("");
    expect(
      screen.queryByRole("button", {
        name: "setting.permissions.delete_room: Meeting",
      }),
    ).toBeNull();
    expect(repo.records.conversations.has(id)).toBe(false);
    expect(repo.records.messages.size).toBe(0);
    const reloaded = new MessageStores(repo);
    await reloaded.initialize();
    expect(reloaded.conversations).toHaveLength(0);
    expect(reloaded.messages).toHaveLength(0);
  },
);

it("keeps room history and permissions when list deletion is canceled", async () => {
  const { id, repo } = await seedRoomHistory();
  render(() => <PermissionsSettings />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.permissions.delete_room: Meeting",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  expect(
    appState.options.roomConfigs[id]?.autoDownloadFiles,
  ).toBe(true);
  expect(repo.records.conversations.has(id)).toBe(true);
  expect(repo.records.messages.size).toBe(1);
  expect(appState.profile.password).toBe("saved-password");
});

it("blocks deletion for an active room and when it is joined while confirmation is open", async () => {
  const { id, repo } = await seedRoomHistory();
  setAppState("roomStatus", "roomId", id);
  render(() => <PermissionsSettings />);
  const remove = screen.getByRole("button", {
    name: "setting.permissions.delete_room: Meeting",
  });
  expect(remove).toBeDisabled();
  fireEvent.click(remove);
  expect(screen.queryByRole("dialog")).toBeNull();
  setAppState("roomStatus", "roomId", null);
  expect(remove).toBeEnabled();
  fireEvent.click(remove);
  const confirmation = await screen.findByRole("dialog");
  setAppState("roomStatus", "roomId", id);
  const confirm = within(confirmation).getByRole("button", {
    name: "common.action.confirm",
  });
  expect(confirm).toBeDisabled();
  expect(
    within(confirmation).getByRole("status"),
  ).toHaveTextContent("conversations.delete_requires_exit");
  fireEvent.click(confirm);
  expect(
    appState.options.roomConfigs[id]?.autoDownloadFiles,
  ).toBe(true);
  expect(repo.records.conversations.has(id)).toBe(true);
  expect(repo.records.messages.size).toBe(1);
  expect(appState.profile.password).toBe("saved-password");
});

it("keeps an offline client's entry when its permissions are reset in the settings dialog", async () => {
  setClientConfig("peer", {
    name: "Peer",
    remoteControl: "allow",
    provideFileList: false,
  });
  render(() => <PermissionsSettings />);
  expect(
    screen.queryByRole("button", {
      name: "setting.permissions.reset: Peer",
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.permissions.configure: Peer",
    }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "setting.permissions.reset: Peer",
    }),
  );
  expect(appState.options.clientConfigs.peer).toEqual({
    name: "Peer",
    provideFileList: true,
  });
  expect(dialog).toBeInTheDocument();
});
