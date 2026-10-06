import { SettingHeading } from "./setting-layout";
import { SettingSelect } from "./setting-controls";
import { createMemo } from "solid-js";

import { useAppState } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";
import AudioCodecSelect from "./audio-codec-select";

export default function BrowserEncodingSettings() {
  const capabilities = useAppState().mediaCapabilities;
  const canGetRtpCapabilities = () =>
    capabilities.browserVideoCodecs().length > 0;
  const preferredVideoCodecOptions = createMemo(() => [
    "auto",
    ...new Set(capabilities.browserVideoCodecs()),
  ]);
  return (
    <div class="setting-group">
      <SettingHeading
        description={t(
          "setting.meeting_settings.browser_encoding_description",
        )}
      >
        {t("setting.meeting_settings.browser_encoding")}
      </SettingHeading>

      <SettingSelect<string>
        modal
        value={
          appState.options.preferredVideoCodec ?? "auto"
        }
        disabled={!canGetRtpCapabilities()}
        onChange={(value) => {
          setAppOptions(
            "preferredVideoCodec",
            value === "auto" ? null : value,
          );
        }}
        options={preferredVideoCodecOptions()}
        label={t(
          "setting.meeting_settings.stream.preferred_video_codec.title",
        )}
        optionLabel={(option) =>
          option === "auto"
            ? t(
                "setting.meeting_settings.stream.preferred_video_codec.auto",
              )
            : option
        }
      />
      <AudioCodecSelect
        title={t(
          "setting.meeting_settings.audio.codec.title",
        )}
        codecs={capabilities.browserAudioCodecs()}
        value={appState.options.preferredAudioCodec}
        onChange={(value) =>
          setAppOptions("preferredAudioCodec", value)
        }
      />
    </div>
  );
}
