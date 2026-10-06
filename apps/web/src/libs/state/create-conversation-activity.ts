import {
  createEffect,
  untrack,
  type Accessor,
} from "solid-js";
import type { MessageStores } from "@/libs/application/messaging/message-store";

/** Record transitions, not the duration of an online session or profile edits. */
export function createConversationActivity(
  onlinePeerIds: Accessor<readonly string[]>,
  messages: Pick<MessageStores, "recordClientOnline">,
): void {
  let previous = new Set<string>();
  createEffect(() => {
    const online = new Set(onlinePeerIds());
    for (const peerId of online) {
      if (previous.has(peerId)) continue;
      untrack(() => {
        void messages
          .recordClientOnline(peerId)
          .catch((error) => {
            console.error(
              "Could not record peer activity",
              error,
            );
          });
      });
    }
    previous = online;
  });
}
