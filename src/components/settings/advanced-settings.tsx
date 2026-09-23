import { createMemo } from "solid-js";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";
import {
  formatBitSize,
  formatBtyeSize,
} from "@/libs/utils/format-filesize";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { setAppOptions } from "@/options";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appState } from "@/libs/state/app-state";

export default function AdvancedSettings() {
  const canGetRtpCapabilities = createMemo(() => {
    return (
      typeof RTCRtpSender !== "undefined" &&
      "getCapabilities" in RTCRtpSender
    );
  });

  const preferredVideoCodecOptions = createMemo(() => {
    const options: string[] = ["auto"];
    if (!canGetRtpCapabilities()) return options;
    const capabilities =
      RTCRtpSender.getCapabilities("video");
    const codecs = capabilities?.codecs ?? [];
    const mimeTypes = new Set<string>();
    codecs.forEach((c) => {
      const mt = String(c.mimeType ?? "")
        .trim()
        .toLowerCase();
      if (!mt.startsWith("video/")) return;
      if (
        [
          "video/rtx",
          "video/red",
          "video/ulpfec",
          "video/flexfec-03",
        ].includes(mt)
      ) {
        return;
      }
      mimeTypes.add(mt);
    });
    return options.concat(Array.from(mimeTypes).sort());
  });

  const preferredAudioCodecOptions = createMemo(() => {
    const options: string[] = ["auto"];
    if (!canGetRtpCapabilities()) return options;
    const capabilities =
      RTCRtpSender.getCapabilities("audio");
    const codecs = capabilities?.codecs ?? [];
    const mimeTypes = new Set<string>();
    codecs.forEach((c) => {
      const mt = String(c.mimeType ?? "")
        .trim()
        .toLowerCase();
      if (!mt.startsWith("audio/")) return;
      if (["audio/telephone-event"].includes(mt)) {
        return;
      }
      mimeTypes.add(mt);
    });
    return options.concat(Array.from(mimeTypes).sort());
  });

  return (
    <section class="settings-section">
      <h4 id="advanced-connection" class="h4">
        {t(
          "setting.advanced_settings.advanced_connection.title",
        )}
      </h4>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.relayOnly}
          disabled={
            appState.options.servers.turns.length === 0
          }
          onChange={(isChecked) =>
            setAppOptions("relayOnly", isChecked)
          }
        >
          <SwitchLabel>
            {t(
              "setting.advanced_settings.advanced_connection.relay_only.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.advanced_settings.advanced_connection.relay_only.description",
          )}
        </p>
      </div>
      <h4 id="advanced-sender" class="h4">
        {t(
          "setting.advanced_settings.advanced_sender.title",
        )}
      </h4>
      <Slider
        minValue={Math.max(
          appState.options.blockSize,
          128 * 1024,
        )}
        maxValue={10 * 1024 * 1024}
        step={128 * 1024}
        defaultValue={[appState.options.chunkSize]}
        class="gap-2"
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 2)
        }
        onChange={(value) => {
          setAppOptions("chunkSize", value[0]);
        }}
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t("setting.sender.chunk_size.title")}
          </SliderLabel>
          <SliderValueLabel />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <Slider
        minValue={16 * 1024}
        maxValue={192 * 1024}
        step={16 * 1024}
        defaultValue={[appState.options.blockSize]}
        class="gap-2"
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 0)
        }
        onChange={(value) => {
          setAppOptions("blockSize", value[0]);
        }}
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t("setting.sender.block_size.title")}
          </SliderLabel>
          <SliderValueLabel />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <Slider
        minValue={256 * 1024}
        maxValue={16 * 1024 * 1024}
        step={256 * 1024}
        defaultValue={[
          appState.options.bufferedAmountHighWaterMark,
        ]}
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 2)
        }
        class="gap-2"
        onChange={(value) => {
          setAppOptions(
            "bufferedAmountHighWaterMark",
            value[0],
          );
        }}
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t("setting.sender.max_buffer_amount.title")}
          </SliderLabel>
          <SliderValueLabel />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>

      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.ordered}
          onChange={(isChecked) =>
            setAppOptions("ordered", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.sender.ordered.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.sender.ordered.description")}
        </p>
      </div>
      <h4 id="advanced-receiver" class="h4">
        {t(
          "setting.advanced_settings.advanced_receiver.title",
        )}
      </h4>
      <label class="flex flex-col gap-2">
        <Slider
          minValue={1}
          maxValue={128}
          step={1}
          defaultValue={[
            appState.options.maxMomeryCacheSlices,
          ]}
          getValueLabel={({ values }) =>
            `${values[0]} (${formatBtyeSize(values[0] * appState.options.chunkSize, 0)})`
          }
          class="gap-2"
          onChange={(value) => {
            setAppOptions("maxMomeryCacheSlices", value[0]);
          }}
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t(
                "setting.receiver.max_cached_chunks.title",
              )}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
        <p class="muted">
          {t(
            "setting.receiver.max_cached_chunks.description",
          )}
        </p>
      </label>
      <h4 id="stream" class="h4">
        {t("setting.advanced_settings.stream.title")}
      </h4>
      <label class="flex flex-col gap-2">
        <Slider
          minValue={128 * 1024}
          maxValue={150 * 1024 * 1024}
          step={128 * 1024}
          defaultValue={[appState.options.videoMaxBitrate]}
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
                "setting.advanced_settings.stream.video_max_bitrate.title",
              )}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
        <p class="muted">
          {t(
            "setting.advanced_settings.stream.video_max_bitrate.description",
          )}
        </p>
      </label>
      <label class="flex flex-col gap-2">
        <Label>
          {t(
            "setting.advanced_settings.stream.degradation_preference.title",
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
              {props.item.rawValue}
            </SelectItem>
          )}
        >
          <SelectTrigger>
            <SelectValue<RTCDegradationPreference>>
              {(state) => state.selectedOption()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">
          {t(
            "setting.advanced_settings.stream.degradation_preference.description",
          )}
        </p>
      </label>
      <label class="flex flex-col gap-2">
        <Label>
          {t(
            "setting.advanced_settings.stream.preferred_video_codec.title",
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
                    "setting.advanced_settings.stream.preferred_video_codec.auto",
                  )
                : props.item.rawValue}
            </SelectItem>
          )}
        >
          <SelectTrigger>
            <SelectValue<string>>
              {(state) =>
                state.selectedOption() === "auto"
                  ? t(
                      "setting.advanced_settings.stream.preferred_video_codec.auto",
                    )
                  : state.selectedOption()
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">
          {t(
            "setting.advanced_settings.stream.preferred_video_codec.description",
          )}
        </p>
      </label>
      <label class="flex flex-col gap-2">
        <Label>
          {t(
            "setting.advanced_settings.stream.preferred_audio_codec.title",
          )}
        </Label>
        <Select
          modal
          value={
            appState.options.preferredAudioCodec ?? "auto"
          }
          disabled={!canGetRtpCapabilities()}
          onChange={(value) => {
            setAppOptions(
              "preferredAudioCodec",
              value === "auto" ? null : value,
            );
          }}
          options={preferredAudioCodecOptions()}
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {props.item.rawValue === "auto"
                ? t(
                    "setting.advanced_settings.stream.preferred_audio_codec.auto",
                  )
                : props.item.rawValue}
            </SelectItem>
          )}
        >
          <SelectTrigger>
            <SelectValue<string>>
              {(state) =>
                state.selectedOption() === "auto"
                  ? t(
                      "setting.advanced_settings.stream.preferred_audio_codec.auto",
                    )
                  : state.selectedOption()
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">
          {t(
            "setting.advanced_settings.stream.preferred_audio_codec.description",
          )}
        </p>
      </label>
    </section>
  );
}
