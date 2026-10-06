import { SettingHeading } from "./setting-layout";
import { SettingSelect } from "./setting-controls";
import { createMemo, For, Show } from "solid-js";
import { useAppState } from "@/libs/state/app-state-context";
import { audioSamplingChoices } from "@/libs/application/audio-sampling-capabilities";

import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { resolveAudioSampling } from "@/libs/application/meeting-audio-settings";
import AudioCodecSelect from "./audio-codec-select";

export default function AudioSettings() {
  const capabilities = useAppState().mediaCapabilities;
  const browserSampling = capabilities.browserSampling;
  const label = (key: string) =>
    t(`setting.meeting_settings.audio.${key}`);
  const sampling = () =>
    resolveAudioSampling(appState.options);
  const available = createMemo(() =>
    audioSamplingChoices(
      browserSampling(),
      capabilities.audioFormats(),
      sampling(),
    ),
  );
  return (
    <>
      <SettingHeading description={label("description")}>
        {label("title")}
      </SettingHeading>

      <Show when={capabilities.native() !== null}>
        <AudioCodecSelect
          title={t(
            "setting.meeting_settings.native_audio_codec",
          )}
          codecs={capabilities.audioCodecs()}
          loading={capabilities.audioCodecsLoading()}
          value={appState.options.nativeAudioCodec}
          onChange={(value) =>
            setAppOptions("nativeAudioCodec", value)
          }
        />
      </Show>
      <For each={["sample_rate", "channels"] as const}>
        {(kind) => {
          const name = () => label(`${kind}.title`);
          const value = () =>
            String(
              (kind === "sample_rate"
                ? sampling().audioSampleRate
                : sampling().audioChannelCount) ?? "auto",
            );
          const supported = () =>
            (kind === "sample_rate"
              ? available().sampleRates
              : available().channelCounts) ?? [];
          const options = () => [
            ...new Set([
              "auto",
              ...supported().map(String),
              value(),
            ]),
          ];
          const optionName = (value: string) =>
            value === "auto"
              ? label("auto")
              : kind === "sample_rate"
                ? `${Number(value) / 1000} kHz`
                : label(
                    value === "1"
                      ? "channels.mono"
                      : "channels.stereo",
                  );
          return (
            <SettingSelect<string>
              modal
              value={value()}
              options={options()}
              optionDisabled={(option) =>
                option !== "auto" &&
                !supported().includes(Number(option))
              }
              onChange={(value) => {
                if (
                  !value ||
                  (value !== "auto" &&
                    !supported().includes(Number(value)))
                )
                  return;
                if (kind === "sample_rate")
                  setAppOptions(
                    "audioSampleRate",
                    value === "auto" ? null : Number(value),
                  );
                else
                  setAppOptions(
                    "audioChannelCount",
                    value === "auto"
                      ? null
                      : (Number(value) as 1 | 2),
                  );
              }}
              label={name()}
              renderValue={(state) =>
                optionName(state.selectedOption() ?? "auto")
              }
              optionLabel={(option) => (
                <>
                  {optionName(option)}
                  {option !== "auto" &&
                  !supported().includes(Number(option))
                    ? ` (${label("unavailable")})`
                    : ""}
                </>
              )}
            />
          );
        }}
      </For>
      <Show
        when={
          capabilities.audioFormatsLoading() ||
          capabilities.audioFormatsFailed() ||
          available().sampleRates === null ||
          available().channelCounts === null
        }
      >
        <p class="muted" role="status">
          {label(
            capabilities.audioFormatsLoading()
              ? "sampling_loading"
              : capabilities.audioFormatsFailed()
                ? "sampling_failed"
                : "sampling_unknown",
          )}
        </p>
      </Show>
    </>
  );
}
