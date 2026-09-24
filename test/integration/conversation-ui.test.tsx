// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
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
import { MemoryRouter, Route } from "@solidjs/router";
import { createSignal, Show, type JSX } from "solid-js";
import { reconcile } from "solid-js/store";
import { ConversationSidebar } from "@/components/conversations/conversation-sidebar";
import { ConversationView } from "@/components/conversations/conversation-view";
import { createMessageStores } from "@/libs/application/messaging/message-store";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import {
  directConversationId,
  roomConversationId,
} from "@/libs/domain/conversation";
import type {
  StoreMessage,
  TextMessage,
} from "@/libs/domain/message";

const service = vi.hoisted(() => ({
  sendRoomText: vi.fn(),
  sendRoomFile: vi.fn(),
  sendFile: vi.fn(),
  fileCapability: "supported",
  sendClipboard: vi.fn(),
  following: (() => true) as () => boolean,
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: Record<string, unknown>) =>
    key + (values?.name ? `:${values.name}` : ""),
}));
vi.mock("lucide-solid", () => {
  const Icon = () => null;
  return {
    Search: Icon,
    Library: Icon,
    ListFilter: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    MoreHorizontal: Icon,
    Users: Icon,
    MessageCircle: Icon,
    FolderSync: Icon,
    Settings: Icon,
    Trash2: Icon,
    Eraser: Icon,
    PanelLeftOpen: Icon,
    Plus: Icon,
    Check: Icon,
    Tags: Icon,
    ArrowDown: Icon,
    ChevronLeft: Icon,
    Send: Icon,
    Video: Icon,
  };
});
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    activeRoomConversationId: () =>
      appState.roomStatus.roomId
        ? roomConversationId(
            "test-service",
            appState.roomStatus.roomId,
          )
        : null,
    roomChatCapabilities: () => ({ alice: "supported" }),
    roomFileCapabilities: () => ({
      alice: service.fileCapability,
    }),
    sendRoomText: service.sendRoomText,
    sendRoomFile: service.sendRoomFile,
    sendFile: service.sendFile,
    sendClipboard: service.sendClipboard,
  }),
}));
vi.mock("@/libs/hooks/create-bottom-scroll", () => ({
  createBottomScroll: () => ({
    positioned: () => true,
    following: () => service.following(),
    viewport: () => undefined,
    viewportRef: () => {},
    contentRef: () => {},
    toBottom: vi.fn(),
    preservePosition: (action: () => void) => action(),
  }),
}));
vi.mock(
  "@/libs/application/transfer/transfer-service",
  () => ({ transferManager: {} }),
);
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {},
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleDropItems: vi.fn(),
}));
vi.mock(
  "@/components/dialogs/delete-file-message-dialog",
  () => ({
    createDeleteFileMessageDialog: () => ({
      open: vi.fn(),
    }),
  }),
);
vi.mock(
  "@/components/dialogs/delete-conversation-dialog",
  () => ({
    createDeleteConversationDialog: () => ({
      open: async () => ({ result: true }),
    }),
    createClearConversationDialog: () => ({
      open: async () => ({ result: true }),
    }),
  }),
);
vi.mock("@/components/dialogs/client-info-dialog", () => ({
  default: () => ({ open: vi.fn() }),
}));
vi.mock("photoswipe/lightbox", () => ({
  default: class {
    addFilter() {}
    on() {}
    init() {}
    destroy() {}
  },
}));
vi.mock("photoswipe-video-plugin", () => ({
  default: class {},
}));
vi.mock("@/components/icons", () => ({
  IconSettings: () => null,
  IconArrowDownward: () => null,
  IconArrowUpward: () => null,
  IconClose: () => null,
  IconPlaceItem: () => null,
  IconAttachFile: () => null,
  IconCamera: () => null,
  IconFolder: () => null,
  IconImage: () => null,
  IconSend: () => null,
}));
vi.mock(
  "@/routes/client/[id]/components/client-header",
  () => ({
    ClientHeader: (props: { onBack?: () => void }) => (
      <header>
        Private conversation
        <Show when={props.onBack}>
          <button
            aria-label="conversations.back_to_list"
            onClick={() => props.onBack?.()}
          />
        </Show>
      </header>
    ),
  }),
);
vi.mock("@/routes/client/[id]/components/chat-bar", () => ({
  ChatBar: () => (
    <footer data-testid="private-composer">
      Private composer
    </footer>
  ),
}));
vi.mock("@/routes/client/[id]/components/message", () => ({
  MessageContent: (props: {
    message: StoreMessage;
    onDelete?: () => void;
  }) => (
    <li data-chat-message={props.message.id}>
      {props.message.type === "text"
        ? props.message.data
        : props.message.fileName}
    </li>
  ),
}));

