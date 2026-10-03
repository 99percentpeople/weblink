import { createMemo } from "solid-js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
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
    <div class="flex flex-col gap-5">
      <h3 class="h3">
        {t("setting.meeting_settings.browser_encoding")}
      </h3>
      <p class="muted">
        {t(
          "setting.meeting_settings.browser_encoding_description",
        )}
      </p>
      <label class="flex flex-col gap-2">
        <Label>
          {t(
            "setting.meeting_settings.stream.preferred_video_codec.title",
          )}
        </Label>
        <Select
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
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {props.item.rawValue === "auto"
                ? t(
                    "setting.meeting_settings.stream.preferred_video_codec.auto",
                  )
                : props.item.rawValue}
            </SelectItem>
          )}
        >
          <SelectTrigger
            aria-label={t(
              "setting.meeting_settings.stream.preferred_video_codec.title",
            )}
          >
            <SelectValue<string>>
              {(state) =>
                state.selectedOption() === "auto"
                  ? t(
                      "setting.meeting_settings.stream.preferred_video_codec.auto",
                    )
                  : state.selectedOption()
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </label>
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
