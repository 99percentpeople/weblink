import { mapArray, Show } from "solid-js";
import { Keyboard, KeyboardOff } from "lucide-solid";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import { createControlState } from "./remote-control-action";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

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
    <Show when={controlling().some((active) => active())}>
      <span
        class="bg-input h-[18px] w-px shrink-0"
        aria-hidden="true"
      />
      <Switch
        class="flex shrink-0 items-center gap-1.5"
        title={label()}
        checked={enabled()}
        onChange={(value) =>
          setAppOptions("remoteKeyboard", "enabled", value)
        }
      >
        <SwitchLabel
          class="flex min-w-0 cursor-pointer items-center gap-[7px]
            text-[12px] font-medium max-md:text-[11px] sm:text-[12px]"
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
          <span class="sr-only">
            {t("remote_control.keyboard_control")}
          </span>
        </SwitchLabel>
        <SwitchControl class="h-5 w-9 bg-[#ffffff26] data-[checked]:bg-[#365889]">
          <SwitchThumb class="size-4 bg-[#d4e3ff] data-[checked]:translate-x-4" />
        </SwitchControl>
      </Switch>
    </Show>
  );
}
