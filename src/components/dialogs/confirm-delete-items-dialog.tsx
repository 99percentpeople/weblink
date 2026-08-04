import { createSignal } from "solid-js";
import { For } from "solid-js";
import { createDialog } from "./dialog";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";

export const createComfirmDeleteItemsDialog = () => {
  const [names, setNames] = createSignal<string[]>([]);
  const {
    open: openDeleteDialog,
    close,
    submit,
  } = createDialog<boolean>({
    title: () =>
      t("common.confirm_delete_files_dialog.title"),
    description: () =>
      t("common.confirm_delete_files_dialog.description", {
        count: names().length,
      }),
    content: () => (
      <div>
        <ul class="text-nowrap text-ellipsis">
          <For each={names()}>
            {(name) => <li class="text-sm">{name}</li>}
          </For>
        </ul>
      </div>
    ),

    cancel: (
      <Button onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.confirm")}
      </Button>
    ),
  });

  const open = async (names: string[]) => {
    setNames(names);
    return await openDeleteDialog();
  };

  return { open };
};
