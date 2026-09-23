// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { createComputed, createRoot } from "solid-js";
import { MessageStores } from "@/libs/application/messaging/message-store";
import type { MessageRepository } from "@/libs/application/messaging/message-repository";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import {
  directConversationId,
  roomConversationId,
  type Conversation,
} from "@/libs/domain/conversation";
import type { TextMessage } from "@/libs/domain/message";

function repository(
  overrides: Partial<MessageRepository> = {},
): MessageRepository {
  return {
    load: async () => ({ messages: [], clients: [] }),
    putMessage: vi.fn(async () => {}),
    removeMessage: vi.fn(async () => {}),
    removeMessages: vi.fn(async () => {}),
    putClient: vi.fn(async () => {}),
    removeClient: vi.fn(async () => {}),
    putConversation: vi.fn(async () => {}),
    removeConversation: vi.fn(async () => {}),
    putLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    ...overrides,
  };
}

const direct: TextMessage = {
  id: "direct-message",
  client: "peer",
  target: "local",
  type: "text",
  data: "private",
  createdAt: 1,
};

function roomMessage(
  id = "room-message",
  roomId = "room",
): TextMessage {
  return {
    id,
    client: "peer",
    target: "local",
    type: "text",
    data: "group",
    createdAt: 2,
    conversationId: roomConversationId(
      "test-server",
      roomId,
    ),
    room: {
      roomId,
      senderName: "Peer",
      senderAvatar: null,
    },
  };
}

beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
});

