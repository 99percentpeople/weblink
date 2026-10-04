import { Show } from "solid-js";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { setAppOptions } from "@/options";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  exitControlShortcutLabel,
  exitControlShortcuts,
  resolveRemoteKeyboardOptions,
  type ExitControlShortcut,
} from "@/libs/domain/remote-control/keyboard-options";

export default function RemoteKeyboardSettings() {
  const capabilities = useAppState().runtimeCapabilities;
  const systemKeyboard = () =>
    !!platform.keyboard &&
    capabilities()?.systemKeyboard === true;
  const hostShortcut = () =>
    capabilities()?.os === "windows" &&
    capabilities()?.remoteInput;
  const keyboard = () =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    );
  return (
    <>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex w-full items-center justify-between gap-3"
          checked={keyboard().enabled}
          onChange={(value) =>
            setAppOptions(
              "remoteKeyboard",
              "enabled",
              value,
            )
          }
        >
          <SwitchLabel>
            {t("setting.remote_control.keyboard.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.remote_control.keyboard.description")}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex w-full items-center justify-between gap-3"
          checked={keyboard().autoShow}
          disabled={!keyboard().enabled}
          onChange={(value) =>
            setAppOptions(
              "remoteKeyboard",
              "autoShow",
              value,
            )
          }
        >
          <SwitchLabel>
            {t(
              "setting.remote_control.auto_keyboard.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.remote_control.auto_keyboard.description",
          )}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex w-full items-center justify-between gap-3"
          checked={keyboard().collapseControls}
          onChange={(value) =>
            setAppOptions(
              "remoteKeyboard",
              "collapseControls",
              value,
            )
          }
        >
          <SwitchLabel>
            {t(
              "setting.remote_control.keyboard_collapse.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.remote_control.keyboard_collapse.description",
          )}
        </p>
      </div>
      <Show when={systemKeyboard()}>
        <div class="flex flex-col gap-2">
          <Switch
            class="flex w-full items-center justify-between gap-3"
            checked={keyboard().systemKeys}
            onChange={(value) =>
              setAppOptions(
                "remoteKeyboard",
                "systemKeys",
                value,
              )
            }
          >
            <SwitchLabel>
              {t(
                "setting.remote_control.system_keyboard.title",
              )}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <p class="muted">
            {t(
              "setting.remote_control.system_keyboard.description",
            )}
          </p>
        </div>
      </Show>
      <div class="flex flex-col gap-2">
        <Label id="exit-control-shortcut">
          {t("setting.remote_control.exit_shortcut.title")}
        </Label>
        <Select<ExitControlShortcut>
          modal
          disallowEmptySelection
          options={[...exitControlShortcuts]}
          value={keyboard().exitShortcut}
          onChange={(value) =>
            value &&
            setAppOptions(
              "remoteKeyboard",
              "exitShortcut",
              value,
            )
          }
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {exitControlShortcutLabel(
                props.item.rawValue,
              )}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-labelledby="exit-control-shortcut">
            <SelectValue<ExitControlShortcut>>
              {(state) =>
                exitControlShortcutLabel(
                  state.selectedOption(),
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">
          {t(
            "setting.remote_control.exit_shortcut.description",
          )}{" "}
          {t(
            platform.kind === "browser"
              ? "setting.remote_control.exit_shortcut.browser"
              : systemKeyboard() &&
                  keyboard().enabled &&
                  keyboard().systemKeys
                ? "setting.remote_control.exit_shortcut.native"
                : "setting.remote_control.exit_shortcut.webview",
          )}
          <Show when={hostShortcut()}>
            {" "}
            {t("setting.remote_control.exit_shortcut.host")}
          </Show>
        </p>
      </div>
    </>
  );
}
