// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { MessageStores } from "@/libs/application/messaging/message-store";
import type { MessageRepository } from "@/libs/application/messaging/message-repository";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { createSessionMessage } from "@/libs/domain/protocol/messages";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function createRepository(
  overrides: Partial<MessageRepository> = {},
): MessageRepository {
  return {
    load: async () => ({ messages: [], clients: [] }),
    putMessage: async () => {},
    removeMessage: async () => {},
    removeMessages: async () => {},
    putClient: async () => {},
    removeClient: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  setAppState("message", "messages", reconcile([]));
  setAppState("message", "clients", reconcile([]));
  setAppState("message", "status", "initializing");
});

describe("MessageStores persistence boundary", () => {
  it("publishes ready only after the repository snapshot is loaded", async () => {
    const snapshot =
      deferred<
        Awaited<ReturnType<MessageRepository["load"]>>
      >();
    const store = new MessageStores(
      createRepository({
        load: () => snapshot.promise,
      }),
    );

    const initialization = store.initialize();

    expect(appState.message.status).toBe("initializing");
    expect(appState.message.messages).toHaveLength(0);

    snapshot.resolve({
      messages: [
        {
          id: "file-message",
          type: "file",
          status: "received",
          client: "a",
          target: "b",
          createdAt: 1,
          fid: "file-1",
          fileName: "a.txt",
          fileSize: 10,
          chunkSize: 4,
          transferStatus: "transfering",
        },
      ],
      clients: [
        {
          clientId: "b",
          name: "Peer",
          avatar: null,
        },
      ],
    });

    await initialization;

    expect(appState.message.status).toBe("ready");
    expect(appState.message.messages[0]).toMatchObject({
      id: "file-message",
      transferStatus: "paused",
    });
    expect(appState.message.clients[0]).toMatchObject({
      clientId: "b",
      name: "Peer",
    });
  });

  it("delegates send-state persistence without creating a second timeout", async () => {
    vi.useFakeTimers();
    try {
      const putMessage = vi.fn(async () => {});
      const store = new MessageStores(
        createRepository({ putMessage }),
      );

      store.setSendMessage(
        createSessionMessage(
          { clientId: "a", targetClientId: "b" },
          "send-text",
          { data: "hello" },
          { id: "m1", createdAt: 1 },
        ),
      );

      expect(appState.message.messages[0]).toMatchObject({
        id: "m1",
        type: "text",
        status: "sending",
        data: "hello",
      });
      expect(putMessage).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
