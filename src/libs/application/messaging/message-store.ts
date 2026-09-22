import {
  produce,
  reconcile,
  SetStoreFunction,
} from "solid-js/store";
import type { Accessor } from "solid-js";
import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";
export type {
  FileTransferMessage,
  StoreMessage,
  TextMessage,
} from "@/libs/domain/message";
import type {
  MessageID,
  SessionMessage,
} from "@/libs/domain/protocol/messages";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { MessageRepository } from "./message-repository";
import {
  applyTrackedResponse,
  projectIncomingMessage,
  projectOutgoingMessage,
  projectRetry,
} from "./message-projection";

function snapshotStoreMessage(
  message: StoreMessage,
): StoreMessage {
  if (message.type === "text") {
    return { ...message };
  }
  return {
    ...message,
    progress: message.progress
      ? { ...message.progress }
      : undefined,
  };
}

function snapshotClient(client: Client): Client {
  return { ...client };
}

export class MessageStores {
  readonly messages: StoreMessage[] =
    appState.message.messages;
  readonly clients: Client[] = appState.message.clients;

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

  private initialization: Promise<void> | null = null;

  constructor(
    private readonly repository: MessageRepository,
  ) {}

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;

    this.initialization = this.repository
      .load()
      .then(({ messages, clients }) => {
        this.setMessages(
          reconcile(
            messages.map((message) => {
              if (
                message.type === "file" &&
                message.transferStatus !== "complete"
              ) {
                return {
                  ...message,
                  transferStatus: "paused",
                } satisfies FileTransferMessage;
              }
              return message;
            }),
          ),
        );
        this.setClients(reconcile(clients));
        setAppState("message", "status", "ready");
      });

    return this.initialization;
  }

  private persistMessage(message: StoreMessage): void {
    const snapshot = snapshotStoreMessage(message);
    void this.repository
      .putMessage(snapshot)
      .catch((error) => {
        console.error(
          "[MessageStore] could not persist message",
          error,
        );
      });
  }

  private persistClient(client: Client): void {
    const snapshot = snapshotClient(client);
    void this.repository
      .putClient(snapshot)
      .catch((error) => {
        console.error(
          "[MessageStore] could not persist client",
          error,
        );
      });
  }

  private removePersistedMessage(
    messageId: MessageID,
  ): void {
    void this.repository
      .removeMessage(messageId)
      .catch((error) => {
        console.error(
          "[MessageStore] could not delete message",
          error,
        );
      });
  }

  private removePersistedMessages(
    messageIds: MessageID[],
  ): void {
    void this.repository
      .removeMessages(messageIds)
      .catch((error) => {
        console.error(
          "[MessageStore] could not delete messages",
          error,
        );
      });
  }

  private removePersistedClient(clientId: ClientID): void {
    void this.repository
      .removeClient(clientId)
      .catch((error) => {
        console.error(
          "[MessageStore] could not delete client",
          error,
        );
      });
  }

  setSendMessage(sessionMsg: SessionMessage): void {
    if (
      this.messages.some(
        (message) => message.id === sessionMsg.id,
      )
    ) {
      return;
    }

    const message = projectOutgoingMessage(sessionMsg);
    if (!message) return;

    this.setMessages(
      produce((state) => {
        state.push(message);
      }),
    );
    this.persistMessage(message);
  }

  retrySendMessage(sessionMsg: SessionMessage): void {
    const index = this.messages.findLastIndex(
      (message) => message.id === sessionMsg.id,
    );

    if (index === -1) {
      this.setSendMessage(sessionMsg);
      return;
    }

    const message = projectRetry(
      this.messages[index],
      sessionMsg,
    );
    if (!message) return;

    this.setMessages(index, reconcile(message));
    this.persistMessage(message);
  }

  setReceiveMessage(sessionMsg: SessionMessage): void {
    const index = this.messages.findIndex(
      (message) => message.id === sessionMsg.id,
    );

    if (
      sessionMsg.type === "ack" ||
      sessionMsg.type === "error"
    ) {
      if (index === -1) return;
      const message = applyTrackedResponse(
        this.messages[index],
        sessionMsg,
      );
      if (!message) return;
      this.setMessages(index, reconcile(message));
      this.persistMessage(message);
      return;
    }

    if (index !== -1) {
      // Preserve historical duplicate semantics: repeated text/file setup clears
      // a stale local error, while repeated request-file does not mutate history.
      if (
        sessionMsg.type === "send-text" ||
        sessionMsg.type === "send-file"
      ) {
        const message = {
          ...this.messages[index],
          error: undefined,
        } as StoreMessage;
        this.setMessages(index, reconcile(message));
        this.persistMessage(message);
      }
      return;
    }

    const message = projectIncomingMessage(sessionMsg);
    if (!message) return;

    this.setMessages(
      produce((state) => {
        state.push(message);
      }),
    );
    this.persistMessage(message);
  }

  async addMessage(message: StoreMessage): Promise<void> {
    this.setMessages(
      produce((state) => {
        state.push(message);
      }),
    );
    await this.repository.putMessage(
      snapshotStoreMessage(message),
    );
  }

  setClient(client: Client): void {
    const index = this.clients.findIndex(
      (candidate) => candidate.clientId === client.clientId,
    );
    if (index !== -1) {
      this.setClients(index, client);
    } else {
      this.setClients(
        produce((state) => state.push(client)),
      );
    }
    this.persistClient(client);
  }

  deleteClient(clientId: ClientID): void {
    const index = this.clients.findIndex(
      (client) => client.clientId === clientId,
    );
    if (index === -1) return;

    this.setClients(
      produce((state) => state.splice(index, 1)),
    );
    this.removePersistedClient(clientId);
    this.deleteMessagesByClient(clientId);
  }

  deleteMessagesByClient(clientId: ClientID): void {
    const messageDeletes = this.messages.filter(
      (message) =>
        message.client === clientId ||
        message.target === clientId,
    );

    this.removePersistedMessages(
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

  updateTransferMessage(
    messageId: MessageID,
    update: (message: FileTransferMessage) => void,
  ): void {
    const index = this.messages.findIndex(
      (message) =>
        message.id === messageId && message.type === "file",
    );
    if (index === -1) return;

    this.setMessages(
      index,
      produce((message) => {
        if (message.type !== "file") return;
        update(message);
      }),
    );
    this.persistMessage(this.messages[index]);
  }

  deleteMessage(messageId: MessageID): boolean {
    const index = this.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (index === -1) return false;

    this.setMessages(
      produce((state) => state.splice(index, 1)),
    );
    this.removePersistedMessage(messageId);
    return true;
  }
}

export let messageStores: MessageStores;

export function createMessageStores(
  repository?: MessageRepository,
) {
  if (!messageStores) {
    if (!repository) {
      throw new Error(
        "MessageStores requires a MessageRepository on first initialization",
      );
    }
    messageStores = new MessageStores(repository);
  }
  return messageStores;
}
