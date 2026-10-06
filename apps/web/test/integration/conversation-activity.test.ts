// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import { MessageStores } from "@/libs/application/messaging/message-store";
import { createConversationActivity } from "@/libs/state/create-conversation-activity";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { directConversationId } from "@/libs/domain/conversation";
import { createMessageRepository } from "../support/message-repository";

beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
});
afterEach(() => vi.restoreAllMocks());

it("records local send/receive time durably without letting receipts, duplicates or reading change it", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const repo = createMessageRepository();
  const store = new MessageStores(repo);
  const id = directConversationId("local", "peer");
  const sent = {
    id: "outgoing",
    type: "send-text" as const,
    client: "local",
    target: "peer",
    data: "hello",
    createdAt: 1,
  };
  await store.setSendMessage(sent);
  expect(
    repo.records.conversations.get(id)?.updatedAt,
  ).toBe(100);
  now.mockReturnValue(200);
  await store.setReceiveMessage({
    ...sent,
    type: "ack",
    mode: "receive",
    client: "peer",
    target: "local",
  });
  await store.setSendMessage(sent);
  store.markConversationRead(id);
  expect(
    repo.records.conversations.get(id)?.updatedAt,
  ).toBe(100);
  await store.setReceiveMessage({
    ...sent,
    id: "incoming",
    client: "peer",
    target: "local",
    createdAt: 999999,
  });
  expect(
    repo.records.conversations.get(id)?.updatedAt,
  ).toBe(200);
  now.mockReturnValue(300);
  const reloaded = new MessageStores(repo);
  await reloaded.initialize();
  expect(reloaded.conversations[0].updatedAt).toBe(200);
  reloaded.clearConversation(id);
  expect(reloaded.conversations[0].updatedAt).toBe(200);
});

it("records joins and room messages independently of the last joined time", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const store = new MessageStores(
    createMessageRepository(),
  );
  await store.recordRoomJoin("team", "server", null);
  const room = store.conversations[0];
  expect(room).toMatchObject({
    updatedAt: 100,
    lastJoinedAt: 100,
  });
  now.mockReturnValue(200);
  await store.putRoomMessage({
    id: "group",
    type: "text",
    client: "peer",
    target: "local",
    data: "hello",
    createdAt: 1,
    conversationId: room.id,
    room: {
      roomId: "team",
      senderName: "Peer",
      senderAvatar: null,
    },
  });
  expect(room).toMatchObject({
    updatedAt: 200,
    lastJoinedAt: 100,
  });
  now.mockReturnValue(300);
  await store.recordRoomJoin("team", "server", null);
  expect(room).toMatchObject({
    updatedAt: 300,
    lastJoinedAt: 300,
  });
});

it("waits for hydration and records only online transitions, including reconnects", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(100);
  const repo = createMessageRepository();
  const store = new MessageStores(repo);
  const record = vi.spyOn(store, "recordClientOnline");
  const [online, setOnline] = createSignal<string[]>([
    "peer",
  ]);
  const dispose = createRoot((dispose) => {
    createConversationActivity(online, store);
    return dispose;
  });
  try {
    await vi.waitFor(() =>
      expect(store.conversations[0]?.updatedAt).toBe(100),
    );
    now.mockReturnValue(200);
    setOnline(["peer"]);
    await store.setClient({
      clientId: "peer",
      name: "Renamed",
      avatar: null,
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(store.conversations[0].updatedAt).toBe(100);
    setOnline([]);
    expect(store.conversations[0].updatedAt).toBe(100);
    setOnline(["peer"]);
    await vi.waitFor(() =>
      expect(store.conversations[0].updatedAt).toBe(200),
    );
    expect(record).toHaveBeenCalledTimes(2);
    expect(
      repo.records.conversations.get(
        store.conversations[0].id,
      ),
    ).toMatchObject({
      title: "Renamed",
      updatedAt: 200,
    });
  } finally {
    dispose();
  }
  setOnline([]);
  setOnline(["peer"]);
  expect(record).toHaveBeenCalledTimes(2);
});
