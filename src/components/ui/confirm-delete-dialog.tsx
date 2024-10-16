import { Button } from "@/components/ui/button";
import { createDialog } from "../dialogs/dialog";
import { t } from "@/i18n";

export const createComfirmDeleteClientDialog = () => {
  const { open, close, submit, Component } = createDialog({
    title: () => t("common.confirm_delete_client_dialog.title"),
    description: () =>
      t("common.confirm_delete_client_dialog.description"),
    content: () =>
      t("common.confirm_delete_client_dialog.content"),

    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.confirm")}
      </Button>
    ),
    cancel: <Button onClick={() => close()}>{t("common.action.cancel")}</Button>,
  });

  return { open, Component };
};
