import { createMemo } from "solid-js";
import {
  Checkbox,
  CheckboxControl,
  CheckboxLabel,
} from "@/components/ui/checkbox";
import type { LibraryFile } from "@/libs/application/files/library-query";
import { t } from "@/i18n";

export function FileSelectionCheckbox(props: {
  files: readonly LibraryFile[];
  selected: readonly string[];
  onSelection(ids: string[]): void;
}) {
  const selectedIds = createMemo(
    () => new Set(props.selected),
  );
  const allSelected = createMemo(
    () =>
      props.files.length > 0 &&
      props.files.every((file) =>
        selectedIds().has(file.id),
      ),
  );
  return (
    <Checkbox
      class="text-muted-foreground relative flex items-center gap-3 px-2
        text-xs"
      checked={allSelected()}
      indeterminate={
        props.selected.length > 0 && !allSelected()
      }
      disabled={
        !props.files.length && !props.selected.length
      }
      onChange={(checked) =>
        props.onSelection(
          checked && props.files.length
            ? [
                ...new Set([
                  ...props.selected,
                  ...props.files.map((file) => file.id),
                ]),
              ]
            : [],
        )
      }
    >
      <CheckboxControl />
      <CheckboxLabel>
        {t("file_library.select_all")}
      </CheckboxLabel>
    </Checkbox>
  );
}
