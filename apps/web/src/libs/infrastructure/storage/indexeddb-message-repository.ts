import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";
import type { MessageID } from "@/libs/domain/protocol/messages";
import type {
  MessageRepository,
  MessageRepositorySnapshot,
} from "@/libs/application/messaging/message-repository";
import {
  directConversationId,
  type Conversation,
  type ConversationLabel,
} from "@/libs/domain/conversation";

const DB_NAME = "message_store";
const MESSAGES_STORE = "messages";
const CLIENTS_STORE = "clients";
const CREATED_AT_INDEX = "createdAtIndex";
const CONVERSATIONS_STORE = "conversations";
const LABELS_STORE = "labels";
const CONVERSATION_INDEX = "conversationIdIndex";
const DB_VERSION = 2;

function requestResult<T>(
  request: IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener(
      "complete",
      () => resolve(),
      { once: true },
    );
    transaction.addEventListener(
      "abort",
      () =>
        reject(
          transaction.error ??
            new DOMException(
              "IndexedDB transaction aborted",
              "AbortError",
            ),
        ),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () =>
        reject(
          transaction.error ??
            new Error("IndexedDB transaction failed"),
        ),
      { once: true },
    );
  });
}

function persistentMessage(
  message: StoreMessage,
): StoreMessage {
  if (message.type !== "file") {
    return { ...message };
  }
  const { progress, ...stored } =
    message as FileTransferMessage;
  return stored;
}

export class IndexedDbMessageRepository implements MessageRepository {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private importLegacyClients = false;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          this.importLegacyClients =
            event.oldVersion > 0 &&
            event.oldVersion < DB_VERSION;
          const db = request.result;

          if (
            !db.objectStoreNames.contains(MESSAGES_STORE)
          ) {
            const messages = db.createObjectStore(
              MESSAGES_STORE,
              {
                keyPath: "id",
              },
            );
            messages.createIndex(
              CREATED_AT_INDEX,
              "createdAt",
              {
                unique: false,
              },
            );
          }

          if (
            !db.objectStoreNames.contains(CLIENTS_STORE)
          ) {
            db.createObjectStore(CLIENTS_STORE, {
              keyPath: "clientId",
            });
          }

