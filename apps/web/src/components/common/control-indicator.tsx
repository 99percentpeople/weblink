import { Show } from "solid-js";
import { MousePointer2 } from "lucide-solid";
import type { NativeControlStatus } from "@weblink/platform";
import { AutomationPointerIcon } from "./automation-pointer-icon";

/** Public/native status wins over controller-only knowledge from older peers. */
export function isAutomationControl(
  status:
    | Pick<
        NativeControlStatus,
        "controllerKind" | "automationActive"
      >
    | undefined,
  legacyAutomation = false,
): boolean {
  return (
    status?.controllerKind === "automation" ||
    (status?.automationActive ?? legacyAutomation)
  );
}

/** One decorative control glyph for both picture labels and status pills. */
export function ControlIndicatorIcon(props: {
  automation?: boolean;
  class?: string;
}) {
  return (
    <Show
      when={props.automation}
      fallback={
        <MousePointer2
          class={props.class}
          aria-hidden="true"
        />
      }
    >
      <AutomationPointerIcon
        class={props.class}
        aria-hidden="true"
      />
    </Show>
  );
}
