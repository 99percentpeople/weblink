import { Show } from "solid-js";
import { ChevronDown, ChevronUp } from "lucide-solid";

/** Shared by the thumbnail rail and the collapsed toolbar dock. */
export function MeetingCollapseButton(props: {
  ref?: (button: HTMLButtonElement) => void;
  expanded: boolean;
  label: string;
  controls?: string;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <button
      ref={props.ref}
      type="button"
      class="meeting-thumbnails-toggle"
      aria-controls={props.controls}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      onClick={() => props.onToggle()}
    >
      <Show when={props.expanded} fallback={<ChevronUp />}>
        <ChevronDown />
      </Show>
      <span>{props.label}</span>
    </button>
  );
}
