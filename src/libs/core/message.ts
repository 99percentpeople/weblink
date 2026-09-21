import {
  produce,
  reconcile,
  SetStoreFunction,
} from "solid-js/store";
import { ClientID, FileID, Client } from "./type";
import {
  FileTransferer,
  ProgressValue,
  TransferMode,
} from "./file-transferer";
import { ChunkCache } from "../cache/chunk-cache";
import type { Accessor } from "solid-js";
import type {
  AckMessage,
  BaseExchangeMessage,
  ErrorMessage,
  MessageID,
  RequestFileMessage,
  SendFileMessage,
  SendTextMessage,
  SessionMessage,
} from "@/libs/core/protocol/messages";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

export interface BaseStorageMessage extends BaseExchangeMessage {
  id: string;
}

export interface TextMessage extends BaseStorageMessage {
  type: "text";
  data: string;
  error?: string;
}

export interface FileTransferMessage extends BaseStorageMessage {
  type: "file";
  fid?: FileID;
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
    | "init"
    | "transfering"
    | "complete"
    | "paused"
    | "error";
}

export type StoreMessage =
  | TextMessage
  | FileTransferMessage;

export type SendMessageOptions = {
  timeoutMs?: number | null;
};

type SendHandledMessage = Extract<
  SessionMessage,
  {
    type: "send-text" | "send-file" | "request-file";
  }
>;

type ReceiveHandledMessage = Extract<
  SessionMessage,
  {
    type:
      | "send-text"
      | "send-file"
      | "request-file"
      | "error"
      | "ack";
  }
>;

type SendTextHandledMessage = Extract<
  SendHandledMessage,
  { type: "send-text" }
>;

type SendFileHandledMessage = Extract<
  SendHandledMessage,
  { type: "send-file" }
>;

type RequestFileHandledMessage = Extract<
  SendHandledMessage,
  { type: "request-file" }
>;

type ReceiveSendTextHandledMessage = Extract<
  ReceiveHandledMessage,
  { type: "send-text" }
>;

type ReceiveSendFileHandledMessage = Extract<
  ReceiveHandledMessage,
  { type: "send-file" }
>;

type ReceiveRequestFileHandledMessage = Extract<
  ReceiveHandledMessage,
  { type: "request-file" }
>;

type ReceiveErrorHandledMessage = Extract<
  ReceiveHandledMessage,
  { type: "error" }
>;

type ReceiveAckHandledMessage = Extract<
  ReceiveHandledMessage,
  { type: "ack" }
>;

type SendDispatchContext = {
  self: MessageStores;
  pushIfMissing: (message: StoreMessage) => void;
};

type RetryDispatchContext = {
  self: MessageStores;
  index: number;
  resetTimeout: (messageId: MessageID) => void;
};

type ReceiveDispatchContext = {
  self: MessageStores;
  getIndex: () => number;
  pushIfMissing: (message: StoreMessage) => void;
  setStatus: (index: number) => void;
};

class MessageStores {
  private static createTextMessage(
    message: SendTextHandledMessage,
    status: "sending" | "received",
  ) {
    return {
      ...message,
      type: "text",
      status,
    } satisfies TextMessage;
  }

  private static createFileMessageFromSendFile(
    message: SendFileHandledMessage,
    status: "sending" | "received",
  ) {
    return {
      ...message,
      type: "file",
      status,
    } satisfies FileTransferMessage;
  }

  private static createFileMessageFromRequestFile(
    message: RequestFileHandledMessage,
    status: "sending" | "received",
  ) {
    return {
      id: message.id,
      type: "file",
      status,
      fid: message.fid,
      fileName: message.fileName,
      fileSize: message.fileSize,
      mimeType: message.mimeType,
      lastModified: message.lastModified,
      chunkSize: message.chunkSize,
      createdAt: message.createdAt,
      client: message.target,
      target: message.client,
      transferStatus: "init",
    } satisfies FileTransferMessage;
  }

  private static handleSendTextMessage(
    { pushIfMissing }: SendDispatchContext,
    message: SendTextHandledMessage,
  ) {
    pushIfMissing(
      MessageStores.createTextMessage(message, "sending"),
    );
  }

  private static handleSendFileMessage(
    { pushIfMissing }: SendDispatchContext,
    message: SendFileHandledMessage,
  ) {
    pushIfMissing(
      MessageStores.createFileMessageFromSendFile(
        message,
        "sending",
      ),
    );
  }

  private static handleSendRequestFileMessage(
    { pushIfMissing }: SendDispatchContext,
    message: RequestFileHandledMessage,
  ) {
    pushIfMissing(
      MessageStores.createFileMessageFromRequestFile(
        message,
        "sending",
      ),
    );
  }

