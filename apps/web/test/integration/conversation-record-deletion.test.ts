// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { MessageStores } from "@/libs/application/messaging/message-store";
import {
  roomConversationId,
  type RoomConversation,
} from "@/libs/domain/conversation";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { deleteConversationRecord } from "@/libs/state/delete-conversation-record";
import {
  setClientConfig,
  setRoomConfig,
} from "@/libs/state/permission-options";
import { createMessageRepository } from "../support/message-repository";

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
  getRoomNamespace: () => "server-a",
}));

beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", {
    clientId: "local",
    roomId: "meeting",
    password: "profile-password",
  });
});

it.each(["server-a", "server-b"])(
  "deletes all records for a room on %s while preserving other rooms and client permissions",
  async (namespace) => {
    const rooms: RoomConversation[] = [
      "server-a",
      "server-b",
    ].map((namespace) => ({
      id: roomConversationId(namespace, "meeting"),
      kind: "room",
      namespace,
      roomId: "meeting",
      title: "Meeting",
      createdAt: 1,
      labelIds: [],
      lastJoinedAt: 2,
      joinPassword: "saved-password",
    }));
    const repo = createMessageRepository(
      {},
      {
        clients: [],
        conversations: rooms,
        messages: rooms.map((room) => ({
          id: room.namespace,
          conversationId: room.id,
          client: "peer",
          target: "local",
          type: "text",
          data: "Saved chat",
          createdAt: 3,
          room: {
            roomId: room.roomId,
            senderName: "Peer",
            senderAvatar: null,
          },
        })),
      },
    );
    const store = new MessageStores(repo);
    fixture.store = store;
    await store.initialize();
    for (const room of rooms)
      setRoomConfig(room.id, { autoDownloadFiles: true });
    setClientConfig("peer", { remoteControl: "allow" });
    const deleted = rooms.find(
      (room) => room.namespace === namespace,
    )!;
    const kept = rooms.find(
      (room) => room.namespace !== namespace,
    )!;

    deleteConversationRecord(deleted.id);
    deleteConversationRecord(deleted.id);

    expect(
      appState.options.roomConfigs[deleted.id],
    ).toBeUndefined();
    expect(
      appState.options.roomConfigs[kept.id]
        ?.autoDownloadFiles,
    ).toBe(true);
    expect(
      appState.options.clientConfigs.peer?.remoteControl,
    ).toBe("allow");
    expect(appState.profile.roomId).toBe(
      namespace === "server-a" ? "" : "meeting",
    );
    expect(appState.profile.password).toBe(
      namespace === "server-a" ? null : "profile-password",
    );
    expect(repo.records.conversations.has(deleted.id)).toBe(
      false,
    );
    expect(repo.records.messages.has(namespace)).toBe(
      false,
    );
    const reloaded = new MessageStores(repo);
    await reloaded.initialize();
    expect(reloaded.conversations).toEqual([kept]);
    expect(
      reloaded.messages.map((message) => message.id),
    ).toEqual([kept.namespace]);
  },
);

it("keeps client permissions when a private conversation is deleted", async () => {
  const repo = createMessageRepository();
  const store = new MessageStores(repo);
  fixture.store = store;
  await store.initialize();
  const conversation =
    store.ensureDirectConversation("peer");
  setClientConfig("peer", { remoteControl: "allow" });
  deleteConversationRecord(conversation.id);
  expect(
    repo.records.conversations.has(conversation.id),
  ).toBe(false);
  expect(
    appState.options.clientConfigs.peer?.remoteControl,
  ).toBe("allow");
  expect(appState.profile.password).toBe(
    "profile-password",
  );
});
