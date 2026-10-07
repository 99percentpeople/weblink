import {
  SettingSection,
  SettingHeading,
} from "./setting-layout";
import {
  SettingSelect,
  SettingSwitch,
  SettingSlider,
} from "./setting-controls";
import { For, Show } from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { resolveRemoteFileLimit } from "@/libs/domain/protocol/remote-file-limits";

import {
  TOUCH_SAMPLE_RATES,
  resolveRemoteTouchOptions,
  type LongPressAction,
  type ThreeFingerTapAction,
  type TouchMode,
  type TouchSampleRate,
} from "@/libs/domain/remote-control/touch-options";

import {
  resolveRemotePointerOptions,
  type RemotePointerMode,
} from "@/libs/domain/remote-control/pointer-options";
import {
  resolveRemoteKeyboardOptions,
  type ClipboardFileDestination,
} from "@/libs/domain/remote-control/keyboard-options";
import RemoteKeyboardSettings from "./remote-keyboard-settings";

export default function RemoteControlSettings() {
  const clipboardAccess = appState.capabilities.clipboard;
  const options = () =>
    resolveRemoteTouchOptions(appState.options.remoteTouch);
  const pointer = () =>
    resolveRemotePointerOptions(
      appState.options.remotePointer,
    );
  const clipboardEnabled = () =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ).clipboard;
  const prefix = "setting.remote_control.";
  const mebibyte = 1024 * 1024;
  const fileLimit = () =>
    resolveRemoteFileLimit(
      appState.options.remoteFileMaxSize,
    ) / mebibyte;
  const toggle = (
    key:
      | "tapToClick"
      | "twoFingerRightClick"
      | "twoFingerScroll"
      | "twoFingerZoom"
      | "naturalScroll"
      | "forwardProperties",
  ) => (
    <SettingSwitch
      checked={options()[key]}
      onChange={(value) =>
        setAppOptions("remoteTouch", key, value)
      }
      disabled={
        key === "naturalScroll" &&
        !options().twoFingerScroll
      }
      label={t(`${prefix}${key}`)}
      description={
        key === "forwardProperties"
          ? t(`${prefix}touch_properties_description`)
          : undefined
      }
    />
  );
  return (
    <SettingSection
      id="remote-control-settings"
      title={t("app_menu.settings_remote_control")}
    >
      <SettingHeading>
        {t(`${prefix}pointer_heading`)}
      </SettingHeading>
      <SettingSelect<RemotePointerMode>
        modal
        disallowEmptySelection
        options={["local", "capture"]}
        value={pointer().mode}
        onChange={(value) =>
          value &&
          setAppOptions("remotePointer", "mode", value)
        }
        label={t(`${prefix}pointer.title`)}
        renderValue={(state) =>
          t(`${prefix}pointer.${state.selectedOption()}`)
        }
        description={t(
          `${prefix}pointer.${pointer().mode}_description`,
        )}
        optionLabel={(option) =>
          t(`${prefix}pointer.${option}`)
        }
      />
      <SettingSwitch
        checked={pointer().syncCursor}
        disabled={pointer().mode !== "local"}
        onChange={(value) =>
          setAppOptions(
            "remotePointer",
            "syncCursor",
            value,
          )
        }
        label={t(`${prefix}cursor_sync.title`)}
        description={t(`${prefix}cursor_sync.description`)}
      />
      <SettingHeading>
        {t(`${prefix}keyboard_heading`)}
      </SettingHeading>
      <RemoteKeyboardSettings />
      <SettingHeading
        description={t(`${prefix}description`)}
      >
        {t(`${prefix}touch_heading`)}
      </SettingHeading>

      <SettingSelect<TouchMode>
        modal
        disallowEmptySelection
        value={options().mode}
        onChange={(value) =>
          value &&
          setAppOptions("remoteTouch", "mode", value)
        }
        options={["trackpad", "direct"]}
        label={t(`${prefix}mode.title`)}
        description={t(
          `${prefix}mode.${options().mode}_description`,
        )}
        optionLabel={(option) =>
          t(`${prefix}mode.${option}`)
        }
      />
      <SettingSelect<TouchSampleRate>
        modal
        disallowEmptySelection
        options={[...TOUCH_SAMPLE_RATES]}
        value={options().sampleRate}
        onChange={(value) =>
          value &&
          setAppOptions("remoteTouch", "sampleRate", value)
        }
        label={t(`${prefix}sample_rate.title`)}
        renderValue={(state) =>
          `${state.selectedOption()} Hz`
        }
        description={t(`${prefix}sample_rate.description`)}
        optionLabel={(option) => <>{option} Hz</>}
      />
      <Show when={options().mode === "direct"}>
        {toggle("forwardProperties")}
      </Show>
      <Show when={options().mode === "trackpad"}>
        <SettingSlider
          minValue={0.25}
          maxValue={3}
          step={0.05}
          value={[options().pointerSpeed]}
          onChange={(value) =>
            setAppOptions(
              "remoteTouch",
              "pointerSpeed",
              value[0],
            )
          }
          getValueLabel={({ values }) =>
            `${values[0].toFixed(2)}×`
          }
          label={t(`${prefix}pointer_speed`)}
        />
        {toggle("tapToClick")}
        <SettingSelect<LongPressAction>
          modal
          disallowEmptySelection
          value={options().longPress}
          onChange={(value) =>
            value &&
            setAppOptions("remoteTouch", "longPress", value)
          }
          options={["drag", "right-click", "none"]}
          label={t(`${prefix}long_press.title`)}
          optionLabel={(option) =>
            t(`${prefix}long_press.${option}`)
          }
        />
        <For
          each={
            [
              "twoFingerRightClick",
              "twoFingerScroll",
              "twoFingerZoom",
              "naturalScroll",
            ] as const
          }
        >
          {toggle}
        </For>
        <SettingSlider
          minValue={0.25}
          maxValue={3}
          step={0.05}
          value={[options().scrollSpeed]}
          disabled={!options().twoFingerScroll}
          onChange={(value) =>
            setAppOptions(
              "remoteTouch",
              "scrollSpeed",
              value[0],
            )
          }
          getValueLabel={({ values }) =>
            `${values[0].toFixed(2)}×`
          }
          label={t(`${prefix}scroll_speed`)}
        />
        <SettingSelect<ThreeFingerTapAction>
          modal
          disallowEmptySelection
          value={options().threeFingerTap}
          onChange={(value) =>
            value &&
            setAppOptions(
              "remoteTouch",
              "threeFingerTap",
              value,
            )
          }
          options={["keyboard", "none"]}
          label={t(`${prefix}three_finger_tap.title`)}
          description={t(
            `${prefix}three_finger_tap.description`,
          )}
          optionLabel={(option) =>
            t(`${prefix}three_finger_tap.${option}`)
          }
        />
      </Show>
      <SettingHeading>
        {t(`${prefix}general_heading`)}
      </SettingHeading>
      <SettingSwitch
        checked={pointer().fileDrop}
        onChange={(value) =>
          setAppOptions("remotePointer", "fileDrop", value)
        }
        label={t(`${prefix}file_drop.title`)}
        description={t(`${prefix}file_drop.description`)}
      />
      <SettingSwitch
        checked={clipboardEnabled()}
        onChange={(value) =>
          setAppOptions(
            "remoteKeyboard",
            "clipboard",
            value,
          )
        }
        label={t("setting.remote_control.clipboard.title")}
        description={t(
          "setting.remote_control.clipboard.description",
        )}
      />
      <SettingSelect<ClipboardFileDestination>
        modal
        disallowEmptySelection
        placeholder={t(`${prefix}clipboard_files.loading`)}
        disabled={
          !clipboardEnabled() || !clipboardAccess.ready
        }
        value={
          resolveRemoteKeyboardOptions(
            appState.options.remoteKeyboard,
          ).clipboardFiles
        }
        onChange={(value) =>
          value &&
          (value !== "clipboard" ||
            clipboardAccess.writeFiles) &&
          setAppOptions(
            "remoteKeyboard",
            "clipboardFiles",
            value,
          )
        }
        options={["clipboard", "cache", "off"]}
        optionDisabled={(value) =>
          value === "clipboard" &&
          !clipboardAccess.writeFiles
        }
        label={t(`${prefix}clipboard_files.title`)}
        description={t(
          `${prefix}clipboard_files.description`,
        )}
        hint={
          <>
            <Show
              when={
                clipboardEnabled() &&
                clipboardAccess.ready &&
                !clipboardAccess.writeFiles
              }
            >
              <p class="muted">
                {t(`${prefix}clipboard_files.unavailable`)}
              </p>
            </Show>
          </>
        }
        optionLabel={(option) =>
          t(`${prefix}clipboard_files.${option}`)
        }
      />
      <SettingSelect<number>
        modal
        disallowEmptySelection
        label={t(`${prefix}file_size_limit.title`)}
        description={t(
          `${prefix}file_size_limit.description`,
        )}
        options={[
          ...new Set([
            1,
            5,
            10,
            20,
            32,
            64,
            128,
            256,
            512,
            fileLimit(),
          ]),
        ].sort((a, b) => a - b)}
        value={fileLimit()}
        optionLabel={(value) => `${value} MiB`}
        onChange={(value) => {
          if (value !== null)
            setAppOptions(
              "remoteFileMaxSize",
              value * mebibyte,
            );
        }}
      />
      <p class="muted">{t(`${prefix}changes`)}</p>
    </SettingSection>
  );
}
