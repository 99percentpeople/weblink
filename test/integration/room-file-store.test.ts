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
import { snapshotStoreMessage } from "@/libs/application/messaging/message-snapshot";
import { summarizeConversations } from "@/libs/application/messaging/conversation-query";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { roomConversationId } from "@/libs/domain/conversation";
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";
import { createSessionMessage } from "@/libs/domain/protocol/messages";

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
    ...overrides,
  };
}
const offer = (): FileTransferMessage => ({
  id: "offer",
  type: "file",
  client: "peer",
  target: "local",
  createdAt: 10,
  conversationId: roomConversationId("server", "room"),
  room: {
    roomId: "room",
    senderName: "Peer",
    senderAvatar: null,
  },
  fid: "file",
  fileName: "report.pdf",
  fileSize: 8192,
  chunkSize: 4096,
  mimeType: "application/pdf",
  lastModified: 5,
});
async function setup(repo = repository()) {
  const store = new MessageStores(repo);
  await store.initialize();
  const room = store.ensureRoomConversation(
    "room",
    "server",
  );
  return { store, repo, room };
}
beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
});

describe("room file persistence", () => {
  it("persists one metadata-only offer, deduplicates it and summarizes the filename", async () => {
    const { store, repo, room } = await setup();
    const inserted = await Promise.all([
      store.putRoomMessage(offer()),
      store.putRoomMessage(offer()),
    ]);
    expect(inserted).toEqual([true, false]);
    expect(await store.putRoomMessage(offer())).toBe(false);
    expect(store.messages).toHaveLength(1);
    expect(repo.putMessage).toHaveBeenCalledTimes(1);
    expect(store.messages[0]).not.toHaveProperty(
      "transferStatus",
    );
    expect(
      summarizeConversations(
        store.conversations,
        [],
        store.messages,
        "local",
        new Set(),
        room.id,
      )[0],
    ).toMatchObject({ preview: "report.pdf", unread: 1 });
  });

  it.each([
    { fid: "another" },
    { fileName: "different.pdf" },
    { fileSize: 4 },
    { chunkSize: 2 },
    { mimeType: "text/plain" },
    { lastModified: 15 },
    { client: "other" },
    { createdAt: 11 },
    { type: "text", data: "reused" },
  ])(
    "rejects the same offer id with changed immutable data %j",
    async (patch) => {
      const { store } = await setup();
      await store.putRoomMessage(offer());
      await expect(
        store.putRoomMessage({
          ...offer(),
          ...patch,
        } as StoreMessage),
      ).rejects.toThrow("Conflicting");
      expect(store.messages[0]).toMatchObject({
        fileName: "report.pdf",
        fid: "file",
      });
    },
  );

  it("rejects an offer missing a file identity", async () => {
    const { store } = await setup();
    await expect(
      store.putRoomMessage({ ...offer(), fid: undefined }),
    ).rejects.toThrow();
  });

  it("detaches room profiles, receipts and nested per-peer progress from mutable callers", async () => {
    const { store } = await setup();
    const original = {
      ...offer(),
      deliveries: { a: "sending" as const },
      roomTransfers: {
        a: {
          status: "transfering" as const,
          progress: { total: 10, received: 2 },
        },
      },
    };
    const snapshot = snapshotStoreMessage(
      original,
    ) as FileTransferMessage;
    await store.putRoomMessage(original);
    original.room!.senderName = "Changed";
    original.roomTransfers.a.progress.received = 9;
    original.deliveries.a = "failed" as never;
    expect(
      snapshot.roomTransfers!.a.progress!.received,
    ).toBe(2);
    expect(store.messages[0]).toMatchObject({
      room: { senderName: "Peer" },
      deliveries: { a: "sending" },
      roomTransfers: { a: { progress: { received: 2 } } },
    });
  });

  it("keeps room files isolated from private ACK/error/retry and contact deletion", async () => {
    const { store, room } = await setup();
    await store.putRoomMessage(offer());
    const peer = {
      clientId: "peer",
      targetClientId: "local",
    };
    store.setReceiveMessage(
      createSessionMessage(
        peer,
        "ack",
        { mode: "receive" },
        { id: "offer" },
      ),
    );
    store.setReceiveMessage(
      createSessionMessage(
        peer,
        "error",
        { error: "wrong scope" },
        { id: "offer" },
      ),
    );
    store.retrySendMessage(
      createSessionMessage(
        peer,
        "send-file",
        {
          fid: "other",
          fileName: "private",
          fileSize: 1,
          chunkSize: 1,
        },
        { id: "offer" },
      ),
    );
    expect(store.messages[0]).toMatchObject({
      fileName: "report.pdf",
      fid: "file",
    });
    expect(store.messages[0].status).toBeUndefined();
    store.deleteClient("peer");
    expect(
      store.getConversationMessages(room.id),
    ).toHaveLength(1);
    store.deleteConversation(room.id);
    expect(store.messages).toHaveLength(0);
  });

  it("restores interrupted receipts and per-peer transfers without starting an unclaimed offer", async () => {
    const room = {
      id: roomConversationId("server", "room"),
      kind: "room" as const,
      roomId: "room",
      namespace: "server",
      title: "room",
      createdAt: 1,
      labelIds: [],
    };
    const repo = repository({
      load: async () => ({
        messages: [
          {
            ...offer(),
            deliveries: { a: "sending" },
            roomTransfers: {
              a: {
                status: "transfering",
                progress: { total: 8192, received: 12 },
              },
              b: { status: "complete" },
            },
          },
        ],
        clients: [],
        conversations: [room],
      }),
    });
    const store = new MessageStores(repo);
    await store.initialize();
    expect(store.conversations).toHaveLength(1);
    expect(store.messages[0]).toMatchObject({
      deliveries: { a: "failed" },
      roomTransfers: {
        a: { status: "paused" },
        b: { status: "complete" },
      },
    });
    expect(
      (store.messages[0] as FileTransferMessage)
        .transferStatus,
    ).toBeUndefined();
    expect(repo.putMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveries: { a: "failed" },
        roomTransfers: {
          a: expect.objectContaining({ status: "paused" }),
          b: { status: "complete", progress: undefined },
        },
      }),
    );
  });

  it("serializes receipt writes with concurrent per-peer progress without overwriting either", async () => {
    const { store, repo } = await setup();
    await store.putRoomMessage(offer());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = vi.mocked(repo.putMessage);
    write.mockClear();
    write.mockImplementationOnce(() => gate);
    const delivery = store.setRoomDelivery(
      "offer",
      "a",
      "delivered",
    );
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledTimes(1),
    );
    store.updateTransferMessage("offer", (message) => {
      message.roomTransfers = {
        a: {
          status: "transfering",
          progress: { total: 8192, received: 4096 },
        },
        b: { status: "complete" },
      };
    });
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await delivery;
    await store.setRoomDelivery("offer", "b", "delivered");
    expect(store.messages[0]).toMatchObject({
      deliveries: { a: "delivered", b: "delivered" },
      roomTransfers: {
        a: { progress: { received: 4096 } },
        b: { status: "complete" },
      },
    });
    expect(write).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveries: { a: "delivered", b: "delivered" },
        roomTransfers: {
          a: expect.objectContaining({
            progress: { total: 8192, received: 4096 },
          }),
          b: expect.objectContaining({
            status: "complete",
          }),
        },
      }),
    );
  });
});
