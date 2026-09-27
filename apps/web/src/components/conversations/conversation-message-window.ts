import {
  createMemo,
  createSignal,
  type Accessor,
} from "solid-js";
import type { StoreMessage } from "@/libs/domain/message";

export const CHAT_INITIAL_MESSAGE_COUNT = 40;
export const CHAT_HISTORY_PAGE_SIZE = 20;

interface MessageWindow {
  ready: boolean;
  messages: StoreMessage[];
  visibleCount: number;
  historyRevision: number;
  lastId: string | undefined;
  animatedIds: ReadonlySet<string>;
  appendRevision: number;
}

/**
 * Keeps one conversation's rendered history window stable while messages are
 * appended or older rows are revealed. Storage owns the complete history; this
 * helper only controls how much of that history is mounted in the chat view.
 */
export function createConversationMessageWindow(options: {
  ready: Accessor<boolean>;
  messages: Accessor<readonly StoreMessage[]>;
  initialCount?: number;
  pageSize?: number;
}) {
  const initialCount =
    options.initialCount ?? CHAT_INITIAL_MESSAGE_COUNT;
  const pageSize =
    options.pageSize ?? CHAT_HISTORY_PAGE_SIZE;
  const [historyRevision, setHistoryRevision] =
    createSignal(0);

  const state = createMemo<MessageWindow>((previous) => {
    const ready = options.ready();
    const next = options.messages();
    const history = historyRevision();

    if (!ready || !previous?.ready) {
      return {
        ready,
        messages: ready ? next.slice(-initialCount) : [],
        visibleCount: initialCount,
        historyRevision: history,
        lastId: next.at(-1)?.id,
        animatedIds: new Set<string>(),
        appendRevision: 0,
      };
    }

    const previousLastIndex = previous.lastId
      ? next.findIndex(
          (message) => message.id === previous.lastId,
        )
      : -1;
    const added =
      previous.lastId && previousLastIndex === -1
        ? []
        : next.slice(previousLastIndex + 1);
    const visibleCount =
      previous.visibleCount +
      added.length +
      history -
      previous.historyRevision;

    return {
      ready: true,
      messages: next.slice(-visibleCount),
      visibleCount,
      historyRevision: history,
      lastId: next.at(-1)?.id,
      animatedIds: added.length
        ? new Set(added.map((message) => message.id))
        : previous.animatedIds,
      appendRevision:
        previous.appendRevision + (added.length ? 1 : 0),
    };
  });

  return {
    state,
    messages: () => state().messages,
    visibleCount: () => state().visibleCount,
    animatedIds: () => state().animatedIds,
    appendRevision: () => state().appendRevision,
    hasEarlier: () =>
      state().messages.length < options.messages().length,
    loadEarlier(count = pageSize) {
      if (count <= 0) return;
      setHistoryRevision((revision) => revision + count);
    },
    missingFor(messageId: string) {
      const all = options.messages();
      const index = all.findIndex(
        (message) => message.id === messageId,
      );
      if (index < 0) return 0;
      return Math.max(
        0,
        all.length - index - state().visibleCount,
      );
    },
  };
}