          if (
            !db.objectStoreNames.contains(
              CONVERSATIONS_STORE,
            )
          ) {
            db.createObjectStore(CONVERSATIONS_STORE, {
              keyPath: "id",
            });
          }
          if (!db.objectStoreNames.contains(LABELS_STORE)) {
            db.createObjectStore(LABELS_STORE, {
              keyPath: "id",
            });
          }
          const messages =
            request.transaction!.objectStore(
              MESSAGES_STORE,
            );
          if (
            !messages.indexNames.contains(
              CONVERSATION_INDEX,
            )
          ) {
            messages.createIndex(
              CONVERSATION_INDEX,
              "conversationId",
              { unique: false },
            );
          }
          // A pair-derived id preserves the original participants even when
          // the browser's current profile has changed since the message.
          let sequence = 0;
          const cursor = messages
            .index(CREATED_AT_INDEX)
            .openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            const message = row.value as StoreMessage;
            row.update({
              ...message,
              localSequence:
                message.localSequence ?? ++sequence,
              conversationId:
                message.conversationId ??
                directConversationId(
                  message.client,
                  message.target,
                ),
            });
            sequence = Math.max(
              sequence,
              message.localSequence ?? sequence,
            );
            row.continue();
          };
        };

        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          this.dbPromise = null;
          reject(request.error);
        };
      },
    );

    return this.dbPromise;
  }

  async load(): Promise<MessageRepositorySnapshot> {
    const db = await this.open();

    const transaction = db.transaction(
      [
        MESSAGES_STORE,
        CLIENTS_STORE,
        CONVERSATIONS_STORE,
        LABELS_STORE,
      ],
      "readonly",
    );
    const done = transactionDone(transaction);
    const [messages, clients, conversations, labels] =
      await Promise.all([
        requestResult(
          transaction
            .objectStore(MESSAGES_STORE)
            .index(CREATED_AT_INDEX)
            .getAll(),
        ),
        requestResult(
          transaction.objectStore(CLIENTS_STORE).getAll(),
        ),
        requestResult(
          transaction
            .objectStore(CONVERSATIONS_STORE)
            .getAll(),
        ),
        requestResult(
          transaction.objectStore(LABELS_STORE).getAll(),
        ),
      ]);
    await done;

    return {
      messages: (messages as StoreMessage[]).sort((a, b) =>
        a.localSequence !== undefined &&
        b.localSequence !== undefined
          ? a.localSequence - b.localSequence
          : a.createdAt - b.createdAt,
      ),
      clients: clients as Client[],
      conversations: conversations as Conversation[],
      labels: labels as ConversationLabel[],
      importLegacyClients: this.importLegacyClients,
    };
  }

  async putMessage(message: StoreMessage): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      MESSAGES_STORE,
      "readwrite",
    );
    transaction
      .objectStore(MESSAGES_STORE)
      .put(persistentMessage(message));
    await transactionDone(transaction);
  }

  async removeMessage(messageId: MessageID): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      MESSAGES_STORE,
      "readwrite",
    );
    transaction
      .objectStore(MESSAGES_STORE)
      .delete(messageId);
    await transactionDone(transaction);
  }

  async removeMessages(
    messageIds: MessageID[],
  ): Promise<void> {
    if (messageIds.length === 0) return;

    const db = await this.open();
    const transaction = db.transaction(
      MESSAGES_STORE,
      "readwrite",
    );
    const store = transaction.objectStore(MESSAGES_STORE);
    for (const id of messageIds) {
      store.delete(id);
    }
    await transactionDone(transaction);
  }

  async putClient(client: Client): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      CLIENTS_STORE,
      "readwrite",
    );
    transaction.objectStore(CLIENTS_STORE).put(client);
    await transactionDone(transaction);
  }

  async removeClient(clientId: ClientID): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      CLIENTS_STORE,
      "readwrite",
    );
    transaction.objectStore(CLIENTS_STORE).delete(clientId);
    await transactionDone(transaction);
  }

  async putConversation(
    conversation: Conversation,
  ): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      CONVERSATIONS_STORE,
      "readwrite",
    );
    transaction
      .objectStore(CONVERSATIONS_STORE)
      .put(conversation);
    await transactionDone(transaction);
    this.importLegacyClients = false;
  }

  async removeConversation(
    conversationId: string,
  ): Promise<void> {
    const db = await this.open();
    // Metadata and its history disappear together even across a tab crash.
    const transaction = db.transaction(
      [CONVERSATIONS_STORE, MESSAGES_STORE],
      "readwrite",
    );
    const done = transactionDone(transaction);
    transaction
      .objectStore(CONVERSATIONS_STORE)
      .delete(conversationId);
    const cursor = transaction
      .objectStore(MESSAGES_STORE)
      .index(CONVERSATION_INDEX)
      .openCursor(IDBKeyRange.only(conversationId));
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      row.delete();
      row.continue();
    };
    await done;
  }

  async putLabel(label: ConversationLabel): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      LABELS_STORE,
      "readwrite",
    );
    transaction.objectStore(LABELS_STORE).put(label);
    await transactionDone(transaction);
  }

  async removeLabel(labelId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(
      [LABELS_STORE, CONVERSATIONS_STORE],
      "readwrite",
    );
    const done = transactionDone(transaction);
    transaction.objectStore(LABELS_STORE).delete(labelId);
    const cursor = transaction
      .objectStore(CONVERSATIONS_STORE)
      .openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      const conversation = row.value as Conversation;
      if (conversation.labelIds.includes(labelId)) {
        row.update({
          ...conversation,
          labelIds: conversation.labelIds.filter(
            (id) => id !== labelId,
          ),
        });
      }
      row.continue();
    };
    await done;
  }

  close(): void {
    void this.dbPromise?.then((db) => db.close());
    this.dbPromise = null;
  }
}
