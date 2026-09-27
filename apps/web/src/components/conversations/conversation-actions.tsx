import { createSignal, Show } from "solid-js";
import { Eraser, Trash2 } from "lucide-solid";
import { Button } from "@/components/ui/button";
import {
  createClearConversationDialog,
  createDeleteConversationDialog,
} from "@/components/dialogs/delete-conversation-dialog";
import { messageStores } from "@/libs/application/messaging/message-store";
import { appState } from "@/libs/state/app-state";
import { t } from "@/i18n";

export function createConversationActions(
  isOnline: (id: string) => boolean,
) {
  const [busy, setBusy] = createSignal(false);
  const clearDialog = createClearConversationDialog();
  const deleteDialog = createDeleteConversationDialog();
  const run = async (
    id: string,
    action: "clear" | "delete",
  ) => {
    const conversation =
      appState.message.conversations.find(
        (item) => item.id === id,
      );
    if (
      !conversation ||
      busy() ||
      (action === "delete" && isOnline(id))
    )
      return false;
    setBusy(true);
    try {
      const confirmed = await (
        action === "clear" ? clearDialog : deleteDialog
      ).open(conversation.title);
      // A peer may reconnect or the user may join while confirmation is open.
      if (
        !confirmed.result ||
        !appState.message.conversations.some(
          (item) => item.id === id,
        ) ||
        (action === "delete" && isOnline(id))
      )
        return false;
      if (action === "clear")
        messageStores.clearConversation(id);
      else messageStores.deleteConversation(id);
      return true;
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    clear: (id: string) => run(id, "clear"),
    remove: (id: string) => run(id, "delete"),
  };
}

export function ConversationActions(props: {
  conversationId: string;
  online: boolean;
  onDeleted?(): void;
}) {
  const actions = createConversationActions(
    (id) => id !== props.conversationId || props.online,
  );
  const exists = () =>
    appState.message.conversations.some(
      (item) => item.id === props.conversationId,
    );
  return (
    <div class="space-y-3">
      <p class="text-muted-foreground text-xs leading-relaxed">
        {t("conversations.manage_hint")}
      </p>
      <div class="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={actions.busy() || !exists()}
          onClick={() =>
            void actions.clear(props.conversationId)
          }
        >
          <Eraser class="size-4" />
          {t("conversations.clear")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={
            actions.busy() || !exists() || props.online
          }
          onClick={async () => {
            const id = props.conversationId;
            if (
              (await actions.remove(id)) &&
              props.conversationId === id
            )
              props.onDeleted?.();
          }}
        >
          <Trash2 class="size-4" />
          {t("conversations.delete")}
        </Button>
      </div>
      <Show when={props.online}>
        <p class="text-muted-foreground text-xs">
          {t("conversations.delete_requires_exit")}
        </p>
      </Show>
    </div>
  );
}
