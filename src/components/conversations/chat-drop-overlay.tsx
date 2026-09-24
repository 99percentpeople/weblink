import { createMemo, Show } from "solid-js";
import type { DropAreaState } from "@/components/drop-area";
import {
  IconClose,
  IconPlaceItem,
} from "@/components/icons";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import { t } from "@/i18n";

export function ChatDropOverlay(props: {
  state: DropAreaState;
}) {
  // Keep the last drag state while fading out instead of flashing rejection.
  const accepted = createMemo<boolean>(
    (previous) =>
      props.state.active ? props.state.accepted : previous,
    false,
  );
  return (
    <AnimatePresence when={props.state.active}>
      <Motion.div
        native
        data-slot="chat-drop-overlay"
        aria-hidden="true"
        inert={!props.state.active}
        // Own hit testing during a file drag so native controls underneath
        // cannot change the cursor. Release it immediately on exit, even
        // while AnimatePresence keeps this node mounted for the fade-out.
        style={{
          "pointer-events": props.state.active
            ? "auto"
            : "none",
          cursor: accepted() ? "copy" : "not-allowed",
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        class="bg-background/70 absolute inset-0 z-30 grid
          place-items-center p-4 select-none [&_*]:pointer-events-none"
      >
        <div
          class="text-muted-foreground flex flex-col items-center gap-3
            text-center"
        >
          <Show
            when={accepted()}
            fallback={<IconClose class="size-12" />}
          >
            <IconPlaceItem class="size-12" />
          </Show>
          <span class="text-sm">
            {t(
              accepted()
                ? "conversations.file_drop.title"
                : "conversations.file_drop.unavailable_title",
            )}
          </span>
        </div>
      </Motion.div>
    </AnimatePresence>
  );
}