  private static handleRetrySendTextMessage(
    { self, index, resetTimeout }: RetryDispatchContext,
    message: SendTextHandledMessage,
  ) {
    self.setMessages(
      index,
      produce((state) => {
        if (state.type !== "text") return;
        state.status = "sending";
        state.error = undefined;
        state.data = message.data;
        self.setMessageDB(state);
      }),
    );
    resetTimeout(message.id);
  }

  private static handleRetrySendFileMessage(
    { self, index, resetTimeout }: RetryDispatchContext,
    message: SendFileHandledMessage,
  ) {
    self.setMessages(
      index,
      produce((state) => {
        if (state.type !== "file") return;
        state.status = "sending";
        state.error = undefined;
        state.fid = message.fid;
        state.fileName = message.fileName;
        state.fileSize = message.fileSize;
        state.mimeType = message.mimeType;
        state.lastModified = message.lastModified;
        state.chunkSize = message.chunkSize;
        self.setMessageDB(state);
      }),
    );
    resetTimeout(message.id);
  }

  private static handleRetryRequestFileMessage(
    { self, index, resetTimeout }: RetryDispatchContext,
    message: RequestFileHandledMessage,
  ) {
    self.setMessages(
      index,
      produce((state) => {
        if (state.type !== "file") return;
        state.status = "sending";
        state.error = undefined;
        state.fid = message.fid;
        state.fileName = message.fileName;
        state.fileSize = message.fileSize;
        state.mimeType = message.mimeType;
        state.lastModified = message.lastModified;
        state.chunkSize = message.chunkSize;
        state.transferStatus = "init";
        self.setMessageDB(state);
      }),
    );
    resetTimeout(message.id);
  }

  private static handleReceiveSendTextMessage(
    {
      pushIfMissing,
      setStatus,
      getIndex,
    }: ReceiveDispatchContext,
    message: ReceiveSendTextHandledMessage,
  ) {
    pushIfMissing(
      MessageStores.createTextMessage(message, "received"),
    );
    setStatus(getIndex());
  }

  private static handleReceiveSendFileMessage(
    {
      pushIfMissing,
      setStatus,
      getIndex,
    }: ReceiveDispatchContext,
    message: ReceiveSendFileHandledMessage,
  ) {
    pushIfMissing(
      MessageStores.createFileMessageFromSendFile(
        message,
        "received",
      ),
    );
    setStatus(getIndex());
  }

  private static handleReceiveRequestFileMessage(
    { pushIfMissing }: ReceiveDispatchContext,
    message: ReceiveRequestFileHandledMessage,
  ) {
    pushIfMissing(
      MessageStores.createFileMessageFromRequestFile(
        message,
        "received",
      ),
    );
  }

  private static handleReceiveErrorMessage(
    { self, getIndex }: ReceiveDispatchContext,
    message: ReceiveErrorHandledMessage,
  ) {
    self.clearTimeout(message.id);
    self.setMessages(
      getIndex(),
      produce((state) => {
        state.status = "error";
        state.error = message.error;
        self.setMessageDB(state);
      }),
    );
  }

  private static handleReceiveAckMessage(
    { self, getIndex }: ReceiveDispatchContext,
    message: ReceiveAckHandledMessage,
  ) {
    const index = getIndex();
    if (index === -1) return;
    self.clearTimeout(message.id);
    self.setMessages(
      index,
      produce((state) => {
        state.status = "received";
        state.error = undefined;
        self.setMessageDB(state);
      }),
    );
  }

  private static readonly dbRequestFactoryByType = new Map<
    StoreMessage["type"],
    (
      db: IDBDatabase,
      message: StoreMessage,
    ) => IDBRequest<IDBValidKey>
  >([
    [
      "text",
      (db, message) =>
        db
          .transaction("messages", "readwrite")
          .objectStore("messages")
          .put({
            ...message,
          }),
    ],
    [
      "file",
      (db, message) => {
        const { progress, ...storeMessage } =
          message as FileTransferMessage;
        return db
          .transaction("messages", "readwrite")
          .objectStore("messages")
          .put(storeMessage);
      },
    ],
  ]);

  private static readonly sendMessageHandlers = new Map<
    SendHandledMessage["type"],
    (
      ctx: SendDispatchContext,
      message: SendHandledMessage,
    ) => void
  >([
    [
      "send-text",
      (ctx, message) =>
        MessageStores.handleSendTextMessage(
          ctx,
          message as SendTextHandledMessage,
        ),
    ],
    [
      "send-file",
      (ctx, message) =>
        MessageStores.handleSendFileMessage(
          ctx,
          message as SendFileHandledMessage,
        ),
    ],
    [
      "request-file",
      (ctx, message) =>
        MessageStores.handleSendRequestFileMessage(
          ctx,
          message as RequestFileHandledMessage,
        ),
    ],
  ]);

