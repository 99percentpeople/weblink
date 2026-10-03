import { createMemo, For, Show } from "solid-js";
import { useAppState } from "@/libs/state/app-state-context";
import { audioSamplingChoices } from "@/libs/application/audio-sampling-capabilities";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
      <h3 class="h3">{label("title")}</h3>
      <p class="muted">{label("description")}</p>
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
            <div class="flex flex-col gap-2">
              <Label>{name()}</Label>
              <Select<string>
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
                      value === "auto"
                        ? null
                        : Number(value),
                    );
                  else
                    setAppOptions(
                      "audioChannelCount",
                      value === "auto"
                        ? null
                        : (Number(value) as 1 | 2),
                    );
                }}
                itemComponent={(item) => (
                  <SelectItem item={item.item}>
                    {optionName(item.item.rawValue)}
                    {item.item.rawValue !== "auto" &&
                    !supported().includes(
                      Number(item.item.rawValue),
                    )
                      ? ` (${label("unavailable")})`
                      : ""}
                  </SelectItem>
                )}
              >
                <SelectTrigger aria-label={name()}>
                  <SelectValue<string>>
                    {(state) =>
                      optionName(
                        state.selectedOption() ?? "auto",
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
            </div>
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
