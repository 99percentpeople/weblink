// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { MessageStores } from "@/libs/application/messaging/message-store";
import { ConversationHistoryService } from "@/libs/application/messaging/conversation-history-service";
import type {
  MessageRepository,
  MessageRepositorySnapshot,
} from "@/libs/application/messaging/message-repository";
import type { Client } from "@/libs/domain/client";
import type { Conversation } from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function repository() {
  const messages = new Map<string, StoreMessage>();
  const clients = new Map<string, Client>();
  const conversations = new Map<string, Conversation>();
  const repo = {
    load: vi.fn(async () => ({
      messages: [...messages.values()],
      clients: [...clients.values()],
      conversations: [...conversations.values()],
    })),
    putMessage: vi.fn(async (message: StoreMessage) => {
      messages.set(message.id, structuredClone(message));
    }),
    putClient: vi.fn(async (client: Client) => {
      clients.set(client.clientId, { ...client });
    }),
    putConversation: vi.fn(
      async (conversation: Conversation) => {
        conversations.set(
          conversation.id,
          structuredClone(conversation),
        );
      },
    ),
    removeMessage: vi.fn(async (id: string) => {
      messages.delete(id);
    }),
    removeMessages: vi.fn(async (ids: string[]) => {
      ids.forEach((id) => messages.delete(id));
    }),
    removeClient: vi.fn(async (id: string) => {
      clients.delete(id);
    }),
    removeConversation: vi.fn(async (id: string) => {
      conversations.delete(id);
    }),
  } satisfies MessageRepository;
  return { repo, messages, clients };
}

const entries = [
  { key: "intro", text: "Introduction" },
  { key: "connect", text: "Connect to a room" },
  { key: "chat", text: "Open the chat sidebar" },
];

function history(store: MessageStores) {
  return new ConversationHistoryService(
    store,
    () => appState.profile.clientId,
  );
}

function resetState() {
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
}
beforeEach(resetState);
afterEach(() => vi.restoreAllMocks());