  private static readonly retrySendHandlers = new Map<
    SendHandledMessage["type"],
    (
      ctx: RetryDispatchContext,
      message: SendHandledMessage,
    ) => void
  >([
    [
      "send-text",
      (ctx, message) =>
        MessageStores.handleRetrySendTextMessage(
          ctx,
          message as SendTextHandledMessage,
        ),
    ],
    [
      "send-file",
      (ctx, message) =>
        MessageStores.handleRetrySendFileMessage(
          ctx,
          message as SendFileHandledMessage,
        ),
    ],
    [
      "request-file",
      (ctx, message) =>
        MessageStores.handleRetryRequestFileMessage(
          ctx,
          message as RequestFileHandledMessage,
        ),
    ],
  ]);

  private static readonly receiveHandlers = new Map<
    ReceiveHandledMessage["type"],
    (
      ctx: ReceiveDispatchContext,
      message: ReceiveHandledMessage,
    ) => void
  >([
    [
      "send-text",
      (ctx, message) =>
        MessageStores.handleReceiveSendTextMessage(
          ctx,
          message as ReceiveSendTextHandledMessage,
        ),
    ],
    [
      "send-file",
      (ctx, message) =>
        MessageStores.handleReceiveSendFileMessage(
          ctx,
          message as ReceiveSendFileHandledMessage,
        ),
    ],
    [
      "request-file",
      (ctx, message) =>
        MessageStores.handleReceiveRequestFileMessage(
          ctx,
          message as ReceiveRequestFileHandledMessage,
        ),
    ],
    [
      "error",
      (ctx, message) =>
        MessageStores.handleReceiveErrorMessage(
          ctx,
          message as ReceiveErrorHandledMessage,
        ),
    ],
    [
      "ack",
      (ctx, message) =>
        MessageStores.handleReceiveAckMessage(
          ctx,
          message as ReceiveAckHandledMessage,
        ),
    ],
  ]);