const self = "local";
const directId = directConversationId(self, "alice");
const roomId = roomConversationId("test-service", "team");
const previousDirectId = directConversationId(
  "former-local",
  "alice",
);
const store = createMessageStores({
  load: async () => ({ messages: [], clients: [] }),
  putMessage: async () => {},
  removeMessage: async () => {},
  removeMessages: async () => {},
  putClient: async () => {},
  removeClient: async () => {},
  putConversation: async () => {},
  removeConversation: async () => {},
  putLabel: async () => {},
  removeLabel: async () => {},
});

const roomMessage = (
  id: string,
  text: string,
): TextMessage => ({
  id,
  type: "text",
  client: "alice",
  target: self,
  data: text,
  createdAt: 20,
  conversationId: roomId,
  room: {
    roomId: "team",
    senderName: "Alice",
    senderAvatar: null,
  },
});

const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(
    "[data-conversation-id]",
  ),
];
function renderInRouter(component: () => JSX.Element) {
  return render(() => (
    <MemoryRouter>
      <Route path="/" component={component} />
    </MemoryRouter>
  ));
}

function dropFile(target: Element, file: File) {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: ["Files"],
      files: [file],
      items: [],
      dropEffect: "none",
    },
  });
  target.dispatchEvent(event);
  return event;
}

