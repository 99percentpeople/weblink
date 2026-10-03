import { Show } from "solid-js";
import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
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
    <section
      class="settings-section"
      aria-labelledby="meeting"
    >
      <h3 id="meeting" class="h3">
        {t("app_menu.settings_meeting")}
      </h3>
      <h3 id="stream" class="h3">
        {t("setting.meeting_settings.stream.title")}
      </h3>
      <p class="muted">
        {t("setting.meeting_settings.capture_description")}
      </p>
      <VideoCaptureSettings
        frameRates={frameRates()}
        showDescription={false}
      />
      <label class="flex flex-col gap-2">
        <Slider
          minValue={128 * 1024}
          maxValue={150 * 1024 * 1024}
          step={128 * 1024}
          value={[appState.options.videoMaxBitrate]}
          getValueLabel={({ values }) =>
            `${formatBitSize(values[0], 0)}ps`
          }
          class="gap-2"
          onChange={(value) => {
            setAppOptions("videoMaxBitrate", value[0]);
          }}
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t(
                "setting.meeting_settings.stream.video_max_bitrate.title",
              )}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
      </label>
      <label class="flex flex-col gap-2">
        <Label>
          {t(
            "setting.meeting_settings.stream.degradation_preference.title",
          )}
        </Label>
        <Select
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
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {t(
                `setting.meeting_settings.stream.degradation_preference.${props.item.rawValue}`,
              )}
            </SelectItem>
          )}
        >
          <SelectTrigger
            aria-label={t(
              "setting.meeting_settings.stream.degradation_preference.title",
            )}
          >
            <SelectValue<RTCDegradationPreference>>
              {(state) =>
                t(
                  `setting.meeting_settings.stream.degradation_preference.${state.selectedOption()}`,
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </label>
      <BrowserEncodingSettings />
      <AudioSettings />
      <Show when={native() !== null}>
        <NativeMediaSettings available={native()!} />
      </Show>
    </section>
  );
}
