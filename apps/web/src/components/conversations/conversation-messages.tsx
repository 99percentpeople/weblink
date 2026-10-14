import { createMemo, For, Show } from "solid-js";
import { cn } from "@/libs/cn";
import type { Client } from "@/libs/domain/client";
import type { StoreMessage } from "@/libs/domain/message";
import { appState } from "@/libs/state/app-state";
import { ChatTimeSeparator } from "@/routes/client/[id]/components/chat-time-separator";
import { MessageContent } from "@/routes/client/[id]/components/message";
import { createMessageLayout } from "@/routes/client/[id]/components/message-layout";
import { MessageSenderAvatar } from "./message-sender-avatar";

export function ConversationMessages(props: {
  messages: readonly StoreMessage[];
  peer?: Pick<Client, "clientId" | "name" | "avatar">;
  showAvatars?: boolean;
  animatedIds?: ReadonlySet<string>;
  onExpandText?: (expand: () => void) => void;
  onDelete(message: StoreMessage): void;
}) {
  const showAvatars = () => props.showAvatars !== false;
  const layout = createMemo(() => {
    let row = 0;
    const items = createMessageLayout(props.messages).map(
      (item) => {
        if (item.timeSeparator) row++;
        return { ...item, row: ++row, span: 1 };
      },
    );
    for (
      let index = items.length - 2;
      index >= 0;
      index--
    ) {
      if (items[index].joinedNext)
        items[index].span = items[index + 1].span + 1;
    }
    return items;
  });

  return (
    <Show when={props.messages.length > 0}>
      <li role="presentation" class="min-w-0">
        {/* Keep message nodes keyed independently of groups. An avatar's grid
            area spans its group, bounding sticky without reparenting messages
            when history is prepended or groups merge after deletion. */}
        <ul
          data-slot="conversation-messages"
          class={cn(
            "grid min-w-0 items-start gap-y-1",
            showAvatars()
              ? "grid-cols-[1.75rem_minmax(0,1fr)_1.75rem] gap-x-1.5"
              : "grid-cols-1",
          )}
        >
          <For each={props.messages}>
            {(message, index) => {
              const item = () => layout()[index()];
              const outgoing = () =>
                message.client ===
                appState.profile.clientId;
              const separated = () =>
                !item().joinedPrevious &&
                !item().timeSeparator;
              return (
                <>
                  <Show when={item().timeSeparator}>
                    <ChatTimeSeparator
                      timestamp={message.createdAt}
                      row={item().row - 1}
                    />
                  </Show>
                  <Show
                    when={
                      showAvatars() &&
                      !item().joinedPrevious
                    }
                  >
                    <li
                      role="presentation"
                      data-slot="message-avatar-group"
                      class={cn(
                        "self-stretch",
                        separated() && "mt-2",
                      )}
                      style={{
                        "grid-column": outgoing()
                          ? "3"
                          : "1",
                        "grid-row": `${item().row} / span ${item().span}`,
                      }}
                    >
                      <MessageSenderAvatar
                        message={message}
                        peer={props.peer}
                        class="sticky top-2"
                      />
                    </li>
                  </Show>
                  <MessageContent
                    data-chat-message={message.id}
                    message={message}
                    showAvatar={false}
                    onExpandText={props.onExpandText}
                    joinedPrevious={item().joinedPrevious}
                    joinedNext={item().joinedNext}
                    onDelete={() => props.onDelete(message)}
                    style={{
                      "grid-column": showAvatars()
                        ? outgoing()
                          ? "1 / 3"
                          : "2 / 4"
                        : "1 / -1",
                      "grid-row": item().row,
                    }}
                    class={cn(
                      separated() && "mt-2",
                      props.animatedIds?.has(message.id) &&
                        "animate-message",
                    )}
                  />
                </>
              );
            }}
          </For>
        </ul>
      </li>
    </Show>
  );
}
