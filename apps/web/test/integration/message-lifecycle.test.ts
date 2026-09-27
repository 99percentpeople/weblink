// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { MessageStores } from "@/libs/application/messaging/message-store";
import { PeerMessagingService } from "@/libs/application/messaging/peer-messaging-service";
import { ConversationMessagingService } from "@/libs/application/messaging/conversation-messaging-service";
import type { MessageRepository } from "@/libs/application/messaging/message-repository";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { directConversationId } from "@/libs/domain/conversation";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import type { StoreMessage } from "@/libs/domain/message";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
  makeSession,
} from "../support/rtc-transport";

const protocols: P2PProtocol<
  ReturnType<typeof makeSession>
>[] = [];
const local = () =>
  Object.assign(makeSession("local", "peer"), {
    isMessageChannelReady: true,
  });
const wire = (id = "message", data = "hello") =>
  createSessionMessage(
    makeSession("peer", "local"),
    "send-text",
    { data },
    { id, createdAt: 1 },
  );
function repository(
  overrides: Partial<MessageRepository> = {},
): MessageRepository {
  return {
    load: async () => ({
      messages: [],
      clients: [],
      conversations: [],
    }),
    putMessage: vi.fn(async () => {}),
    putConversation: vi.fn(async () => {}),
    removeMessage: vi.fn(async () => {}),
    removeMessages: async () => {},
    putClient: async () => {},
    removeClient: async () => {},
    ...overrides,
  };
}
async function setup(
  overrides: Partial<MessageRepository> = {},
) {
  const repo = repository(overrides);
  const store = new MessageStores(repo);
  await store.initialize();
  const conversation =
    store.ensureDirectConversation("peer");
  const transport = new FakeRtcTransport();
  const protocol = new P2PProtocol(transport);
  protocols.push(protocol);
  const service = new PeerMessagingService(protocol, store);
  const session = local();
  const messaging = new ConversationMessagingService({
    getConversation: (id) =>
      store.conversations.find((item) => item.id === id),
    getMessage: (id) =>
      store.messages.find((message) => message.id === id),
    getLocalClientId: () => "local",
    getSession: () => session,
    getActiveRoomId: () => null,
    peers: service,
    rooms: {
      retry: vi.fn(async () => {}),
      currentScopeKey: "scope",
      send: vi.fn(async () => {}),
    },
    files: {
      retryFile: vi.fn(async () => {}),
      sendFile: vi.fn(async () => {}),
    },
    roomFiles: { sendFile: vi.fn(async () => {}) },
  });
  return {
    repo,
    store,
    conversation,
    transport,
    protocol,
    service,
    session,
    messaging,
  };
}
beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
});
afterEach(() => {
  protocols
    .splice(0)
    .forEach((protocol) => protocol.dispose());
  vi.restoreAllMocks();
});