describe("conversation storage", () => {
  it("persists silent room membership with private conversations and does not recreate deleted conversations", async () => {
    const saved = new Map<string, Conversation>();
    const peer = {
      clientId: "peer",
      name: "Peer",
      avatar: null,
    };
    const repo = repository({
      load: async () => ({
        messages: [],
        clients: [peer],
        conversations: [...saved.values()].map((item) =>
          structuredClone(item),
        ),
      }),
      putConversation: vi.fn(async (item) => {
        saved.set(item.id, structuredClone(item));
      }),
      removeConversation: vi.fn(async (id) => {
        saved.delete(id);
      }),
    });
    const store = new MessageStores(repo);
    await store.initialize();
    store.setClient(peer);
    const roomA = roomConversationId(
      "server-a",
      "same-name",
    );
    const roomB = roomConversationId(
      "server-b",
      "same-name",
    );
    store.recordRoomMember(roomA, peer.clientId);
    store.recordRoomMember(roomA, peer.clientId);
    store.recordRoomMember(roomB, peer.clientId);
    store.setClient({ ...peer, name: "Renamed peer" });
    const id = directConversationId("local", "peer");
    expect(saved.get(id)).toMatchObject({
      roomConversationIds: [roomA, roomB],
      title: "Renamed peer",
    });
    expect(store.messages).toHaveLength(0);

    setAppState(reconcile(createInitialAppState()));
    setAppState("profile", "clientId", "local");
    const reloaded = new MessageStores(repo);
    await reloaded.initialize();
    expect(
      reloaded.conversations.find((item) => item.id === id),
    ).toMatchObject({
      roomConversationIds: [roomA, roomB],
    });
    reloaded.deleteConversation(id);
    reloaded.recordRoomMember(roomA, peer.clientId);
    expect(reloaded.conversations).toHaveLength(0);
    expect(saved.has(id)).toBe(false);
  });

  it("imports legacy private messages without changing the stable message array or mixing rooms", async () => {
    const repo = repository({
      load: async () => ({
        messages: [
          direct,
          {
            ...direct,
            id: "sent",
            client: "local",
            target: "peer",
          },
        ],
        clients: [
          { clientId: "peer", name: "Peer", avatar: null },
        ],
      }),
    });
    const store = new MessageStores(repo);
    const messages = store.messages;
    const conversations = store.conversations;
    await store.initialize();
    const id = directConversationId("local", "peer");
    expect(store.messages).toBe(messages);
    expect(appState.message.messages).toBe(messages);
    expect(appState.message.conversations).toBe(
      conversations,
    );
    expect(store.conversations).toHaveLength(1);
    expect(store.conversations[0]).toMatchObject({
      id,
      kind: "direct",
      peerId: "peer",
      title: "Peer",
    });
    expect(store.getConversationMessages(id)).toHaveLength(
      2,
    );
    expect(repo.putMessage).toHaveBeenCalledTimes(2);
    expect(directConversationId("a:b", "c")).not.toBe(
      directConversationId("a", "b:c"),
    );
    expect(roomConversationId("one", "room")).not.toBe(
      roomConversationId("two", "room"),
    );
  });

  it("deleting a peer keeps their room messages and deleting a room keeps other histories", async () => {
    const repo = repository();
    const store = new MessageStores(repo);
    await store.initialize();
    store.setClient({
      clientId: "peer",
      name: "Peer",
      avatar: null,
    });
    await store.addMessage(direct);
    const room = store.ensureRoomConversation(
      "room",
      "test-server",
    );
    const other = store.ensureRoomConversation(
      "other",
      "test-server",
    );
    await store.putRoomMessage(roomMessage());
    await store.putRoomMessage(
      roomMessage("other-message", "other"),
    );
    const messages = store.messages;
    store.deleteClient("peer");
    expect(
      store.getConversationMessages(room.id),
    ).toHaveLength(1);
    expect(
      store.getConversationMessages(other.id),
    ).toHaveLength(1);
    expect(
      store.conversations.every(
        (conversation) => conversation.kind === "room",
      ),
    ).toBe(true);
    store.deleteConversation(room.id);
    expect(appState.message.messages).toBe(messages);
    expect(
      store.messages.map((message) => message.id),
    ).toEqual(["other-message"]);
  });

  it("shares labels and reading position by conversation, removing labels from every assignment", async () => {
    const repo = repository();
    const store = new MessageStores(repo);
    await store.initialize();
    const room = store.ensureRoomConversation(
      "room",
      "test-server",
    );
    const label = store.createLabel(" Work ");
    expect(store.createLabel("work").id).toBe(label.id);
    store.setConversationLabels(room.id, [
      label.id,
      label.id,
      "missing",
    ]);
    expect(room.labelIds).toEqual([label.id]);
    store.renameLabel(label.id, "Project");
    expect(store.labels[0].name).toBe("Project");
    await store.putRoomMessage(roomMessage());
    store.markConversationRead(room.id);
    expect(room.lastReadMessageId).toBe("room-message");
    expect(room.lastReadAt).toBeTypeOf("number");
    expect(repo.putConversation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lastReadMessageId: "room-message",
      }),
    );
    store.deleteLabel(label.id);
    expect(store.labels).toHaveLength(0);
    expect(room.labelIds).toEqual([]);
    expect(repo.removeLabel).toHaveBeenCalledWith(label.id);
  });

  it("does not acknowledge or remember a room message when persistence fails, then accepts a retry", async () => {
    const putMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("quota"))
      .mockResolvedValue(undefined);
    const store = new MessageStores(
      repository({ putMessage }),
    );
    await store.initialize();
    store.ensureRoomConversation("room", "test-server");
    await expect(
      store.putRoomMessage(roomMessage()),
    ).rejects.toThrow("quota");
    expect(store.messages).toHaveLength(0);
    await store.putRoomMessage(roomMessage());
    await store.putRoomMessage(roomMessage());
    expect(store.messages).toHaveLength(1);
    expect(putMessage).toHaveBeenCalledTimes(2);
  });

  it("merges concurrent duplicate arrivals but rejects conflicting sender, scope, timestamp or content", async () => {
    let finish!: () => void;
    const putMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const store = new MessageStores(
      repository({ putMessage }),
    );
    await store.initialize();
    store.ensureRoomConversation("room", "test-server");
    store.ensureRoomConversation("other", "test-server");
    const first = store.putRoomMessage(roomMessage());
    const duplicate = store.putRoomMessage(roomMessage());
    await vi.waitFor(() =>
      expect(putMessage).toHaveBeenCalledTimes(1),
    );
    await expect(
      store.putRoomMessage({
        ...roomMessage(),
        client: "intruder",
      }),
    ).rejects.toThrow("Conflicting");
    finish();
    await Promise.all([first, duplicate]);
    expect(store.messages).toHaveLength(1);
    for (const changed of [
      { ...roomMessage(), data: "altered" },
      { ...roomMessage(), createdAt: 5 },
      roomMessage("room-message", "other"),
    ])
      await expect(
        store.putRoomMessage(changed),
      ).rejects.toThrow("Conflicting");
  });

  it("serializes recipient receipts without losing another peer's outcome", async () => {
    const repo = repository();
    const store = new MessageStores(repo);
    await store.initialize();
    store.ensureRoomConversation("room", "test-server");
    await store.putRoomMessage(roomMessage());
    await Promise.all([
      store.setRoomDelivery(
        "room-message",
        "a",
        "delivered",
      ),
      store.setRoomDelivery("room-message", "b", "failed"),
    ]);
    expect(
      (store.messages[0] as TextMessage).deliveries,
    ).toEqual({ a: "delivered", b: "failed" });
    expect(repo.putMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveries: { a: "delivered", b: "failed" },
      }),
    );
  });

  it("retains durable duplicate identity after hydration", async () => {
    const room = {
      id: roomConversationId("test-server", "room"),
      kind: "room" as const,
      roomId: "room",
      namespace: "test-server",
      title: "room",
      labelIds: [],
      createdAt: 1,
    };
    const putMessage = vi.fn(async () => {});
    const store = new MessageStores(
      repository({
        load: async () => ({
          messages: [roomMessage()],
          clients: [],
          conversations: [room],
        }),
        putMessage,
      }),
    );
    await store.initialize();
    await store.putRoomMessage(roomMessage());
    expect(putMessage).toHaveBeenCalledTimes(1);
    expect(putMessage).toHaveBeenCalledWith(
      expect.objectContaining({ localSequence: 1 }),
    );
    expect(store.messages).toHaveLength(1);
  });

  it("does not resurrect a room deleted while its message is being persisted", async () => {
    let finish!: () => void;
    const putMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const repo = repository({ putMessage });
    const store = new MessageStores(repo);
    await store.initialize();
    const room = store.ensureRoomConversation(
      "room",
      "test-server",
    );
    const pending = store.putRoomMessage(roomMessage());
    await vi.waitFor(() =>
      expect(putMessage).toHaveBeenCalledTimes(1),
    );
    store.deleteConversation(room.id);
    finish();
    await expect(pending).rejects.toThrow("deleted");
    expect(store.messages).toHaveLength(0);
    expect(repo.removeMessage).toHaveBeenCalledWith(
      "room-message",
    );
  });

  it("can remove migrated private history even when contact metadata is missing", async () => {
    const store = new MessageStores(
      repository({
        load: async () => ({
          messages: [direct],
          clients: [],
        }),
      }),
    );
    await store.initialize();
    store.deleteClient("peer");
    expect(store.messages).toHaveLength(0);
    expect(store.conversations).toHaveLength(0);
  });

  it("turns interrupted room deliveries into retryable failures during hydration and persists them", async () => {
    const message: TextMessage = {
      ...roomMessage(),
      deliveries: {
        waiting: "sending",
        success: "delivered",
        error: "failed",
        old: "unsupported",
      },
    };
    const conversation = {
      id: roomConversationId("test-server", "room"),
      kind: "room" as const,
      roomId: "room",
      namespace: "test-server",
      title: "room",
      labelIds: [],
      createdAt: 1,
    };
    const repo = repository({
      load: async () => ({
        messages: [message],
        clients: [],
        conversations: [conversation],
      }),
    });
    const store = new MessageStores(repo);
    await store.initialize();
    const expected = {
      waiting: "failed",
      success: "delivered",
      error: "failed",
      old: "unsupported",
    };
    expect(
      (store.messages[0] as TextMessage).deliveries,
    ).toEqual(expected);
    expect(repo.putMessage).toHaveBeenCalledWith(
      expect.objectContaining({ deliveries: expected }),
    );
    expect(store.status()).toBe("ready");
  });

  it("keeps arrival order through concurrent persistence and clock-skewed hydration", async () => {
    const pending = new Map<string, () => void>();
    const saved = new Map<string, TextMessage>();
    const repo = repository({
      putMessage: vi.fn(
        (message) =>
          new Promise<void>((resolve) => {
            saved.set(
              message.id,
              structuredClone(message) as TextMessage,
            );
            pending.set(message.id, resolve);
          }),
      ),
    });
    const store = new MessageStores(repo);
    await store.initialize();
    const conversation = store.ensureRoomConversation(
      "room",
      "test-server",
    );
    const first = store.putRoomMessage({
      ...roomMessage("first"),
      createdAt: 9000,
    });
    const second = store.putRoomMessage({
      ...roomMessage("second"),
      createdAt: 1,
    });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get("second")!();
    await second;
    pending.get("first")!();
    await first;
    expect(
      store.messages.map((message) => message.id),
    ).toEqual(["first", "second"]);
    store.markConversationRead(conversation.id);
    expect(conversation.lastReadMessageId).toBe("second");
    expect(conversation.lastReadSequence).toBe(2);
    const reloaded = new MessageStores(
      repository({
        load: async () => ({
          messages: [
            saved.get("second")!,
            saved.get("first")!,
          ],
          clients: [],
          conversations: [
            { ...conversation, labelIds: [] },
          ],
        }),
      }),
    );
    await reloaded.initialize();
    expect(
      reloaded.messages.map((message) => message.id),
    ).toEqual(["first", "second"]);
    expect(reloaded.conversations[0].lastReadSequence).toBe(
      2,
    );
  });

  it("never reuses a deleted reading cursor's local sequence after a reload", async () => {
    const conversation = {
      id: roomConversationId("test-server", "room"),
      kind: "room" as const,
      roomId: "room",
      namespace: "test-server",
      title: "room",
      labelIds: [],
      createdAt: 1,
      lastReadMessageId: "deleted",
      lastReadSequence: 100,
    };
    const store = new MessageStores(
      repository({
        load: async () => ({
          messages: [],
          clients: [],
          conversations: [conversation],
        }),
      }),
    );
    await store.initialize();
    await store.putRoomMessage(roomMessage());
    expect(store.messages[0].localSequence).toBe(101);
  });

  it("deletes only the selected private identity and does not revive deleted v2 conversations from contacts", async () => {
    const store = new MessageStores(repository());
    await store.initialize();
    store.setClient({
      clientId: "peer",
      name: "Peer",
      avatar: null,
    });
    await store.addMessage(direct);
    await store.addMessage({
      ...direct,
      id: "old-identity",
      target: "former-local",
    });
    store.deleteConversation(
      directConversationId("local", "peer"),
    );
    expect(
      store.messages.map((message) => message.id),
    ).toEqual(["old-identity"]);
    expect(store.clients).toHaveLength(1);
    const contacts = store.clients.map((client) => ({
      ...client,
    }));
    const historicalMessages = store.messages.map(
      (message) => ({ ...message }),
    );
    const savedConversations = store.conversations.map(
      (conversation) => ({
        ...conversation,
        labelIds: [...conversation.labelIds],
      }),
    );
    const reloaded = new MessageStores(
      repository({
        load: async () => ({
          messages: historicalMessages,
          clients: contacts,
          conversations: savedConversations,
        }),
      }),
    );
    await reloaded.initialize();
    expect(
      reloaded.conversations.map(
        (conversation) => conversation.id,
      ),
    ).toEqual([
      directConversationId("former-local", "peer"),
    ]);
    reloaded.deleteConversation(
      directConversationId("former-local", "peer"),
    );
    const empty = new MessageStores(
      repository({
        load: async () => ({
          messages: [],
          clients: contacts,
          conversations: [],
        }),
      }),
    );
    await empty.initialize();
    expect(empty.conversations).toHaveLength(0);
    expect(empty.clients).toHaveLength(1);
  });

  it("queues active room deletion before a reactive observer recreates its metadata", async () => {
    const operations: string[] = [];
    const store = new MessageStores(
      repository({
        putConversation: async () => {
          operations.push("put");
        },
        removeConversation: async () => {
          operations.push("remove");
        },
      }),
    );
    await store.initialize();
    const id = roomConversationId("test-server", "room");
    const dispose = createRoot((dispose) => {
      createComputed(() => {
        if (
          !store.conversations.some(
            (conversation) => conversation.id === id,
          )
        )
          store.ensureRoomConversation(
            "room",
            "test-server",
          );
      });
      return dispose;
    });
    operations.length = 0;
    try {
      store.deleteConversation(id);
      expect(operations).toEqual(["remove", "put"]);
      expect(
        store.conversations.some(
          (conversation) => conversation.id === id,
        ),
      ).toBe(true);
    } finally {
      dispose();
    }
  });
});
