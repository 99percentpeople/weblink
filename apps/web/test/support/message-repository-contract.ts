import { createStore } from "solid-js/store";
import type { MessageRepository } from "@/libs/application/messaging/message-repository";
import type { Conversation } from "@/libs/domain/conversation";
import type { FileTransferMessage } from "@/libs/domain/message";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}

/** Runs unchanged against the memory fixture and Chromium's real IndexedDB. */
export async function checkMessageRepository(
  repository: MessageRepository,
) {
  const [conversation, setConversation] = createStore<
    Extract<Conversation, { kind: "direct" }>
  >({
    id: "contract-conversation",
    kind: "direct",
    peerId: "peer",
    title: "Original",
    createdAt: 1,
    labelIds: ["contract-label"],
    roomConversationIds: ["room"],
  });
  const [message, setMessage] =
    createStore<FileTransferMessage>({
      id: "contract-message",
      conversationId: conversation.id,
      type: "file",
      client: "local",
      target: "peer",
      createdAt: 1,
      fid: "file",
      fileName: "contract.txt",
      fileSize: 4,
      chunkSize: 2,
      fingerprint: {
        version: 1,
        algorithm: "blake3-256",
        digest: "a".repeat(64),
        size: 4,
      },
      room: {
        roomId: "room",
        senderName: "Original",
        senderAvatar: null,
      },
      deliveries: { peer: "delivered" },
      roomTransfers: {
        peer: {
          status: "complete",
          progress: { total: 4, received: 4 },
        },
      },
      progress: { total: 4, received: 4 },
      localContentPending: true,
      localContentDetached: true,
    });
  const [client, setClient] = createStore({
    clientId: "peer",
    name: "Original",
    avatar: null,
  });
  const [label, setLabel] = createStore({
    id: "contract-label",
    name: "Original",
  });

  // In particular, this starts writes while IndexedDB is still opening. A copy
  // taken after the first await would silently persist the changed values.
  const pending = Promise.all([
    repository.putConversation!(conversation),
    repository.putMessage(message),
    repository.putClient(client),
    repository.putLabel!(label),
  ]);
  setConversation("labelIds", []);
  setConversation("roomConversationIds", ["changed"]);
  setMessage("fingerprint", "digest", "b".repeat(64));
  setMessage("room", "senderName", "Changed");
  setMessage("deliveries", "peer", "failed");
  setMessage(
    "roomTransfers",
    "peer",
    "progress",
    "received",
    0,
  );
  setClient("name", "Changed");
  setLabel("name", "Changed");
  await pending;
  const snapshot = await repository.load();
  const saved = snapshot.messages.find(
    (item) => item.id === message.id,
  );
  const savedConversation = snapshot.conversations?.find(
    (item) => item.id === conversation.id,
  );
  assert(saved?.type === "file", "file record missing");
  assert(
    savedConversation?.kind === "direct",
    "conversation record missing",
  );
  assert(
    savedConversation.labelIds[0] === label.id &&
      savedConversation.roomConversationIds?.[0] === "room",
    "conversation retained live arrays",
  );
  assert(
    saved.fingerprint?.digest === "a".repeat(64) &&
      saved.room?.senderName === "Original",
    "message retained live metadata",
  );
  assert(
    saved.deliveries?.peer === "delivered" &&
      saved.roomTransfers?.peer.progress?.received === 4,
    "message retained live delivery data",
  );
  assert(
    !("progress" in saved) &&
      !("localContentPending" in saved) &&
      !("localContentDetached" in saved),
    "transient file state was persisted",
  );
  assert(
    snapshot.clients.find(
      (item) => item.clientId === "peer",
    )?.name === "Original" &&
      snapshot.labels?.find((item) => item.id === label.id)
        ?.name === "Original",
    "client or label was captured after yielding",
  );
  savedConversation.labelIds.push("mutated-read");
  saved.fingerprint.digest = "read-mutated";
  const reloaded = await repository.load();
  const file = reloaded.messages.find(
    (item) => item.id === message.id,
  );
  assert(
    file?.type === "file" &&
      file.fingerprint?.digest === "a".repeat(64),
    "load exposed stored message references",
  );
  assert(
    reloaded.conversations?.find(
      (item) => item.id === conversation.id,
    )?.labelIds.length === 1,
    "load exposed stored conversation references",
  );
  await repository.removeConversation!(conversation.id);
  await repository.removeLabel!(label.id);
  await repository.removeClient(client.clientId);
  const cleared = await repository.load();
  assert(
    !cleared.messages.some(
      (item) => item.id === message.id,
    ),
    "conversation deletion retained its messages",
  );
}
