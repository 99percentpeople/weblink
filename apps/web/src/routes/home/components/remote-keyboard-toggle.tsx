import { mapArray, Show } from "solid-js";
import { Keyboard, KeyboardOff } from "lucide-solid";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import { createControlState } from "./remote-control-action";
import { RemoteInputToggle } from "./remote-input-toggle";

export function RemoteKeyboardToggle(props: {
  controls: readonly RemotePointer[];
}) {
  const controlling = mapArray(
    () => props.controls,
    (control) => {
      const { state } = createControlState(() => control);
      return () => {
        const current = state();
        return (
          (current === "active" ||
            current === "activating") &&
          control.supportsKeyboard()
        );
      };
    },
  );
  const enabled = () =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ).enabled;
  const label = () =>
    t(
      enabled()
        ? "remote_control.keyboard_disable"
        : "remote_control.keyboard_enable",
    );
  return (
    <Show
      when={
        (!appState.capabilities.localInput.mobile ||
          appState.capabilities.localInput
            .keyboardObserved) &&
        controlling().some((active) => active())
      }
    >
      <RemoteInputToggle
        title={label()}
        checked={enabled()}
        label={t("remote_control.keyboard_control")}
        onChange={(value) =>
          setAppOptions("remoteKeyboard", "enabled", value)
        }
      >
        <Show
          when={enabled()}
          fallback={
            <KeyboardOff
              class="text-muted-foreground size-4 shrink-0"
              aria-hidden="true"
            />
          }
        >
          <Keyboard
            class="text-primary size-4 shrink-0"
            aria-hidden="true"
          />
        </Show>
      </RemoteInputToggle>
    </Show>
  );
}
