import { IndexedDbMessageRepository } from "../../../src/libs/infrastructure/storage/indexeddb-message-repository";
import { MessageStores } from "../../../src/libs/application/messaging/message-store";
import {
  createInitialAppState,
  setAppState,
} from "../../../src/libs/state/app-state";
import { reconcile } from "solid-js/store";
import { directConversationId } from "../../../src/libs/domain/conversation";
import type { TextMessage } from "../../../src/libs/domain/message";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}

const result = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
const complete = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error);
  });

async function main() {
  await result(indexedDB.deleteDatabase("message_store"));
  const open = indexedDB.open("message_store", 1);
  open.onupgradeneeded = () => {
    const messages = open.result.createObjectStore(
      "messages",
      { keyPath: "id" },
    );
    messages.createIndex("createdAtIndex", "createdAt");
    open.result.createObjectStore("clients", {
      keyPath: "clientId",
    });
  };
  const legacyDb = await result(open);
  const legacy = legacyDb.transaction(
    ["messages", "clients"],
    "readwrite",
  );
  const legacyDone = complete(legacy);
  legacy
    .objectStore("clients")
    .put({ clientId: "peer", name: "Peer", avatar: null });
  legacy.objectStore("messages").put({
    id: "old-text",
    type: "text",
    data: "retained text",
    client: "peer",
    target: "local",
    createdAt: 1,
  });
  legacy.objectStore("messages").put({
    id: "old-file",
    type: "file",
    client: "local",
    target: "peer",
    createdAt: 2,
    fid: "file",
    fileName: "kept.txt",
    fileSize: 10,
    chunkSize: 4,
    transferStatus: "complete",
  });
  await legacyDone;
  legacyDb.close();

  let repository = new IndexedDbMessageRepository();
  const snapshot = await repository.load();
  const directId = directConversationId("local", "peer");
  assert(
    snapshot.messages.length === 2,
    "legacy messages were lost",
  );
  assert(
    snapshot.messages.every(
      (message) => message.conversationId === directId,
    ),
    "upgrade did not assign direct conversation ids",
  );
  assert(
    snapshot.messages[1].type === "file" &&
      snapshot.messages[1].fileName === "kept.txt",
    "file metadata changed during migration",
  );
  const upgraded = await result(
    indexedDB.open("message_store"),
  );
  assert(
    upgraded.version === 2,
    "database version is not 2",
  );
  assert(
    upgraded.objectStoreNames.contains("conversations") &&
      upgraded.objectStoreNames.contains("labels"),
    "new stores missing",
  );
  assert(
    upgraded
      .transaction("messages")
      .objectStore("messages")
      .indexNames.contains("conversationIdIndex"),
    "conversation index missing",
  );
  upgraded.close();

  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
  const store = new MessageStores(repository);
  await store.initialize();
  assert(
    store.conversations.length === 1,
    "legacy private history created duplicate conversations",
  );
  assert(
    store.getConversationMessages(directId).length === 2,
    "legacy private history not queryable",
  );
  const room = store.ensureRoomConversation(
    "meeting",
    "test-service",
  );
  const group: TextMessage = {
    id: "group-message",
    type: "text",
    client: "peer",
    target: "local",
    createdAt: 3,
    data: "hello room",
    conversationId: room.id,
    room: {
      roomId: "meeting",
      senderName: "Peer",
      senderAvatar: null,
    },
  };
  await store.putRoomMessage(group);
  await Promise.all([
    store.setRoomDelivery(group.id, "first", "delivered"),
    store.setRoomDelivery(group.id, "second", "failed"),
    store.setRoomDelivery(
      group.id,
      "interrupted",
      "sending",
    ),
  ]);
  const label = store.createLabel("Work");
  store.setConversationLabels(room.id, [label.id]);
  store.markConversationRead(room.id);
  // A queued readonly transaction observes all preceding metadata writes.
  let persisted = await repository.load();
  const storedRoom = persisted.conversations?.find(
    (conversation) => conversation.id === room.id,
  );
  assert(
    storedRoom?.labelIds[0] === label.id &&
      storedRoom.lastReadMessageId === group.id,
    "label or read position was not persisted",
  );
  assert(
    persisted.labels?.[0].name === "Work",
    "label metadata missing",
  );
  repository.close();

  repository = new IndexedDbMessageRepository();
  persisted = await repository.load();
  const persistedGroup = persisted.messages.find(
    (message) => message.id === group.id,
  ) as TextMessage;
  assert(
    persistedGroup.deliveries?.first === "delivered" &&
      persistedGroup.deliveries.second === "failed",
    "recipient outcomes lost on reopen",
  );
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
  const reloadedStore = new MessageStores(repository);
  await reloadedStore.initialize();
  const recoveredGroup = reloadedStore.messages.find(
    (message) => message.id === group.id,
  ) as TextMessage;
  assert(
    recoveredGroup.deliveries?.interrupted === "failed",
    "interrupted send did not become retryable",
  );
  const recoveredSnapshot = await repository.load();
  assert(
    (
      recoveredSnapshot.messages.find(
        (message) => message.id === group.id,
      ) as TextMessage
    ).deliveries?.interrupted === "failed",
    "interrupted delivery recovery was not persisted",
  );
  await reloadedStore.putRoomMessage(group);
  assert(
    reloadedStore.messages.filter(
      (message) => message.id === group.id,
    ).length === 1,
    "duplicate after reload was appended",
  );
  reloadedStore.deleteClient("peer");
  persisted = await repository.load();
  assert(
    persisted.messages.length === 1 &&
      persisted.messages[0].id === group.id,
    "deleting a peer removed room history",
  );
  await repository.removeLabel(label.id);
  persisted = await repository.load();
  assert(
    persisted.labels?.length === 0 &&
      persisted.conversations?.every(
        (conversation) =>
          !conversation.labelIds.includes(label.id),
      ),
    "deleted label remains assigned",
  );
  await repository.removeConversation(room.id);
  persisted = await repository.load();
  assert(
    persisted.messages.length === 0 &&
      persisted.conversations?.length === 0,
    "room removal was not complete",
  );
  repository.close();
  await result(indexedDB.deleteDatabase("message_store"));

  const fresh = new IndexedDbMessageRepository();
  const freshSnapshot = await fresh.load();
  assert(
    freshSnapshot.messages.length === 0 &&
      freshSnapshot.conversations?.length === 0,
    "fresh v2 initialization failed",
  );
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
  const orderedStore = new MessageStores(fresh);
  await orderedStore.initialize();
  await orderedStore.addMessage({
    id: "arrived-first",
    type: "text",
    client: "peer",
    target: "local",
    data: "future sender clock",
    createdAt: 900000,
  });
  await orderedStore.addMessage({
    id: "arrived-second",
    type: "text",
    client: "peer",
    target: "local",
    data: "past sender clock",
    createdAt: 1,
  });
  orderedStore.markConversationRead(directId);
  const orderedSnapshot = await fresh.load();
  assert(
    orderedSnapshot.messages
      .map((message) => message.id)
      .join(",") === "arrived-first,arrived-second",
    "remote timestamps reordered local history",
  );
  assert(
    orderedSnapshot.conversations?.find(
      (conversation) => conversation.id === directId,
    )?.lastReadSequence === 2,
    "local read cursor was not persisted",
  );
  fresh.close();
  const reopened = new IndexedDbMessageRepository();
  const reopenedSnapshot = await reopened.load();
  assert(
    reopenedSnapshot.messages
      .map((message) => message.id)
      .join(",") === "arrived-first,arrived-second",
    "reopening changed local arrival order",
  );
  reopened.close();
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    storage: "real Chromium IndexedDB",
    passed: [
      "v1 to v2 migration",
      "legacy text and file metadata",
      "conversation index",
      "legacy conversation hydration",
      "labels and read position",
      "recipient delivery persistence",
      "interrupted delivery recovery",
      "duplicate after reopen",
      "private deletion preserves group history",
      "atomic label assignment cleanup",
      "atomic conversation deletion",
      "fresh v2 database",
      "local arrival and reading order across reload",
    ],
  };
}

main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
