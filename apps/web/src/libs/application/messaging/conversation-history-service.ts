import type { MessageStores } from "./message-store";

export interface LocalConversationText {
  /** Stable within a batch, so interrupted writes can be resumed. */
  key: string;
  text: string;
}

/** Application API for locally generated history; never sends peer traffic. */
export class ConversationHistoryService {
  private readonly pending = new Map<
    string,
    Promise<void>
  >();

  constructor(
    private readonly store: MessageStores,
    private readonly localClientId: () => string,
  ) {}

  async cacheLocalTextBatch(
    batchId: string,
    peerId: string,
    name: string,
    entries: readonly LocalConversationText[],
  ): Promise<void> {
    await this.store.initialize();
    const target = this.localClientId();
    const key = JSON.stringify([target, peerId, batchId]);
    const existing = this.pending.get(key);
    if (existing) return existing;

    const pending = this.saveBatch(
      target,
      peerId,
      name,
      batchId,
      key,
      entries,
    ).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  private async saveBatch(
    target: string,
    peerId: string,
    name: string,
    batchId: string,
    batchKey: string,
    entries: readonly LocalConversationText[],
  ): Promise<void> {
    await this.store.setClient({
      clientId: peerId,
      name,
      avatar:
        this.store.clients.find(
          (client) => client.clientId === peerId,
        )?.avatar ?? null,
    });

    const createdAt = Date.now();
    for (const [index, entry] of entries.entries()) {
      const id = `local-text:${batchKey}:${entry.key}`;
      const legacyId = `${batchId}:${target}:${entry.key}`;
      const cached = this.store.messages.find(
        (message) =>
          !message.room &&
          message.client === peerId &&
          message.target === target &&
          (message.id === id || message.id === legacyId),
      );
      if (cached) {
        // A failed write can already be visible in the reactive history.
        // Retain IDs from batches written before participant scoping was added.
        await this.store.flushMessage(cached.id);
      } else {
        await this.store.addMessage({
          id,
          type: "text",
          client: peerId,
          target,
          data: entry.text,
          createdAt: createdAt + index,
          status: "received",
        });
      }
    }
  }
}
