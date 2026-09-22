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

const DB_NAME = "message_store";
const MESSAGES_STORE = "messages";
const CLIENTS_STORE = "clients";
const CREATED_AT_INDEX = "createdAtIndex";

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

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(DB_NAME);

        request.onupgradeneeded = () => {
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
        };

        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      },
    );

    return this.dbPromise;
  }

  async load(): Promise<MessageRepositorySnapshot> {
    const db = await this.open();

    const messageTx = db.transaction(
      MESSAGES_STORE,
      "readonly",
    );
    const messageDone = transactionDone(messageTx);
    const messages = await requestResult(
      messageTx
        .objectStore(MESSAGES_STORE)
        .index(CREATED_AT_INDEX)
        .getAll(),
    );
    await messageDone;

    const clientTx = db.transaction(
      CLIENTS_STORE,
      "readonly",
    );
    const clientDone = transactionDone(clientTx);
    const clients = await requestResult(
      clientTx.objectStore(CLIENTS_STORE).getAll(),
    );
    await clientDone;

    return {
      messages: messages as StoreMessage[],
      clients: clients as Client[],
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

  close(): void {
    void this.dbPromise?.then((db) => db.close());
    this.dbPromise = null;
  }
}
