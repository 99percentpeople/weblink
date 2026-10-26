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
import LocalAudioPlaybackSetting from "./local-audio-playback-setting";

export default function AudioSettings() {
  const capabilities = useAppState().mediaCapabilities;
  // An unavailable native query must not turn microphone formats into system formats.
  const browserSampling = () =>
    capabilities.native() === null
      ? capabilities.browserSampling()
      : [];
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
      <SettingHeading
        description={label(
          capabilities.native() !== null
            ? "native_description"
            : "description",
        )}
      >
        {label("title")}
      </SettingHeading>

      <LocalAudioPlaybackSetting />

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
              kind === "sample_rate"
                ? sampling().audioSampleRate
                : sampling().audioChannelCount,
            );
          const supported = () =>
            (kind === "sample_rate"
              ? available().sampleRates
              : available().channelCounts) ?? [];
          const options = () =>
            [
              ...new Set([
                kind === "sample_rate" ? "48000" : "2",
                ...supported().map(String),
                value(),
              ]),
            ].sort((a, b) => Number(a) - Number(b));
          const isDefault = (value: string) =>
            value ===
            (kind === "sample_rate" ? "48000" : "2");
          const unavailable = (value: string) =>
            !supported().includes(Number(value)) &&
            (!isDefault(value) ||
              capabilities.audioFormats() !== undefined);
          const optionName = (value: string) => {
            const name =
              kind === "sample_rate"
                ? `${Number(value) / 1000} kHz`
                : label(
                    value === "1"
                      ? "channels.mono"
                      : "channels.stereo",
                  );
            const formatted = isDefault(value)
              ? `${name} (${label("default")})`
              : name;
            return unavailable(value)
              ? `${formatted} (${label("unavailable")})`
              : formatted;
          };
          return (
            <SettingSelect<string>
              modal
              value={value()}
              options={options()}
              optionDisabled={unavailable}
              onChange={(value) => {
                if (!value || unavailable(value)) return;
                if (kind === "sample_rate") {
                  const audioSampleRate = Number(value);
                  const current = sampling();
                  const channels = audioSamplingChoices(
                    browserSampling(),
                    capabilities.audioFormats(),
                    { ...current, audioSampleRate },
                  ).channelCounts;
                  const audioChannelCount =
                    capabilities.audioFormats() ===
                    undefined
                      ? current.audioChannelCount
                      : ((
                          [
                            current.audioChannelCount,
                            2,
                            1,
                          ] as const
                        ).find((count) =>
                          channels?.includes(count),
                        ) ?? current.audioChannelCount);
                  setAppOptions({
                    audioSampleRate,
                    audioChannelCount,
                  });
                } else
                  setAppOptions(
                    "audioChannelCount",
                    Number(value) as 1 | 2,
                  );
              }}
              label={name()}
              renderValue={(state) =>
                optionName(
                  state.selectedOption() ?? value(),
                )
              }
              optionLabel={optionName}
            />
          );
        }}
      </For>
      <Show
        when={
          capabilities.audioFormatsLoading() ||
          capabilities.audioFormatsFailed() ||
          available().sampleRates?.length === 0 ||
          available().sampleRates === null ||
          available().channelCounts === null
        }
      >
        <p class="muted" role="status">
          {label(
            capabilities.audioFormatsLoading()
              ? "sampling_loading"
              : capabilities.audioFormatsFailed() ||
                  available().sampleRates?.length === 0
                ? "sampling_failed"
                : "sampling_unknown",
          )}
        </p>
      </Show>
    </>
  );
}
