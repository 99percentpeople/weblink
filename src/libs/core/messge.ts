import {
  createStore,
  produce,
  reconcile,
  SetStoreFunction,
} from "solid-js/store";
import { ChunkRange } from "../utils/range";
import { ClientID, FileID, Client } from "./type";
import {
  FileTransmitter,
  ProgressValue,
  TransferMode,
} from "./file-transmitter";
import { ChunkCache } from "../cache/chunk-cache";
import { makePersisted } from "@solid-primitives/storage";
import { isServer } from "solid-js/web";
import { v4 } from "uuid";
import { batch } from "solid-js";

export type MessageID = string;

export interface BaseExchangeMessage {
  type: string;
  createdAt: number;
  client: ClientID;
  target: ClientID;
}

export interface BaseStorageMessage
  extends BaseExchangeMessage {
  id: string;
}

export interface TextMessage extends BaseStorageMessage {
  type: "text";
  data: string;
}

export interface FileTransferMessage
  extends BaseStorageMessage {
  type: "file";
  fid: FileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
  error?: Error;
  progress?: {
    total: number;
    received: number;
  };
  status?:
    | "pause"
    | "processing"
    | "complete"
    | "merging"
    | "ready"
    | "error";
}

export type StoreMessage =
  | TextMessage
  | FileTransferMessage;

export interface SendTextMessage
  extends BaseExchangeMessage {
  type: "send-text";
  data: string;
}

export interface ReadyMessage {}

export interface RequestFileMessage
  extends BaseExchangeMessage {
  type: "request-file";
  fid: FileID;
  ranges: ChunkRange[];
}
export interface SendFileMessage
  extends BaseExchangeMessage {
  type: "send-file";
  fid: FileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
}

export type SessionMessage =
  | SendTextMessage
  | RequestFileMessage
  | SendFileMessage;

class MessageStores {
  readonly messages: StoreMessage[];
  readonly clients: Client[];
  readonly db: Promise<IDBDatabase> | IDBDatabase;
  private setMessages: SetStoreFunction<StoreMessage[]>;
  private setClients: SetStoreFunction<Client[]>;

  private controllers: Record<FileID, AbortController> = {};
  constructor() {
    const [messages, setMessages] = createStore<
      StoreMessage[]
    >([]);
    this.messages = messages;
    this.setMessages = setMessages;

    const [clients, setClients] = createStore<Client[]>([]);
    this.clients = clients;
    this.setClients = setClients;

    this.db = this.initDB();
  }

  private async initDB() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("message_store");

      request.onupgradeneeded = () => {
        const db = request.result;
        const messageStore = db.createObjectStore(
          "messages",
          {
            keyPath: "id",
          },
        );

        messageStore.createIndex(
          "createdAtIndex",
          "createdAt",
          {
            unique: false,
          },
        );

        const clientStore = db.createObjectStore(
          "clients",
          {
            keyPath: "clientId",
          },
        );
      };

