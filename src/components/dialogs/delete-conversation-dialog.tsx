import { createSignal } from "solid-js";
import { Button } from "@/components/ui/button";
import { createDialog } from "./dialog";
import { t } from "@/i18n";

function createConversationActionDialog(
  action: "clear" | "delete",
) {
  const [name, setName] = createSignal("");
  const { open, close, submit } = createDialog<boolean>({
    title: () => t(`conversations.${action}_title`),
    description: () =>
      t(`conversations.${action}_description`, {
        name: name(),
      }),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t(
          action === "clear"
            ? "conversations.clear"
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
    open: (title: string) => {
      setName(title);
      return open();
    },
  };
}

export const createDeleteConversationDialog = () =>
  createConversationActionDialog("delete");
export const createClearConversationDialog = () =>
  createConversationActionDialog("clear");
