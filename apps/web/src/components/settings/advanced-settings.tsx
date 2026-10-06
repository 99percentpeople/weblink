import {
  SettingSection,
  SettingHeading,
} from "./setting-layout";
import {
  SettingSwitch,
  SettingSlider,
} from "./setting-controls";
import { serverTurnCredentialsUrl } from "@/libs/application/ice-server-service";

import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";
import { setAppOptions } from "@/options";

import { appState } from "@/libs/state/app-state";
import NativeCaptureSettings from "./native-capture-settings";

export default function AdvancedSettings() {
  return (
    <SettingSection
      id="advanced-connection"
      title={t(
        "setting.advanced_settings.advanced_connection.title",
      )}
    >
      <SettingSwitch
        checked={appState.options.relayOnly}
        disabled={
          !serverTurnCredentialsUrl &&
          appState.options.servers.turns.length === 0
        }
        onChange={(isChecked) =>
          setAppOptions("relayOnly", isChecked)
        }
        label={t(
          "setting.advanced_settings.advanced_connection.relay_only.title",
        )}
        description={t(
          "setting.advanced_settings.advanced_connection.relay_only.description",
        )}
      />
      <SettingHeading id="advanced-sender">
        {t(
          "setting.advanced_settings.advanced_sender.title",
        )}
      </SettingHeading>
      <SettingSlider
        minValue={Math.max(
          appState.options.blockSize,
          128 * 1024,
        )}
        maxValue={10 * 1024 * 1024}
        step={128 * 1024}
        defaultValue={[appState.options.chunkSize]}
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 2)
        }
        onChange={(value) => {
          setAppOptions("chunkSize", value[0]);
        }}
        label={t("setting.sender.chunk_size.title")}
      />
      <SettingSlider
        minValue={16 * 1024}
        maxValue={192 * 1024}
        step={16 * 1024}
        defaultValue={[appState.options.blockSize]}
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 0)
        }
        onChange={(value) => {
          setAppOptions("blockSize", value[0]);
        }}
        label={t("setting.sender.block_size.title")}
      />
      <SettingSlider
        minValue={256 * 1024}
        maxValue={16 * 1024 * 1024}
        step={256 * 1024}
        defaultValue={[
          appState.options.bufferedAmountHighWaterMark,
        ]}
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 2)
        }
        onChange={(value) => {
          setAppOptions(
            "bufferedAmountHighWaterMark",
            value[0],
          );
        }}
        label={t("setting.sender.max_buffer_amount.title")}
      />
      <SettingSwitch
        checked={appState.options.ordered}
        onChange={(isChecked) =>
          setAppOptions("ordered", isChecked)
        }
        label={t("setting.sender.ordered.title")}
        description={t(
          "setting.sender.ordered.description",
        )}
      />
      <SettingHeading id="advanced-receiver">
        {t(
          "setting.advanced_settings.advanced_receiver.title",
        )}
      </SettingHeading>
      <SettingSlider
        minValue={1}
        maxValue={128}
        step={1}
        defaultValue={[
          appState.options.maxMomeryCacheSlices,
        ]}
        getValueLabel={({ values }) =>
          `${values[0]} (${formatBtyeSize(values[0] * appState.options.chunkSize, 0)})`
        }
        onChange={(value) => {
          setAppOptions("maxMomeryCacheSlices", value[0]);
        }}
        label={t(
          "setting.receiver.max_cached_chunks.title",
        )}
        description={t(
          "setting.receiver.max_cached_chunks.description",
        )}
      />
      <NativeCaptureSettings />
    </SettingSection>
  );
}
