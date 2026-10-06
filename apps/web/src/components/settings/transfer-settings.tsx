import {
  SettingSection,
  SettingHeading,
} from "./setting-layout";
import {
  SettingSwitch,
  SettingSlider,
  SettingSelect,
} from "./setting-controls";
import { Show } from "solid-js";

import { t } from "@/i18n";
import { setAppOptions, CompressionLevel } from "@/options";

import { appState } from "@/libs/state/app-state";

export default function TransferSettings() {
  const megabyte = 1024 * 1024;
  return (
    <SettingSection
      id="sender"
      title={t("setting.sender.title")}
    >
      <SettingSwitch
        disabled={!navigator.clipboard}
        checked={appState.options.enableClipboard}
        onChange={(isChecked) =>
          setAppOptions("enableClipboard", isChecked)
        }
        label={t("setting.sender.enable_clipboard.title")}
        description={t(
          "setting.sender.enable_clipboard.description",
        )}
        hint={
          <>
            <Show when={!navigator.clipboard}>
              <p class="text-destructive-foreground text-xs">
                {t(
                  "setting.sender.enable_clipboard.unsupported",
                )}
              </p>
            </Show>
          </>
        }
      />
      <SettingSwitch
        checked={appState.options.automaticCacheDeletion}
        onChange={(isChecked) =>
          setAppOptions("automaticCacheDeletion", isChecked)
        }
        label={t(
          "setting.sender.automatic_cache_deletion.title",
        )}
        description={t(
          "setting.sender.automatic_cache_deletion.description",
        )}
      />
      <SettingSlider
        minValue={0}
        maxValue={9}
        step={1}
        defaultValue={[appState.options.compressionLevel]}
        getValueLabel={({ values }) =>
          values[0] === 0
            ? t(
                "setting.sender.compression_level.no_compression",
              )
            : `${values[0]}`
        }
        onChange={(value) => {
          setAppOptions(
            "compressionLevel",
            value[0] as CompressionLevel,
          );
        }}
        label={t("setting.sender.compression_level.title")}
        description={t(
          "setting.sender.compression_level.description",
        )}
      />
      <SettingHeading id="receiver">
        {t("setting.receiver.title")}
      </SettingHeading>
      <SettingSelect<number>
        modal
        disallowEmptySelection
        value={
          appState.options.autoDownloadMaxSize / megabyte
        }
        options={[
          ...new Set([
            1,
            5,
            10,
            20,
            50,
            100,
            appState.options.autoDownloadMaxSize / megabyte,
          ]),
        ].sort((a, b) => a - b)}
        onChange={(size) => {
          if (size !== null)
            setAppOptions(
              "autoDownloadMaxSize",
              size * megabyte,
            );
        }}
        label={t(
          "setting.receiver.auto_download_limit.title",
        )}
        renderValue={(state) =>
          `${state.selectedOption()} MB`
        }
        description={t(
          "setting.receiver.auto_download_limit.description",
        )}
        optionLabel={(option) => <>{option} MB</>}
      />
      <SettingSwitch
        checked={appState.options.automaticDownload}
        onChange={(isChecked) =>
          setAppOptions("automaticDownload", isChecked)
        }
        label={t(
          "setting.receiver.automatic_download.title",
        )}
        description={t(
          "setting.receiver.automatic_download.description",
        )}
      />
    </SettingSection>
  );
}
