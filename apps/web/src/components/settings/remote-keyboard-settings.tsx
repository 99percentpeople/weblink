import {
  SettingSwitch,
  SettingShortcut,
} from "./setting-controls";
import { Show } from "solid-js";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { setAppOptions } from "@/options";

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
      <SettingSwitch
        checked={keyboard().enabled}
        onChange={(value) =>
          setAppOptions("remoteKeyboard", "enabled", value)
        }
        label={t("setting.remote_control.keyboard.title")}
        description={t(
          "setting.remote_control.keyboard.description",
        )}
      />
      <SettingSwitch
        checked={keyboard().autoShow}
        disabled={!keyboard().enabled}
        onChange={(value) =>
          setAppOptions("remoteKeyboard", "autoShow", value)
        }
        label={t(
          "setting.remote_control.auto_keyboard.title",
        )}
        description={t(
          "setting.remote_control.auto_keyboard.description",
        )}
      />
      <SettingSwitch
        checked={keyboard().collapseControls}
        onChange={(value) =>
          setAppOptions(
            "remoteKeyboard",
            "collapseControls",
            value,
          )
        }
        label={t(
          "setting.remote_control.keyboard_collapse.title",
        )}
        description={t(
          "setting.remote_control.keyboard_collapse.description",
        )}
      />
      <Show when={systemKeyboard()}>
        <SettingSwitch
          checked={keyboard().systemKeys}
          onChange={(value) =>
            setAppOptions(
              "remoteKeyboard",
              "systemKeys",
              value,
            )
          }
          label={t(
            "setting.remote_control.system_keyboard.title",
          )}
          description={t(
            "setting.remote_control.system_keyboard.description",
          )}
        />
      </Show>
      <SettingShortcut
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
        description={
          <>
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
          </>
        }
      />
      <Show when={hostShortcut()}>
        <SettingShortcut
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
          description={t(
            "setting.remote_control.emergency_shortcut.description",
          )}
        />
      </Show>
    </>
  );
}
