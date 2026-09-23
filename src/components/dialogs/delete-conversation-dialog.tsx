import { createSignal } from "solid-js";
import { Button } from "@/components/ui/button";
import { createDialog } from "./dialog";
import { t } from "@/i18n";

export function createDeleteConversationDialog() {
  const [name, setName] = createSignal("");
  const { open, close, submit } = createDialog<boolean>({
    title: () => t("conversations.delete_title"),
    description: () =>
      t("conversations.delete_description", {
        name: name(),
      }),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.delete")}
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
