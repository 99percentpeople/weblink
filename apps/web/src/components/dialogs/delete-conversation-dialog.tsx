import { createSignal } from "solid-js";
import { Button } from "@/components/ui/button";
import { createDialog } from "./dialog";
import { t } from "@/i18n";
import type { Conversation } from "@/libs/domain/conversation";

function createConversationActionDialog(
  action: "clear" | "delete",
) {
  const [name, setName] = createSignal("");
  const [kind, setKind] =
    createSignal<Conversation["kind"]>("direct");
  const roomDeletion = () =>
    action === "delete" && kind() === "room";
  const { open, close, submit } = createDialog<boolean>({
    title: () =>
      t(
        roomDeletion()
          ? "conversations.delete_room"
          : `conversations.${action}_title`,
      ),
    description: () =>
      t(
        roomDeletion()
          ? "conversations.delete_room_description"
          : `conversations.${action}_description`,
        { name: name() },
      ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t(
          action === "clear"
            ? "conversations.clear"
            : roomDeletion()
              ? "conversations.delete_room"
              : "common.action.delete",
        )}
      </Button>
    ),
    cancel: (
      <Button variant="outline" onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
  });
  return {
    open: (
      title: string,
      kind: Conversation["kind"] = "direct",
    ) => {
      setName(title);
      setKind(kind);
      return open();
    },
  };
}

export const createDeleteConversationDialog = () =>
  createConversationActionDialog("delete");
export const createClearConversationDialog = () =>
  createConversationActionDialog("clear");
