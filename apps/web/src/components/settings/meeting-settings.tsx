import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
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
import { platform } from "@/libs/platform/runtime";
import VideoCaptureSettings from "./video-capture-settings";
import NativeMediaSettings, {
  type NativeMediaSettingsCapabilities,
} from "./native-media-settings";
import {
  defaultVideoFrameRates,
  displayVideoFrameRates,
} from "@/libs/application/meeting-video-settings";

export default function MeetingSettings() {
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

  // Capability discovery must not suspend the surrounding settings dialog.
  const [native, setNative] =
    createSignal<NativeMediaSettingsCapabilities | null>(
      null,
    );
  const [frameRates, setFrameRates] = createSignal<
    readonly number[] | null
  >(
    platform.kind === "desktop"
      ? null
      : defaultVideoFrameRates,
  );
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  onMount(async () => {
    if (platform.kind !== "desktop") return;
    const screenShare = platform.screenShare;
    let nativeSupported = false;
    try {
      const capabilities = await platform.getCapabilities();
      if (disposed) return;
      const desktop = capabilities.runtime === "desktop";
      setFrameRates(
        desktop
          ? displayVideoFrameRates(
              capabilities.displayRefreshRates,
            )
          : defaultVideoFrameRates,
      );
      if (
        !desktop ||
        !capabilities.nativeScreenCapture ||
        !screenShare
      )
        return;
      nativeSupported = true;
      const [codecs, encoders, backends] =
        await Promise.all([
          screenShare.codecs(),
          screenShare.encoders(),
          platform.capture!.backends(),
        ]);
      if (!disposed)
        setNative({
          codecs,
          encoders,
          backends,
          failed: false,
        });
    } catch {
      if (!disposed) {
        setFrameRates(
          (current) => current ?? defaultVideoFrameRates,
        );
        // Opening a desktop dev URL in a browser has no native runtime.
        if (nativeSupported)
          setNative({
            codecs: [],
            encoders: [],
            backends: { screen: [], window: [] },
            failed: true,
          });
      }
    }
  });
  return (
    <section
      class="settings-section"
      aria-labelledby="meeting"
    >
      <h3 id="meeting" class="h3">
        {t("app_menu.settings_meeting")}
      </h3>
      <VideoCaptureSettings frameRates={frameRates()} />
      <h3 id="stream" class="h3">
        {t("setting.meeting_settings.stream.title")}
      </h3>
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
        <p class="muted">
          {t(
            "setting.meeting_settings.stream.video_max_bitrate.description",
          )}
        </p>
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
            "setting.meeting_settings.stream.degradation_preference.description",
          )}
        </p>
      </label>
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
          <SelectTrigger>
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
        <p class="muted">
          {t(
            "setting.meeting_settings.stream.preferred_video_codec.description",
          )}
        </p>
      </label>
      <label class="flex flex-col gap-2">
        <Label>
          {t(
            "setting.meeting_settings.stream.preferred_audio_codec.title",
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
                    "setting.meeting_settings.stream.preferred_audio_codec.auto",
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
                      "setting.meeting_settings.stream.preferred_audio_codec.auto",
                    )
                  : state.selectedOption()
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">
          {t(
            "setting.meeting_settings.stream.preferred_audio_codec.description",
          )}
        </p>
      </label>
      <Show when={platform.kind === "desktop" && native()}>
        {(available) => (
          <NativeMediaSettings available={available()} />
        )}
      </Show>
    </section>
  );
}
