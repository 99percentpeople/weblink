import { t } from "@/i18n";
import {
  Checkbox,
  CheckboxControl,
} from "@/components/ui/checkbox";
import { createSignal, Show } from "solid-js";
import { createDialog } from "./dialog";
import { Button } from "@/components/ui/button";

export interface DeleteFileMessageDialogOptions {
  fileName: string;
  hasTransfer: boolean;
  hasCache: boolean;
}

export interface DeleteFileMessageResult {
  deleteTransfer: boolean;
  deleteCache: boolean;
}

export const createDeleteFileMessageDialog = () => {
  const [fileName, setFileName] = createSignal("");
  const [hasTransfer, setHasTransfer] =
    createSignal(false);
  const [hasCache, setHasCache] = createSignal(false);
  const [deleteTransfer, setDeleteTransfer] =
    createSignal(false);
  const [deleteCache, setDeleteCache] =
    createSignal(false);

  const {
    open: openDialog,
    close,
    submit,
  } = createDialog<DeleteFileMessageResult>({
    title: () =>
      t("common.delete_file_message_dialog.title"),
    description: () =>
      t("common.delete_file_message_dialog.description"),
    content: () => (
      <div class="flex flex-col gap-3">
        <p class="text-sm break-all">{fileName()}</p>
        <Show when={hasTransfer()}>
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={deleteTransfer()}
              onChange={(value) =>
                setDeleteTransfer(Boolean(value))
              }
            >
              <CheckboxControl />
            </Checkbox>
            <span>
              {t(
                "common.delete_file_message_dialog.delete_transfer",
              )}
            </span>
          </label>
        </Show>
        <Show when={hasCache()}>
          <label class="flex items-center gap-2 text-sm">
            <Checkbox
              checked={deleteCache()}
              onChange={(value) =>
                setDeleteCache(Boolean(value))
              }
            >
              <CheckboxControl />
            </Checkbox>
            <span>
              {t(
                "common.delete_file_message_dialog.delete_cache",
              )}
            </span>
          </label>
        </Show>
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
        onClick={() => {
          submit({
            deleteTransfer: deleteTransfer(),
            deleteCache: deleteCache(),
          });
        }}
      >
        {t("common.action.delete")}
      </Button>
    ),
  });

  const open = async (
    options: DeleteFileMessageDialogOptions,
  ) => {
    setFileName(options.fileName);
    setHasTransfer(options.hasTransfer);
    setHasCache(options.hasCache);
    setDeleteTransfer(false);
    setDeleteCache(false);
    return await openDialog();
  };

  return {
    open,
  };
};