beforeAll(async () => {
  await store.initialize();
});
beforeEach(async () => {
  sessionStorage.clear();
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", self);
  setAppState("message", "status", "ready");
  setAppState("roomStatus", "roomId", "team");
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "",
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    })),
  );
  service.following = () => true;
  service.sendRoomText.mockReset();
  service.sendRoomText.mockResolvedValue(undefined);
  service.sendRoomFile.mockReset();
  service.sendRoomFile.mockResolvedValue(undefined);
  service.sendFile.mockReset();
  service.sendFile.mockResolvedValue(undefined);
  service.fileCapability = "supported";
  store.setClient({
    clientId: "alice",
    name: "Alice",
    avatar: null,
  });
  store.ensureRoomConversation("team", "test-service");
  await store.addMessage({
    id: "private",
    type: "text",
    client: "alice",
    target: self,
    data: "private contents",
    createdAt: 10,
  });
  await store.putRoomMessage(
    roomMessage("group", "group contents"),
  );
  setAppState("session", "clientViewData", "alice", {
    clientId: "alice",
    name: "Alice",
    avatar: null,
    createdAt: 1,
    onlineStatus: "online",
    messageChannel: true,
  });
  setAppState(
    "session",
    "clientViewData",
    "retired",
    undefined!,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared conversation UI", () => {
  it.each([
    ["direct", "header"],
    ["direct", "messages"],
    ["direct", "composer"],
    ["room", "header"],
    ["room", "messages"],
    ["room", "composer"],
  ] as const)(
    "accepts files from the %s conversation's %s",
    async (kind, area) => {
      const { container } = renderInRouter(() => (
        <ConversationView
          conversationId={
            kind === "room" ? roomId : directId
          }
          embedded
        />
      ));
      const root = container.querySelector(
        kind === "room"
          ? '[data-slot="room-conversation"]'
          : '[data-slot="chat-page"]',
      )!;
      const target =
        area === "header"
          ? root.querySelector("header")!
          : area === "messages"
            ? root.querySelector("[data-chat-message]")!
            : root.querySelector(
                kind === "room" ? "textarea" : "footer",
              )!;
      const textbox =
        kind === "room"
          ? root.querySelector("textarea")!
          : null;
      if (textbox)
        fireEvent.input(textbox, {
          target: { value: "keep draft" },
        });
      const file = new File(["upload"], "drop.txt");
      expect(dropFile(target, file).defaultPrevented).toBe(
        true,
      );
      await waitFor(() => {
        if (kind === "room")
          expect(service.sendRoomFile).toHaveBeenCalledWith(
            file,
          );
        else
          expect(service.sendFile).toHaveBeenCalledWith(
            file,
            "alice",
          );
      });
      expect(
        kind === "room"
          ? service.sendFile
          : service.sendRoomFile,
      ).not.toHaveBeenCalled();
      expect(service.sendRoomText).not.toHaveBeenCalled();
      if (textbox) expect(textbox.value).toBe("keep draft");
    },
  );

  it.each(["direct", "room"] as const)(
    "rejects files in an offline %s conversation without browser navigation",
    (kind) => {
      setAppState(
        "session",
        "clientViewData",
        "alice",
        "messageChannel",
        false,
      );
      const { container } = renderInRouter(() => (
        <ConversationView
          conversationId={
            kind === "room" ? roomId : directId
          }
          embedded
        />
      ));
      const target = container.querySelector("header")!;
      expect(
        dropFile(target, new File(["no"], "blocked.txt"))
          .defaultPrevented,
      ).toBe(true);
      expect(service.sendFile).not.toHaveBeenCalled();
      expect(service.sendRoomFile).not.toHaveBeenCalled();
    },
  );

  it.each(["inactive", "unsupported"])(
    "rejects files when the selected room is %s",
    (reason) => {
      if (reason === "inactive")
        setAppState("roomStatus", "roomId", "other-room");
      else service.fileCapability = "unsupported";
      const { container } = renderInRouter(() => (
        <ConversationView
          conversationId={roomId}
          embedded
        />
      ));
      dropFile(
        container.querySelector("header")!,
        new File(["no"], "blocked.txt"),
      );
      expect(service.sendRoomFile).not.toHaveBeenCalled();
      expect(service.sendFile).not.toHaveBeenCalled();
    },
  );

  it.each(["direct", "room"] as const)(
    "clears an online %s conversation and disables its delete action",
    async (kind) => {
      const id = kind === "room" ? roomId : directId;
      const user = userEvent.setup();
      const { container } = renderInRouter(() => (
        <ConversationSidebar onSelect={() => {}} />
      ));
      const row = rows(container).find(
        (item) => item.dataset.conversationId === id,
      )!;
      await user.click(
        within(row).getByRole("button", {
          name:
            kind === "room"
              ? "conversations.actions:team"
              : "conversations.actions:Alice",
        }),
      );
      expect(
        screen.getByRole("menuitem", {
          name: "conversations.delete",
        }),
      ).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByText(
          "conversations.delete_requires_exit",
        ),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole("menuitem", {
          name: "conversations.clear",
        }),
      );
      await waitFor(() =>
        expect(
          store.getConversationMessages(id),
        ).toHaveLength(0),
      );
      expect(
        rows(container).some(
          (item) => item.dataset.conversationId === id,
        ),
      ).toBe(true);
      expect(
        store.getConversationMessages(
          kind === "room" ? directId : roomId,
        ),
      ).toHaveLength(1);
    },
  );
  it("deletes a selected private conversation while retaining the same peer's earlier identity history", async () => {
    const user = userEvent.setup();
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "onlineStatus",
      "offline",
    );
    await store.addMessage({
      id: "old-private",
      type: "text",
      client: "alice",
      target: "former-local",
      data: "prior identity history",
      createdAt: 1,
    });
    const { container } = renderInRouter(() => (
      <ConversationSidebar onSelect={() => {}} />
    ));
    const currentRow = rows(container).find(
      (row) => row.dataset.conversationId === directId,
    )!;
    await user.click(
      within(currentRow).getByRole("button", {
        name: "conversations.actions:Alice",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", {
        name: "conversations.delete",
      }),
    );
    await waitFor(() =>
      expect(
        rows(container).some(
          (row) => row.dataset.conversationId === directId,
        ),
      ).toBe(false),
    );
    expect(
      rows(container).some(
        (row) =>
          row.dataset.conversationId === previousDirectId,
      ),
    ).toBe(true);
    expect(
      store.getConversationMessages(previousDirectId),
    ).toHaveLength(1);
    expect(
      store.clients.map((client) => client.clientId),
    ).toEqual(["alice"]);
  });
  it("keeps an open row menu and its owner alive when a new message updates summaries", async () => {
    const user = userEvent.setup();
    const work = store.createLabel("Work");
    const { container } = renderInRouter(() => (
      <ConversationSidebar onSelect={() => {}} />
    ));
    const originalRow = rows(container).find(
      (row) => row.dataset.conversationId === directId,
    )!;
    await user.click(
      within(originalRow).getByRole("button", {
        name: "conversations.actions:Alice",
      }),
    );
    await screen.findByRole("menuitemcheckbox", {
      name: "Work",
    });
    await store.addMessage({
      id: "new-private",
      type: "text",
      client: "alice",
      target: self,
      createdAt: 30,
      data: "arrived while the menu is open",
    });
    expect(
      rows(container).find(
        (row) => row.dataset.conversationId === directId,
      ),
    ).toBe(originalRow);
    expect(
      within(originalRow).getByText(
        "arrived while the menu is open",
      ),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("menuitemcheckbox", {
        name: "Work",
      }),
    );
    expect(
      store.conversations.find(
        (conversation) => conversation.id === directId,
      )?.labelIds,
    ).toEqual([work.id]);
    await user.click(
      within(originalRow).getByRole("button", {
        name: "conversations.actions:Alice",
      }),
    );
    expect(document.body.style.pointerEvents).not.toBe(
      "none",
    );
  });

  it("releases the menu when removing its row's currently filtered label", async () => {
    const user = userEvent.setup();
    const work = store.createLabel("Work");
    store.setConversationLabels(directId, [work.id]);
    sessionStorage.setItem(
      "conversation-label-filter",
      JSON.stringify([work.id]),
    );
    const { container } = renderInRouter(() => (
      <ConversationSidebar onSelect={() => {}} />
    ));
    const row = rows(container)[0];
    const menuTrigger = within(row).getByRole("button", {
      name: "conversations.actions:Alice",
    });
    await user.click(menuTrigger);
    await user.click(
      await screen.findByRole("menuitemcheckbox", {
        name: /Work$/,
      }),
    );
    expect(rows(container)).toHaveLength(0);
    await waitFor(() =>
      expect(document.body.style.pointerEvents).not.toBe(
        "none",
      ),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Work",
      }),
    );
    expect(rows(container)).toHaveLength(2);
  });

  it("creates, renames and deletes local labels through the real label editor", async () => {
    const user = userEvent.setup();
    renderInRouter(() => (
      <ConversationSidebar onSelect={() => {}} />
    ));
    await user.click(
      screen.getByRole("button", {
        name: "conversations.manage_labels",
      }),
    );
    const input = await screen.findByRole("textbox", {
      name: "conversations.new_label",
    });
    await user.type(input, "Work");
    await user.click(
      screen.getByRole("button", {
        name: "conversations.add_label",
      }),
    );
    expect(
      appState.message.labels.map((label) => label.name),
    ).toEqual(["Work"]);
    const labelId = appState.message.labels[0].id;
    store.setConversationLabels(roomId, [labelId]);
    const rename = screen.getByRole("textbox", {
      name: "conversations.rename_label:Work",
    });
    await user.clear(rename);
    await user.type(rename, "Project");
    await user.click(
      screen.getByRole("button", {
        name: "conversations.save_label",
      }),
    );
    expect(appState.message.labels[0].name).toBe("Project");
    await user.click(
      screen.getByRole("button", {
        name: "conversations.delete_label:Project",
      }),
    );
    expect(appState.message.labels).toHaveLength(0);
    expect(
      store.conversations.find(
        (conversation) => conversation.id === roomId,
      )?.labelIds,
    ).toEqual([]);
  });

  it("assigns labels from a row menu, combines label and text filters, and groups without duplicating stored conversations", async () => {
    const user = userEvent.setup();
    const work = store.createLabel("Work");
    const project = store.createLabel("Project");
    store.setConversationLabels(directId, [work.id]);
    store.setConversationLabels(roomId, [project.id]);
    const { container } = renderInRouter(() => (
      <ConversationSidebar onSelect={() => {}} />
    ));
    const groupRow = rows(container).find(
      (row) => row.dataset.conversationId === roomId,
    )!;
    await user.click(
      within(groupRow).getByRole("button", {
        name: "conversations.actions:team",
      }),
    );
    const workItem = await screen.findByRole(
      "menuitemcheckbox",
      { name: "Work" },
    );
    await user.click(workItem);
    expect(
      store.conversations.find(
        (conversation) => conversation.id === roomId,
      )?.labelIds,
    ).toEqual([project.id, work.id]);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.body.style.pointerEvents).not.toBe(
        "none",
      ),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Project",
      }),
    );
    expect(
      rows(container).map(
        (row) => row.dataset.conversationId,
      ),
    ).toEqual([roomId]);
    const search = screen.getByRole("textbox", {
      name: "conversations.search",
    });
    await user.type(search, "Alice");
    expect(rows(container)).toHaveLength(0);
    await user.click(
      screen.getByRole("button", {
        name: "Work",
      }),
    );
    expect(
      rows(container).map(
        (row) => row.dataset.conversationId,
      ),
    ).toEqual([directId]);
    await user.clear(search);
    await user.click(
      screen.getByRole("button", {
        name: "conversations.group_by_label",
      }),
    );
    expect(rows(container)).toHaveLength(3);
    expect(appState.message.conversations).toHaveLength(2);
    expect(
      rows(container).filter(
        (row) => row.dataset.conversationId === roomId,
      ),
    ).toHaveLength(2);
  });

  it("preserves saved label filters until asynchronous metadata hydration is ready", async () => {
    sessionStorage.setItem(
      "conversation-label-filter",
      JSON.stringify(["saved"]),
    );
    setAppState("message", "status", "initializing");
    const { container } = renderInRouter(() => (
      <ConversationSidebar onSelect={() => {}} />
    ));
    expect(
      JSON.parse(
        sessionStorage.getItem(
          "conversation-label-filter",
        )!,
      ),
    ).toEqual(["saved"]);
    setAppState(
      "message",
      "labels",
      reconcile([{ id: "saved", name: "Saved" }]),
    );
    store.setConversationLabels(roomId, ["saved"]);
    setAppState("message", "status", "ready");
    await waitFor(() =>
      expect(
        rows(container).map(
          (row) => row.dataset.conversationId,
        ),
      ).toEqual([roomId]),
    );
  });

  it("switches sidebar-selected private and room views without leaking member messages or changing the shell", async () => {
    const back = vi.fn();
    const [selected, select] = createSignal(directId);
    const { container } = renderInRouter(() => (
      <div>
        <p>Meeting shell remains mounted</p>
        <ConversationSidebar
          selectedId={selected()}
          onSelect={select}
        />
        <div data-testid="current-view">
          <ConversationView
            conversationId={selected()}
            embedded
            onBack={back}
          />
        </div>
      </div>
    ));
    const content = screen.getByTestId("current-view");
    fireEvent.click(
      within(content).getByRole("button", {
        name: "conversations.back_to_list",
      }),
    );
    expect(back).toHaveBeenCalledTimes(1);
    expect(
      within(content).getByText("private contents"),
    ).toBeTruthy();
    expect(
      within(content).queryByText("group contents"),
    ).toBeNull();
    const roomRow = rows(container).find(
      (row) => row.dataset.conversationId === roomId,
    )!;
    fireEvent.click(roomRow.querySelector("button")!);
    expect(selected()).toBe(roomId);
    fireEvent.click(
      within(content).getByRole("button", {
        name: "conversations.back_to_list",
      }),
    );
    expect(back).toHaveBeenCalledTimes(2);
    expect(
      within(content).getByText("group contents"),
    ).toBeTruthy();
    expect(
      within(content).queryByText("private contents"),
    ).toBeNull();
    expect(
      screen.getByText("Meeting shell remains mounted"),
    ).toBeTruthy();
    const privateRow = rows(container).find(
      (row) => row.dataset.conversationId === directId,
    )!;
    fireEvent.click(privateRow.querySelector("button")!);
    expect(
      within(content).getByText("private contents"),
    ).toBeTruthy();
    expect(
      within(content).queryByText("group contents"),
    ).toBeNull();
  });

  it("renders the explicitly selected old-identity conversation as history without a live composer", async () => {
    await store.addMessage({
      id: "former-private",
      type: "text",
      client: "alice",
      target: "former-local",
      createdAt: 5,
      data: "previous identity history",
    });
    const { container } = renderInRouter(() => (
      <ConversationView
        conversationId={previousDirectId}
        embedded
      />
    ));
    expect(
      screen.getByText("previous identity history"),
    ).toBeTruthy();
    expect(
      screen.queryByText("private contents"),
    ).toBeNull();
    expect(screen.queryByText("group contents")).toBeNull();
    expect(
      screen.queryByTestId("private-composer"),
    ).toBeNull();
    expect(
      container.querySelectorAll("[data-chat-message]"),
    ).toHaveLength(1);
  });

  it("updates one shared read cursor only when the visible view follows the latest message", async () => {
    const [following, setFollowing] = createSignal(false);
    service.following = following;
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const conversation = () =>
      store.conversations.find(
        (item) => item.id === roomId,
      )!;
    const { container } = renderInRouter(() => (
      <>
        <ConversationSidebar onSelect={() => {}} />
        <ConversationView
          conversationId={roomId}
          embedded
        />
      </>
    ));
    expect(
      conversation().lastReadMessageId,
    ).toBeUndefined();
    setFollowing(true);
    expect(
      conversation().lastReadMessageId,
    ).toBeUndefined();
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() =>
      expect(conversation().lastReadMessageId).toBe(
        "group",
      ),
    );
    const roomRow = rows(container).find(
      (row) => row.dataset.conversationId === roomId,
    )!;
    expect(
      within(roomRow).queryByLabelText(
        "conversations.unread_count",
      ),
    ).toBeNull();
    const privateRow = rows(container).find(
      (row) => row.dataset.conversationId === directId,
    )!;
    expect(
      within(privateRow).getByLabelText(
        "conversations.unread_count",
      ),
    ).toBeTruthy();
  });

  it("keeps the private composer mounted when the peer disconnects or reconnects", () => {
    renderInRouter(() => (
      <ConversationView
        conversationId={directId}
        embedded
      />
    ));
    const composer = screen.getByTestId("private-composer");
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "onlineStatus",
      "offline",
    );
    expect(screen.getByTestId("private-composer")).toBe(
      composer,
    );
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "onlineStatus",
      "online",
    );
    expect(screen.getByTestId("private-composer")).toBe(
      composer,
    );
  });

  it("preserves the room draft and disables the composer until joined and another member is connected", async () => {
    renderInRouter(() => (
      <ConversationView conversationId={roomId} embedded />
    ));
    const textbox = screen.getByRole("textbox", {
      name: "conversations.room_message",
    }) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "  team hello  " },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "conversations.send",
      }),
    );
    await waitFor(() =>
      expect(service.sendRoomText).toHaveBeenCalledWith(
        "team hello",
      ),
    );
    await waitFor(() =>
      expect((textbox as HTMLTextAreaElement).value).toBe(
        "",
      ),
    );
    fireEvent.input(textbox, {
      target: { value: "next room draft" },
    });
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      false,
    );
    expect(textbox.disabled).toBe(true);
    fireEvent.submit(textbox.form!);
    expect(service.sendRoomText).toHaveBeenCalledTimes(1);
    setAppState("roomStatus", "roomId", "elsewhere");
    expect(textbox.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "conversations.send",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "file_library.choose",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("group contents")).toBeTruthy();
    expect(service.sendRoomText).toHaveBeenCalledTimes(1);
    expect(textbox.value).toBe("next room draft");
    setAppState("roomStatus", "roomId", "team");
    expect(textbox.disabled).toBe(true);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      true,
    );
    expect(textbox.disabled).toBe(false);
    expect(textbox.value).toBe("next room draft");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("routes a binary attachment to the room offer API without sending or clearing the text draft", async () => {
    const { container } = renderInRouter(() => (
      <ConversationView conversationId={roomId} embedded />
    ));
    const textbox = screen.getByRole("textbox", {
      name: "conversations.room_message",
    }) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "draft kept while sharing a file" },
    });
    const file = new File(
      [new Uint8Array([0, 255, 7])],
      "payload.bin",
      { type: "application/octet-stream" },
    );
    fireEvent.change(
      container.querySelector(
        'input[data-attachment="file"]',
      )!,
      { target: { files: [file] } },
    );
    await waitFor(() =>
      expect(service.sendRoomFile).toHaveBeenCalledWith(
        file,
      ),
    );
    expect(service.sendRoomText).not.toHaveBeenCalled();
    expect(service.sendFile).not.toHaveBeenCalled();
    expect(textbox.value).toBe(
      "draft kept while sharing a file",
    );
    expect(
      JSON.parse(
        sessionStorage.getItem(
          `conversation-draft:${roomId}`,
        )!,
      ),
    ).toBe(textbox.value);
  });

  it("keeps a failed room text draft and preserves the Enter / Shift+Enter behavior", async () => {
    service.sendRoomText.mockRejectedValueOnce(
      new Error("Room connection lost"),
    );
    renderInRouter(() => (
      <ConversationView conversationId={roomId} embedded />
    ));
    const textbox = screen.getByRole("textbox", {
      name: "conversations.room_message",
    }) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "retry this room draft" },
    });
    fireEvent.keyDown(textbox, {
      key: "Enter",
      shiftKey: true,
    });
    expect(service.sendRoomText).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: "Enter" });
    await waitFor(() =>
      expect(service.sendRoomText).toHaveBeenCalledWith(
        "retry this room draft",
      ),
    );
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "conversations.send",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(textbox.value).toBe("retry this room draft");
    expect(
      JSON.parse(
        sessionStorage.getItem(
          `conversation-draft:${roomId}`,
        )!,
      ),
    ).toBe(textbox.value);
  });
});
