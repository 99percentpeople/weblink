import {
  SettingSection,
  SettingHeading,
} from "./setting-layout";
import {
  SettingSlider,
  SettingSelect,
} from "./setting-controls";
import { Show } from "solid-js";

import { formatBitSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";
import { setAppOptions } from "@/options";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import AudioSettings from "./audio-settings";
import BrowserEncodingSettings from "./browser-encoding-settings";
import VideoCaptureSettings from "./video-capture-settings";
import NativeMediaSettings from "./native-media-settings";

export default function MeetingSettings() {
  const capabilities = useAppState().mediaCapabilities;
  const native = capabilities.native;
  const frameRates = capabilities.frameRates;
  return (
    <SettingSection
      id="meeting"
      title={t("app_menu.settings_meeting")}
    >
      <SettingHeading
        id="stream"
        description={t(
          "setting.meeting_settings.capture_description",
        )}
      >
        {t("setting.meeting_settings.stream.title")}
      </SettingHeading>

      <VideoCaptureSettings
        frameRates={frameRates()}
        showDescription={false}
      />
      <SettingSlider
        minValue={128 * 1024}
        maxValue={150 * 1024 * 1024}
        step={128 * 1024}
        value={[appState.options.videoMaxBitrate]}
        getValueLabel={({ values }) =>
          `${formatBitSize(values[0], 0)}ps`
        }
        onChange={(value) => {
          setAppOptions("videoMaxBitrate", value[0]);
        }}
        label={t(
          "setting.meeting_settings.stream.video_max_bitrate.title",
        )}
      />
      <SettingSelect<RTCDegradationPreference>
        modal
        value={appState.options.degradationPreference}
        onChange={(value) => {
          setAppOptions(
            "degradationPreference",
            value ?? "balanced",
          );
        }}
        options={[
          "balanced",
          "maintain-framerate",
          "maintain-resolution",
        ]}
        label={t(
          "setting.meeting_settings.stream.degradation_preference.title",
        )}
        optionLabel={(option) =>
          t(
            `setting.meeting_settings.stream.degradation_preference.${option}`,
          )
        }
      />
      <BrowserEncodingSettings />
      <AudioSettings />
      <Show when={native() !== null}>
        <NativeMediaSettings available={native()!} />
      </Show>
    </SettingSection>
  );
}