      request.onsuccess = async () => {
        const db = request.result;
        resolve(db);
        this.loadDB();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  private async loadDB() {
    const db = await this.db;
    const index = db
      .transaction("messages", "readonly")
      .objectStore("messages")
      .index("createdAtIndex");

    new Promise<StoreMessage[]>((resolve, reject) => {
      const request = index.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).then((messages) => {
      this.setMessages(
        reconcile(
          messages.map((message) => {
            if (message.type === "file") {
              if (message.status !== "complete") {
                message.status === "pause";
              }
            }
            return message;
          }),
        ),
      );
    });

    const clientStore = db
      .transaction("clients", "readonly")
      .objectStore("clients");

    new Promise<Client[]>((resolve, reject) => {
      const request = clientStore.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).then((clients) => {
      this.setClients(reconcile(clients));
    });
  }

  private async setMessageDB(message: StoreMessage) {
    const db = await this.db;
    message.type;
    let request: IDBRequest<IDBValidKey>;
    if (message.type === "text") {
      request = db
        .transaction("messages", "readwrite")
        .objectStore("messages")
        .put({
          ...message,
        });
    } else if (message.type === "file") {
      request = db
        .transaction("messages", "readwrite")
        .objectStore("messages")
        .put({
          ...message,
          progress: undefined,
        });
    }

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async removeMessageDB(messageId: MessageID) {
    const db = await this.db;
    const request = db
      .transaction("messages", "readwrite")
      .objectStore("messages")
      .delete(messageId);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async removeMessagesDB(messageIds: MessageID[]) {
    const db = await this.db;
    const transaction = db.transaction(
      "messages",
      "readwrite",
    );

    const store = transaction.objectStore("messages");

    for (const id of messageIds) {
      store.delete(id);
    }

    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private async setClientDB(client: Client) {
    const db = await this.db;
    const request = db
      .transaction("clients", "readwrite")
      .objectStore("clients")
      .put(client);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private async removeClientDB(clientId: ClientID) {
    const db = await this.db;
    const request = db
      .transaction("clients", "readwrite")
      .objectStore("clients")
      .delete(clientId);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private getMessageSetter(index: number) {
    if (this.messages[index]) {
      return (cb: (state: FileTransferMessage) => void) => {
        this.setMessages(
          index,
          produce((state) => {
            cb(state as FileTransferMessage);
            this.setMessageDB(state);
          }),
        );
      };
    }
    return null;
  }

  private getController(fileId: FileID) {
    let controller = this.controllers[fileId];
    if (controller) return controller;

    controller = new AbortController();
    controller.signal.addEventListener(
      "abort",
      () => {
        delete this.controllers[fileId];
      },
      { once: true },
    );
    this.controllers[fileId] = controller;
    return controller;
  }

  setMessage(sessionMsg: SessionMessage): number | null {
    let index: number = -1;
    if (sessionMsg.type === "send-text") {
      this.setMessages(
        produce((state) => {
          const message = {
            ...sessionMsg,
            id: v4(),
            type: "text",
          } satisfies TextMessage;
          index = state.push(message);

          this.setMessageDB(message);
        }),
      );
    } else {
      index = this.messages.findIndex(
        (msg) =>
          msg.type === "file" && msg.fid === sessionMsg.fid,
      );
      if (sessionMsg.type === "send-file") {
        if (index !== -1) {
          console.warn(
            `file message ${sessionMsg.fid} already exist`,
          );
          return index;
        }
        this.setMessages(
          produce((state) => {
            const message = {
              ...sessionMsg,
              id: v4(),
              type: "file",
            } satisfies FileTransferMessage;
            index = state.push(message);
            this.setMessageDB(message);
          }),
        );
      } else if (sessionMsg.type === "request-file") {
        if (index === -1) {
          console.warn(
            `can not request file ${sessionMsg.fid}, message not exist`,
          );
          return null;
        }
      }
    }
    return index;
  }

  setClient(client: Client) {
    const index = this.clients.findIndex(
      (c) => c.clientId === client.clientId,
    );
    if (index !== -1) {
      this.setClients(index, client);
    } else {
      this.setClients(
        produce((state) => state.push(client)),
      );
    }
    this.setClientDB(client);
  }

  deleteClient(clientId: ClientID) {
    const index = this.clients.findIndex(
      (client) => client.clientId === clientId,
    );
    if (index !== -1) {
      this.setClients(
        produce((state) => state.splice(index, 1)),
      );
      this.removeClientDB(clientId);
      this.deleteMessagesByClient(clientId);
    }
  }

  deleteMessagesByClient(clientId: ClientID) {
    const messageDeletes = this.messages.filter(
      (message) => {
        return (
          message.client === clientId ||
          message.target === clientId
        );
      },
    );

    this.removeMessagesDB(
      messageDeletes.map((message) => message.id),
    );
    this.setMessages((state) =>
      state.filter(
        (message) =>
          message.client !== clientId &&
          message.target !== clientId,
      ),
    );
  }

  addCache(cache: ChunkCache) {
    const controller = this.getController(cache.id);
    const index = this.messages.findIndex(
      (msg) => msg.type === "file" && msg.fid === cache.id,
    );
    if (index === -1) {
      return false;
    }
    const setter = this.getMessageSetter(index)!;
    cache.addEventListener(
      "merging",
      () => {
        setter((state) => (state.status = "merging"));
      },
      { once: true, signal: controller.signal },
    );

    cache.addEventListener(
      "merged",
      () => {
        setter((state) => {
          state.status = "complete";
          controller.abort("complete");
        });
      },
      { once: true, signal: controller.signal },
    );
    return true;
  }

  deleteMessage(message: MessageID) {
    const index = this.messages.findIndex(
      (msg) => msg.id === message,
    );
    if (index !== -1) {
      this.setMessages(
        produce((state) => state.splice(index, 1)),
      );
      this.removeMessageDB(message);
    }
  }

  addTransfer(transferer: FileTransmitter): boolean {
    if (this.controllers[transferer.id] !== undefined) {
      console.warn(
        `transferer ${transferer.id} has been added`,
      );
    }
    const index = this.messages.findIndex(
      (msg) =>
        msg.type === "file" && msg.fid === transferer.id,
    );
    if (index === -1) {
      return false;
    }

    const controller = this.getController(transferer.id);

    const setter = this.getMessageSetter(index)!;

    if (transferer.mode === TransferMode.Receive) {
      this.addCache(transferer.cache);
    }

    transferer.addEventListener(
      "ready",
      () => {
        setter((state) => {
          state.error = undefined;
          state.status = "ready";
        });
      },
      {
        once: true,
        signal: controller.signal,
      },
    );
    transferer.addEventListener(
      "progress",
      (event: CustomEvent<ProgressValue>) => {
        const { total, received } = event.detail;
        setter((state) => {
          state.progress = {
            total: total,
            received: received,
          };
          state.status = "processing";
        });
      },
      {
        signal: controller.signal,
      },
    );
    transferer.addEventListener(
      "complete",
      () => {
        if (transferer.mode === TransferMode.Send) {
          controller.abort();
          setter((state) => {
            state.status = "complete";
          });
        }
      },
      {
        once: true,
        signal: controller.signal,
      },
    );

    transferer.addEventListener(
      "error",
      (event: CustomEvent<Error>) => {
        console.error(event.detail);
        controller.abort();
        setter((state) => {
          state.status = "error";
          state.error = event.detail;
        });
      },
      {
        once: true,
        signal: controller.signal,
      },
    );

    return true;
  }
}

export const messageStores = new MessageStores();
