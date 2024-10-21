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
import { v4 } from "uuid";
import { PeerSession } from "./session";
import { Accessor, createSignal, Setter } from "solid-js";

export type MessageID = string;

export interface BaseExchangeMessage {
  id: MessageID;
  type: string;
  createdAt: number;
  client: ClientID;
  target: ClientID;
  status?: "sending" | "received" | "error";
}

export interface BaseStorageMessage
  extends BaseExchangeMessage {
  id: string;
}

export interface TextMessage extends BaseStorageMessage {
  type: "text";
  data: string;
  error?: string;
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
  error?: string;
  progress?: {
    total: number;
    received: number;
  };
  transferStatus?:
    | "processing"
    | "complete"
    | "merging"
    | "ready"
    | "error";
}

export type StoreMessage =
  | TextMessage
  | FileTransferMessage;

export type SendTextMessage = BaseExchangeMessage & {
  type: "send-text";
  data: string;
};

export type CheckMessage = BaseExchangeMessage & {
  type: "check-message";
  id: MessageID;
};

export type ReadTextMessage = BaseExchangeMessage & {
  type: "read-text";
  id: MessageID;
};

export type RequestFileMessage = BaseExchangeMessage & {
  type: "request-file";
  fid: FileID;
  ranges: ChunkRange[];
};

export type SendFileMessage = BaseExchangeMessage & {
  type: "send-file";
  fid: FileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
};

export type SessionMessage =
  | SendTextMessage
  | CheckMessage
  | ReadTextMessage
  | RequestFileMessage
  | SendFileMessage;

class MessageStores {
  readonly messages: StoreMessage[];
  readonly clients: Client[];
  readonly db: Promise<IDBDatabase> | IDBDatabase;
  private setMessages: SetStoreFunction<StoreMessage[]>;
  private setClients: SetStoreFunction<Client[]>;
  status: Accessor<"initializing" | "ready">;
  private setStatus: Setter<"initializing" | "ready">;
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
    const [status, setStatus] = createSignal<
      "initializing" | "ready"
    >("initializing");
    this.status = status;
    this.setStatus = setStatus;
  }

  private timeouts: Record<MessageID, number> = {};

  private clearTimeout(id: MessageID) {
    window.clearTimeout(this.timeouts[id]);
    delete this.timeouts[id];
  }

  private setTimeout(
    id: MessageID,
    timeout: number,
    callback: () => void,
  ) {
    this.timeouts[id] = window.setTimeout(() => {
      this.clearTimeout(id);
      callback();
    }, timeout);
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

        db.createObjectStore("clients", {
          keyPath: "clientId",
        });
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

    const promise1 = new Promise<StoreMessage[]>(
      (resolve, reject) => {
        const request = index.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    ).then((messages) => {
      this.setMessages(
        reconcile(
          messages.map((message) => {
            if (message.type === "file") {
              if (message.transferStatus !== "complete") {
                message.transferStatus = "ready";
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

    const promise2 = new Promise<Client[]>(
      (resolve, reject) => {
        const request = clientStore.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    ).then((clients) => {
      this.setClients(reconcile(clients));
    });

    return Promise.all([promise1, promise2]).then(() => {
      this.setStatus("ready");
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
      const { progress, ...storeMessage } = message;

      request = db
        .transaction("messages", "readwrite")
        .objectStore("messages")
        .put(storeMessage);
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

  async setMessage(
    sessionMsg: SessionMessage,
    session: PeerSession,
  ) {
    let index: number = -1;
    const isSending =
      session.clientId === sessionMsg.client;
    const setStatus = (message: StoreMessage) => {
      if (!isSending) {
        session.sendMessage({
          type: "check-message",
          id: message.id,
          createdAt: Date.now(),
          client: sessionMsg.target,
          target: sessionMsg.client,
        } satisfies CheckMessage);
        this.setMessages(index, "error", undefined);
      } else {
        if (message.status === "received") return;

        this.setTimeout(message.id, 3000, () => {
          this.setMessages(index, "status", "error");
          this.setMessages(index, "status", "error");
          this.setMessages(index, "error", "send timeout");
          this.setMessageDB(this.messages[index]);
        });
      }
    };
    if (sessionMsg.type === "send-text") {
      index = this.messages.findIndex(
        (msg) => msg.id === sessionMsg.id,
      );
      if (index === -1) {
        const message = {
          ...sessionMsg,
          type: "text",
          status: isSending ? "sending" : "received",
        } satisfies TextMessage;
        this.setMessages(
          produce((state) => {
            index = state.push(message) - 1;
            this.setMessageDB(message);
          }),
        );
      }
      setStatus(this.messages[index]);
    } else if (sessionMsg.type === "check-message") {
      const index = this.messages.findIndex(
        (msg) => msg.id === sessionMsg.id,
      );
      if (index !== -1) {
        this.clearTimeout(sessionMsg.id);
        this.setMessages(index, "status", "received");
        this.setMessageDB(this.messages[index]);
      }
    } else if (sessionMsg.type === "send-file") {
      index = this.messages.findIndex(
        (msg) =>
          msg.type === "file" && msg.fid === sessionMsg.fid,
      );
      if (index === -1) {
        const message = {
          ...sessionMsg,
          type: "file",
          status: isSending ? "sending" : "received",
        } satisfies FileTransferMessage;
        this.setMessages(
          produce((state) => {
            index = state.push(message) - 1;
            this.setMessageDB(message);
          }),
        );
      }
      setStatus(this.messages[index]);
    } else if (sessionMsg.type === "request-file") {
      if (index === -1) {
        console.warn(
          `can not request file ${sessionMsg.fid}, message not exist`,
        );
      }
    }
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
        setter(
          (state) => (state.transferStatus = "merging"),
        );
      },
      { once: true, signal: controller.signal },
    );

    cache.addEventListener(
      "merged",
      () => {
        setter((state) => {
          state.transferStatus = "complete";
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
          state.transferStatus = "ready";
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
          state.transferStatus = "processing";
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
            state.transferStatus = "complete";
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
          state.transferStatus = "error";
          state.error = event.detail.message;
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
