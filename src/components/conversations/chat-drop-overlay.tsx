import type { DropAreaState } from "@/components/drop-area";
import { FileDropOverlay } from "@/components/file-drop-overlay";
import { t } from "@/i18n";

export function ChatDropOverlay(props: {
  state: DropAreaState;
}) {
  return (
    <FileDropOverlay
      state={props.state}
      data-slot="chat-drop-overlay"
      title={t("conversations.file_drop.title")}
      unavailableTitle={t(
        "conversations.file_drop.unavailable_title",
      )}
    />
  );
}
