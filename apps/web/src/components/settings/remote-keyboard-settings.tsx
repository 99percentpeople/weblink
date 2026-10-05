import { Show } from "solid-js";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { setAppOptions } from "@/options";
import { ShortcutInput } from "@/components/ui/shortcut-input";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  defaultRemoteKeyboardOptions,
  resolveRemoteKeyboardOptions,
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
        <ShortcutInput
          label={t(
            "setting.remote_control.exit_shortcut.title",
          )}
          value={keyboard().exitShortcut}
          defaultValue={
            defaultRemoteKeyboardOptions.exitShortcut
          }
          onChange={(value) => {
            if (
              hostShortcut() &&
              value === keyboard().emergencyShortcut
            )
              throw new Error(
                t("setting.shortcut_input.duplicate"),
              );
            setAppOptions(
              "remoteKeyboard",
              "exitShortcut",
              value,
            );
          }}
        />
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
        </p>
      </div>
      <Show when={hostShortcut()}>
        <div class="flex flex-col gap-2">
          <ShortcutInput
            label={t(
              "setting.remote_control.emergency_shortcut.title",
            )}
            value={keyboard().emergencyShortcut}
            defaultValue={
              defaultRemoteKeyboardOptions.emergencyShortcut
            }
            onChange={async (value) => {
              if (value === keyboard().exitShortcut)
                throw new Error(
                  t("setting.shortcut_input.duplicate"),
                );
              try {
                if (
                  !platform.remoteControl?.configureShortcut
                )
                  throw new Error("Unavailable");
                await platform.remoteControl.configureShortcut(
                  value,
                );
              } catch {
                throw new Error(
                  t(
                    "setting.remote_control.emergency_shortcut.failed",
                  ),
                );
              }
              setAppOptions(
                "remoteKeyboard",
                "emergencyShortcut",
                value,
              );
            }}
          />
          <p class="muted">
            {t(
              "setting.remote_control.emergency_shortcut.description",
            )}
          </p>
        </div>
      </Show>
    </>
  );
}
