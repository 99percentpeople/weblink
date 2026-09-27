import { Button } from "@/components/ui/button";
import { createDialog } from "./dialog";
import { t } from "@/i18n";
import { createSignal } from "solid-js";

export const createComfirmDeleteClientDialog = () => {
  const [name, setName] = createSignal("");
  const {
    open: openDialog,
    close,
    submit,
  } = createDialog({
    title: () =>
      t("common.confirm_delete_client_dialog.title"),
    description: () =>
      t("common.confirm_delete_client_dialog.description"),
    content: () =>
      t("common.confirm_delete_client_dialog.content", {
        name: name(),
      }),

    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.confirm")}
      </Button>
    ),
    cancel: (
      <Button onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
  });

  const open = async (name: string) => {
    setName(name);
    return await openDialog();
  };

  return { open };
};
