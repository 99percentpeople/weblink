import { createMemo, Match, Show, Switch } from "solid-js";
import { appState } from "@/libs/state/app-state";
import { ChatConversation } from "./direct-conversation";
import { RoomConversation } from "./room-conversation";
import { t } from "@/i18n";

export function ConversationView(props: {
  conversationId: string;
  embedded?: boolean;
}) {
  const conversation = createMemo(() =>
    appState.message.conversations.find(
      (item) => item.id === props.conversationId,
    ),
  );
  return (
    <Show
      when={conversation()?.id}
      keyed
      fallback={
        <p class="text-muted-foreground m-auto p-6 text-center text-sm">
          {t("conversations.select")}
        </p>
      }
    >
      {(_id) => (
        <Switch>
          <Match
            when={
              conversation()?.kind === "direct" &&
              conversation()
            }
          >
            {(item) => {
              const value = item();
              return value.kind === "direct" ? (
                <ChatConversation
                  clientId={value.peerId}
                  conversationId={value.id}
                  embedded={props.embedded}
                />
              ) : null;
            }}
          </Match>
          <Match
            when={
              conversation()?.kind === "room" &&
              conversation()
            }
          >
            {(item) => {
              const value = item();
              return value.kind === "room" ? (
                <RoomConversation
                  conversation={value}
                  embedded={props.embedded}
                />
              ) : null;
            }}
          </Match>
        </Switch>
      )}
    </Show>
  );
}
