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

export function FileDropOverlay(props: {
  state: DropAreaState;
  title: string;
  unavailableTitle: string;
  compact?: boolean;
  "data-slot"?: string;
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
        data-slot={
          props["data-slot"] ?? "file-drop-overlay"
        }
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
            fallback={
              <IconClose
                class={props.compact ? "size-7" : "size-12"}
              />
            }
          >
            <IconPlaceItem
              class={props.compact ? "size-7" : "size-12"}
            />
          </Show>
          <span class="text-sm">
            {accepted()
              ? props.title
              : props.unavailableTitle}
          </span>
        </div>
      </Motion.div>
    </AnimatePresence>
  );
}
