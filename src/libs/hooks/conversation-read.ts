import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";
import type { StoreMessage } from "@/libs/domain/message";
import { messageStores } from "@/libs/application/messaging/message-store";

/** Only a visible, mounted view at its newest message advances the shared cursor. */
export function createConversationReadTracking(
  conversationId: Accessor<string>,
  messages: Accessor<readonly StoreMessage[]>,
  following: Accessor<boolean>,
): void {
  const [visible, setVisible] = createSignal(
    document.visibilityState !== "hidden",
  );
  onMount(() => {
    const controller = new AbortController();
    document.addEventListener(
      "visibilitychange",
      () =>
        setVisible(document.visibilityState !== "hidden"),
      { signal: controller.signal },
    );
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const id = conversationId();
    const last = messages().at(-1)?.id;
    if (!last || !visible() || !following()) return;
    if (
      messageStores?.conversations?.some(
        (conversation) => conversation.id === id,
      )
    ) {
      messageStores.markConversationRead(id);
    }
  });
}