describe("shared durable message lifecycle", () => {
  it.each(["direct", "room"] as const)(
    "publishes %s only after durable insertion, merges duplicates and rejects conflicting content",
    async (kind) => {
      const write = deferred<void>();
      const { store, repo } = await setup({
        putMessage: () => write.promise,
      });
      const room = store.ensureRoomConversation(
        "room",
        "server",
      );
      const put = (data = "hello") =>
        kind === "direct"
          ? store.setReceiveMessage(wire("message", data))
          : store.putRoomMessage({
              ...wire("message", data),
              type: "text",
              conversationId: room.id,
              room: {
                roomId: "room",
                senderName: "Peer",
                senderAvatar: null,
              },
            });
      const first = put();
      const duplicate = put();
      await flushRtc();
      expect(store.messages).toHaveLength(0);
      await expect(put("conflict")).rejects.toThrow(
        "Conflicting",
      );
      write.resolve();
      await Promise.all([first, duplicate]);
      expect(store.messages).toHaveLength(1);
      await expect(put("conflict")).rejects.toThrow(
        "Conflicting",
      );
      expect(repo.putConversation).toHaveBeenCalled();
    },
  );

  it("rejects a private submission before transmission if local insertion fails", async () => {
    const f = await setup({
      putMessage: async () => {
        throw new Error("quota");
      },
    });
    await expect(
      f.messaging.sendText(f.conversation.id, "hello"),
    ).rejects.toThrow();
    expect(f.transport.sendCalls).toHaveLength(0);
    expect(f.store.messages).toHaveLength(0);
  });

  it("ACKs private reception only after saving and permits a retry after storage failure", async () => {
    const write = deferred<void>();
    const putMessage = vi
      .fn()
      .mockImplementationOnce(() => write.promise)
      .mockResolvedValue(undefined);
    const f = await setup({ putMessage });
    const receiving = f.transport.emit(f.session, wire());
    await flushRtc();
    expect(f.transport.sendCalls).toHaveLength(0);
    write.reject(new Error("quota"));
    await receiving;
    expect(
      f.transport.sendCalls.map(
        (call) => call.message.type,
      ),
    ).toEqual(["error"]);
    expect(f.store.messages).toHaveLength(0);
    await f.transport.emit(f.session, wire());
    expect(
      f.transport.sendCalls.map(
        (call) => call.message.type,
      ),
    ).toEqual(["error", "ack"]);
    expect(f.store.messages).toHaveLength(1);
  });

  it("separates local acceptance from receipt and retries the same message after disconnect", async () => {
    const f = await setup();
    const accepted = await f.messaging.sendText(
      f.conversation.id,
      "hello",
    );
    await flushRtc();
    expect(f.store.messages[0].status).toBe("sending");
    f.transport.close(f.session);
    expect((await accepted.completion).error).toBeDefined();
    expect(f.store.messages[0].status).toBe("error");
    const message = f.store.messages[0];
    const reconnected = local();
    f.transport.sendImpl = async (session, outgoing) => {
      await f.transport.emit(
        session,
        createSessionMessage(
          makeSession("peer", "local"),
          "ack",
          { mode: "receive" },
          { id: outgoing.id },
        ),
      );
    };
    await f.service.send(
      reconnected,
      "send-text",
      { data: "hello" },
      {
        id: message.id,
        createdAt: message.createdAt,
        retry: true,
        throwOnError: true,
      },
    );
    expect(f.store.messages).toHaveLength(1);
    expect(f.store.messages[0]).toMatchObject({
      id: accepted.messageId,
      status: "received",
      deliveries: { peer: "delivered" },
    });
  });

  it("retires a send when its channel closes during durable insertion", async () => {
    const write = deferred<void>();
    const putMessage = vi
      .fn()
      .mockImplementationOnce(() => write.promise)
      .mockResolvedValue(undefined);
    const f = await setup({ putMessage });
    const submitting = f.messaging.sendText(
      f.conversation.id,
      "hello",
    );
    await flushRtc();
    f.transport.close(f.session);
    write.resolve();
    const accepted = await submitting;
    expect((await accepted.completion).error).toBeDefined();
    expect(f.store.messages[0]).toMatchObject({
      status: "error",
      deliveries: { peer: "failed" },
    });
    expect(f.transport.sendCalls).toHaveLength(0);
  });

  it("rejects conflicting cached text requests instead of replaying a success ACK", async () => {
    const f = await setup();
    await f.transport.emit(f.session, wire());
    await f.transport.emit(
      f.session,
      wire("message", "changed"),
    );
    expect(
      f.transport.sendCalls.map(
        (call) => call.message.type,
      ),
    ).toEqual(["ack", "error"]);
    expect(f.store.messages[0]).toMatchObject({
      data: "hello",
    });
  });

  it("recovers both legacy and recipient-based private sends after a reload", async () => {
    const id = directConversationId("local", "peer");
    const original: StoreMessage = {
      id: "legacy",
      type: "text",
      data: "hello",
      client: "local",
      target: "peer",
      createdAt: 1,
      conversationId: id,
      status: "sending",
    };
    const f = await setup({
      load: async () => ({
        messages: [
          original,
          {
            ...original,
            id: "new",
            deliveries: { peer: "sending" },
          },
        ],
        clients: [],
        conversations: [
          {
            id,
            kind: "direct",
            peerId: "peer",
            title: "Peer",
            labelIds: [],
            createdAt: 1,
          },
        ],
      }),
    });
    expect(
      f.store.messages.map((message) => message.status),
    ).toEqual(["error", "error"]);
    expect(f.store.messages[1].deliveries).toEqual({
      peer: "failed",
    });
    expect(f.repo.putMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "legacy",
        status: "error",
      }),
    );
  });
});
