import { Show } from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { resolveRemoteFileLimit } from "@/libs/domain/protocol/remote-file-limits";
import { resolveRemotePointerOptions } from "@/libs/domain/remote-control/pointer-options";
import {
  resolveRemoteKeyboardOptions,
  type ClipboardFileDestination,
} from "@/libs/domain/remote-control/keyboard-options";
import {
  SettingSelect,
  SettingSwitch,
} from "./setting-controls";

export default function RemoteTransferSettings() {
  const clipboardAccess = appState.capabilities.clipboard;
  const pointer = () =>
    resolveRemotePointerOptions(
      appState.options.remotePointer,
    );
  const clipboardEnabled = () =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ).clipboard;
  const prefix = "setting.remote_transfer.";
  const mebibyte = 1024 * 1024;
  const fileLimit = () =>
    resolveRemoteFileLimit(
      appState.options.remoteFileMaxSize,
    ) / mebibyte;
  return (
    <>
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
        label={t("setting.remote_transfer.clipboard.title")}
        description={t(
          "setting.remote_transfer.clipboard.description",
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
    </>
  );
}