  readonly messages: StoreMessage[] =
    appState.message.messages;
  readonly clients: Client[] = appState.message.clients;
  readonly db: Promise<IDBDatabase> | IDBDatabase;
  private setMessages: SetStoreFunction<StoreMessage[]> = ((
    ...args: any[]
  ) =>
    (setAppState as any)(
      "message",
      "messages",
      ...args,
    )) as any;
  private setClients: SetStoreFunction<Client[]> = ((
    ...args: any[]
  ) =>
    (setAppState as any)(
      "message",
      "clients",
      ...args,
    )) as any;
  status: Accessor<"initializing" | "ready"> = () =>
    appState.message.status;
  private controllers: Record<FileID, AbortController> = {};
  constructor() {
    this.db = this.initDB();
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
                message.transferStatus = "paused";
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
      setAppState("message", "status", "ready");
    });
  }

  private async setMessageDB(message: StoreMessage) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const requestFactory =
        MessageStores.dbRequestFactoryByType.get(
          message.type,
        );
      const request = requestFactory?.(db, message);
      if (!request) {
        reject(
          new Error(
            `unsupported message type: ${message.type}`,
          ),
        );
        return;
      }
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

  setSendMessage(
    sessionMsg: SessionMessage,
    options: SendMessageOptions = {},
  ) {
    const timeoutMs =
      options.timeoutMs === undefined
        ? 5000
        : options.timeoutMs;
    let index: number = this.messages.findLastIndex(
      (msg) => msg.id === sessionMsg.id,
    );
    const setStatus = (message: StoreMessage) => {
      this.setMessages(index, "error", undefined);
      this.setMessageDB(this.messages[index]);

      if (timeoutMs === null) return;

      this.setTimeout(message.id, timeoutMs, () => {
        this.setMessages(index, "status", "error");
        this.setMessages(index, "error", "send timeout");
        this.setMessageDB(this.messages[index]);
      });
    };

    const pushIfMissing = (message: StoreMessage) => {
      if (index !== -1) return;
      this.setMessages(
        produce((state) => {
          index = state.push(message) - 1;
          this.setMessageDB(message);
          setStatus(message);
        }),
      );
    };

    const sendHandler =
      MessageStores.sendMessageHandlers.get(
        sessionMsg.type as SendHandledMessage["type"],
      );
    if (!sendHandler) return;
    sendHandler(
      {
        self: this,
        pushIfMissing,
      },
      sessionMsg as SendHandledMessage,
    );
  }

  retrySendMessage(
    sessionMsg: SessionMessage,
    options: SendMessageOptions = {},
  ) {
    const timeoutMs =
      options.timeoutMs === undefined
        ? 5000
        : options.timeoutMs;
    const index = this.messages.findLastIndex(
      (msg) => msg.id === sessionMsg.id,
    );

    if (index === -1) {
      this.setSendMessage(sessionMsg, options);
      return;
    }

    const resetTimeout = (messageId: MessageID) => {
      this.clearTimeout(messageId);
      if (timeoutMs === null) return;
      this.setTimeout(messageId, timeoutMs, () => {
        const nextIndex = this.messages.findLastIndex(
          (msg) => msg.id === messageId,
        );
        if (nextIndex === -1) return;

        this.setMessages(nextIndex, "status", "error");
        this.setMessages(
          nextIndex,
          "error",
          "send timeout",
        );
        this.setMessageDB(this.messages[nextIndex]);
      });
    };

    const retryHandler =
      MessageStores.retrySendHandlers.get(
        sessionMsg.type as SendHandledMessage["type"],
      );
    if (!retryHandler) return;
    retryHandler(
      {
        self: this,
        index,
        resetTimeout,
      },
      sessionMsg as SendHandledMessage,
    );
  }

  setReceiveMessage(sessionMsg: SessionMessage) {
    let index: number = this.messages.findIndex(
      (msg) => msg.id === sessionMsg.id,
    );

    const setStatus = (index: number) => {
      this.setMessages(index, "error", undefined);
      this.setMessageDB(this.messages[index]);
    };

    const pushIfMissing = (message: StoreMessage) => {
      if (index !== -1) return;
      this.setMessages(
        produce((state) => {
          index = state.push(message) - 1;
          this.setMessageDB(message);
        }),
      );
    };

    const receiveHandler =
      MessageStores.receiveHandlers.get(
        sessionMsg.type as ReceiveHandledMessage["type"],
      );
    if (!receiveHandler) return;
    receiveHandler(
      {
        self: this,
        getIndex: () => index,
        pushIfMissing,
        setStatus,
      },
      sessionMsg as ReceiveHandledMessage,
    );
  }

  async addMessage(message: StoreMessage) {
    new Promise((resolve, reject) => {
      this.setMessages(
        produce((state) => {
          state.push(message);
        }),
      );

      this.setMessageDB(message)
        .then(resolve)
        .catch(reject);
    });
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
    const index = this.messages.findLastIndex(
      (msg) => msg.type === "file" && msg.fid === cache.id,
    );
    if (index === -1) {
      console.warn(`cache for message not existed`);
      return false;
    }
    const setter = this.getMessageSetter(index);
    if (!setter) {
      console.warn(`setter for message not existed`);
      return false;
    }

    cache.addEventListener(
      "complete",
      () => {
        controller.abort("complete");
        setter((state) => {
          state.transferStatus = "complete";
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
      return true;
    }
    return false;
  }

  addTransfer(transferer: FileTransferer) {
    if (this.controllers[transferer.id] !== undefined) {
      console.warn(
        `transferer ${transferer.id} has been added`,
      );
    }
    const index = this.messages.findLastIndex(
      (msg) =>
        msg.type === "file" && msg.fid === transferer.id,
    );
    if (index === -1) {
      console.warn(`transferer for message not existed`);
      return;
    }
    const setter = this.getMessageSetter(index);
    if (!setter) {
      console.warn(`setter for message not existed`);
      return;
    }
    const controller = this.getController(transferer.id);
    if (transferer.mode === TransferMode.Receive) {
      this.addCache(transferer.cache);
    }

    transferer.addEventListener(
      "ready",
      () => {
        setter((state) => {
          state.error = undefined;
          state.transferStatus = "transfering";
        });
      },
      {
        signal: controller.signal,
      },
    );
    transferer.addEventListener(
      "progress",
      (event: CustomEvent<ProgressValue>) => {
        // console.log(`progress`, event.detail);
        const { total, received } = event.detail;
        setter((state) => {
          state.progress = {
            total: total,
            received: received,
          };
          state.transferStatus = "transfering";
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
            state.status = "received";
            state.transferStatus = "complete";
            state.error = undefined;
          });
        }
      },
      {
        signal: controller.signal,
      },
    );

    transferer.addEventListener(
      "close",
      () => {
        controller.abort();
        setter((state) => {
          if (state.transferStatus !== "complete") {
            state.transferStatus = "paused";
          }
        });
      },
      { signal: controller.signal },
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
        signal: controller.signal,
      },
    );
  }
}

export let messageStores: MessageStores;

export function createMessageStores() {
  if (!messageStores) {
    messageStores = new MessageStores();
  }
  return messageStores;
}
