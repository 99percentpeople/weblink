import {
  createEffect,
  createMemo,
  createSignal,
  on,
} from "solid-js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  FileBrowser,
  useLibraryFiles,
} from "./file-browser";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";

export default function FilePickerDialog(props: {
  open: boolean;
  onClose(): void;
  onCloseAutoFocus?(event: Event): void;
  onSelect(ids: string[]): void;
  disabled?: boolean;
}) {
  const [selection, setSelection] = createSignal<string[]>(
    [],
  );
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) setSelection([]);
      },
    ),
  );
  const files = useLibraryFiles();
  const selected = createMemo(() =>
    files().filter(
      (file) =>
        selection().includes(file.id) &&
        file.isComplete &&
        file.file,
    ),
  );
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <DialogContent
        class="flex h-[min(42rem,90dvh)] min-h-0 flex-col sm:max-w-3xl"
        onCloseAutoFocus={props.onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>
            {t("file_library.choose")}
          </DialogTitle>
          <DialogDescription>
            {t("file_library.choose_hint")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <FileBrowser
            picker
            selected={selection()}
            onSelection={setSelection}
          />
        </DialogBody>
        <DialogFooter class="items-center">
          <span class="text-muted-foreground mr-auto text-xs">
            {t("file_library.selection", {
              count: selected().length,
              size: formatBtyeSize(
                selected().reduce(
                  (sum, file) => sum + file.fileSize,
                  0,
                ),
              ),
            })}
          </span>
          <Button variant="outline" onClick={props.onClose}>
            {t("common.action.cancel")}
          </Button>
          <Button
            disabled={props.disabled || !selected().length}
            onClick={() =>
              props.onSelect(
                selected().map((file) => file.id),
              )
            }
          >
            {t("file_library.send_count", {
              count: selected().length,
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