describe("conversation history service", () => {
  it("accepts calls during hydration and coalesces concurrent writes to the same batch", async () => {
    const { repo, messages, clients } = repository();
    const snapshot = deferred<MessageRepositorySnapshot>();
    const store = new MessageStores({
      ...repo,
      load: () => snapshot.promise,
    });
    const service = history(store);
    const first = service.cacheLocalTextBatch(
      "intro",
      "guide",
      "Guide",
      entries,
    );
    const second = service.cacheLocalTextBatch(
      "intro",
      "guide",
      "Guide",
      entries,
    );
    expect(repo.putClient).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);

    snapshot.resolve({
      clients: [
        {
          clientId: "friend",
          name: "Friend",
          avatar: null,
        },
      ],
      messages: [
        {
          id: "old",
          type: "text",
          client: "friend",
          target: "local",
          data: "Existing history",
          createdAt: 1,
        },
      ],
      conversations: [],
    });
    await Promise.all([first, second]);

    expect(
      store.conversations.find(
        (item) =>
          item.kind === "direct" && item.peerId === "guide",
      )?.title,
    ).toBe("Guide");
    expect(
      store.messages.map(
        (message) =>
          message.type === "text" && message.data,
      ),
    ).toEqual([
      "Existing history",
      ...entries.map((entry) => entry.text),
    ]);
    expect(messages.size).toBe(4);
    expect(clients.get("guide")?.name).toBe("Guide");
    expect(repo.putClient).toHaveBeenCalledOnce();
    expect(appState.profile.clientId).toBe("local");
  });

  it("resolves only after the name and all messages are persisted", async () => {
    const { repo } = repository();
    const clientSaved = deferred<void>();
    const lastMessageSaved = deferred<void>();
    repo.putClient.mockImplementationOnce(
      () => clientSaved.promise,
    );
    const save = repo.putMessage.getMockImplementation()!;
    repo.putMessage.mockImplementation(async (message) => {
      if (message.id.endsWith(":chat"))
        await lastMessageSaved.promise;
      await save(message);
    });
    const service = history(new MessageStores(repo));
    const completed = vi.fn();
    const pending = service
      .cacheLocalTextBatch(
        "intro",
        "guide",
        "Guide",
        entries,
      )
      .then(completed);
    await waitFor(() =>
      expect(repo.putClient).toHaveBeenCalledOnce(),
    );
    expect(repo.putMessage).not.toHaveBeenCalled();
    clientSaved.resolve();
    await waitFor(() =>
      expect(repo.putMessage).toHaveBeenCalledTimes(3),
    );
    expect(completed).not.toHaveBeenCalled();
    lastMessageSaved.resolve();
    await pending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "recovers a partial write without duplicates (reload: %s)",
    async (reload) => {
      const { repo, messages } = repository();
      const save = repo.putMessage.getMockImplementation()!;
      let fail = true;
      repo.putMessage.mockImplementation(
        async (message) => {
          if (message.id.endsWith(":connect") && fail) {
            fail = false;
            throw new Error("disk full");
          }
          await save(message);
        },
      );
      let store = new MessageStores(repo);
      let service = history(store);
      await expect(
        service.cacheLocalTextBatch(
          "intro",
          "guide",
          "Guide",
          entries,
        ),
      ).rejects.toThrow("disk full");
      expect(messages.size).toBe(1);
      if (reload) {
        resetState();
        store = new MessageStores(repo);
        service = history(store);
      }
      await service.cacheLocalTextBatch(
        "intro",
        "guide",
        "Guide",
        entries,
      );
      expect(store.clients).toHaveLength(1);
      expect(store.conversations).toHaveLength(1);
      expect(store.messages).toHaveLength(3);
      expect(
        new Set(store.messages.map((message) => message.id))
          .size,
      ).toBe(3);
      expect(messages.size).toBe(3);
    },
  );

  it("keeps the same batch keys separate for different conversations", async () => {
    const { repo } = repository();
    const store = new MessageStores(repo);
    const service = history(store);
    await Promise.all([
      service.cacheLocalTextBatch(
        "intro",
        "one",
        "First",
        entries,
      ),
      service.cacheLocalTextBatch(
        "intro",
        "two",
        "Second",
        entries,
      ),
    ]);
    await service.cacheLocalTextBatch(
      "intro",
      "one",
      "First",
      entries,
    );
    expect(store.conversations).toHaveLength(2);
    expect(store.messages).toHaveLength(6);
    expect(
      new Set(store.messages.map((message) => message.id))
        .size,
    ).toBe(6);
  });

  it("propagates a failed name write and allows retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { repo } = repository();
    repo.putClient.mockRejectedValueOnce(
      new Error("name write failed"),
    );
    const store = new MessageStores(repo);
    const service = history(store);
    await expect(
      service.cacheLocalTextBatch(
        "intro",
        "guide",
        "Guide",
        entries,
      ),
    ).rejects.toThrow("name write failed");
    expect(repo.putMessage).not.toHaveBeenCalled();
    await service.cacheLocalTextBatch(
      "intro",
      "guide",
      "Guide",
      entries,
    );
    expect(store.clients).toHaveLength(1);
    expect(store.messages).toHaveLength(3);
  });

  it("reuses messages saved by the earlier unscoped batch implementation", async () => {
    const { repo, messages, clients } = repository();
    const oldId = "intro:local:intro";
    clients.set("guide", {
      clientId: "guide",
      name: "Guide",
      avatar: "https://example.com/avatar.png",
    });
    messages.set(oldId, {
      id: oldId,
      type: "text",
      client: "guide",
      target: "local",
      data: entries[0].text,
      createdAt: 1,
    });
    const store = new MessageStores(repo);
    await history(store).cacheLocalTextBatch(
      "intro",
      "guide",
      "Guide",
      entries,
    );
    expect(store.messages).toHaveLength(3);
    expect(store.messages[0].id).toBe(oldId);
    expect(messages.size).toBe(3);
    expect(store.clients[0].avatar).toBe(
      "https://example.com/avatar.png",
    );
  });
});
