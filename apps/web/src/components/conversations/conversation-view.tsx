import { createMemo, Match, Show, Switch } from "solid-js";
import { appState } from "@/libs/state/app-state";
import { ChatConversation } from "./direct-conversation";
import { RoomConversation } from "./room-conversation";
import { t } from "@/i18n";
import { ConversationBackButton } from "./conversation-back-button";

export function ConversationView(props: {
  conversationId: string;
  embedded?: boolean;
  onBack?: () => void;
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
        <div class="flex min-h-0 flex-1 flex-col">
          <Show when={props.onBack}>
            {(onBack) => (
              <header class="flex shrink-0 items-center border-b p-2">
                <ConversationBackButton
                  onClick={onBack()}
                />
              </header>
            )}
          </Show>
          <p class="text-muted-foreground m-auto p-6 text-center text-sm">
            {t("conversations.select")}
          </p>
        </div>
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
                  onBack={props.onBack}
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
                  onBack={props.onBack}
                />
              ) : null;
            }}
          </Match>
        </Switch>
      )}
    </Show>
  );
}
