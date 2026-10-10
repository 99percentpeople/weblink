import {
  createSignal,
  mapArray,
  onCleanup,
  Show,
} from "solid-js";
import { Gamepad2 } from "lucide-solid";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import { RemoteKeyboardToggle } from "./remote-keyboard-toggle";
import { RemoteInputToggle } from "./remote-input-toggle";

export function RemoteInputToggles(props: {
  controls: readonly RemotePointer[];
}) {
  const controls = mapArray(
    () => props.controls,
    (control) => {
      const snapshot = () => ({
        active:
          control.state() === "active" ||
          control.state() === "activating",
        slots: control.gamepadSlots(),
      });
      const [state, setState] = createSignal(snapshot());
      const changed = () => setState(snapshot());
      control.addEventListener("change", changed);
      onCleanup(() =>
        control.removeEventListener("change", changed),
      );
      return state;
    },
  );
  const available = () =>
    controls().some(
      (state) => state().active && state().slots > 0,
    );
  const enabled = () =>
    appState.options.remoteGamepad.enabled;
  return (
    <>
      <RemoteKeyboardToggle controls={props.controls} />
      <Show
        when={
          appState.capabilities.localInput.gamepadCount >
            0 && controls().some((state) => state().active)
        }
      >
        <RemoteInputToggle
          checked={enabled()}
          disabled={!available()}
          label={t("setting.remote_control.gamepad.title")}
          title={t(
            !available()
              ? "remote_control.gamepad_unavailable"
              : enabled()
                ? "remote_control.gamepad_disable"
                : "remote_control.gamepad_enable",
          )}
          onChange={(value) =>
            setAppOptions("remoteGamepad", "enabled", value)
          }
        >
          <Gamepad2
            class="size-4 shrink-0"
            classList={{
              "text-primary": enabled() && available(),
              "text-muted-foreground":
                !enabled() || !available(),
            }}
            aria-hidden="true"
          />
        </RemoteInputToggle>
      </Show>
    </>
  );
}
