import { createMemo, For, Show } from "solid-js";
import { t } from "@/i18n";
import { sessionService } from "@/libs/application/session-service";
import type { VideoQualityControl } from "@/libs/domain/video-quality";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import {
  SettingSelect,
  SettingSlider,
} from "./setting-controls";
import { useAppState } from "@/libs/state/app-state-context";
import { videoResolutions } from "@/libs/application/meeting-video-settings";
import { formatBitSize } from "@/libs/utils/format-filesize";
import {
  SettingBlock,
  SettingGroup,
} from "./setting-layout";
import { VideoQualityStatus } from "./video-quality-status";

export function ReceivedVideoSettings() {
  const state = useAppState();
  const nativeRates = () => {
    const runtime =
      state.mediaCapabilities.runtimeCapabilities();
    return runtime?.runtime === "desktop" &&
      runtime.displayRefreshRates?.some((rate) => rate > 1)
      ? state.mediaCapabilities.frameRates()
      : null;
  };
  const resolutions = () => {
    const monitors =
      state.mediaCapabilities.runtimeCapabilities()
        ?.runtime === "desktop"
        ? state.captureSources
            .sources()
            .filter(
              (source) =>
                source.kind === "monitor" &&
                source.width > 0 &&
                source.height > 0,
            )
        : [];
    return Object.values(videoResolutions)
      .filter(
        ([width, height]) =>
          !monitors.length ||
          monitors.some(
            (monitor) =>
              Math.max(monitor.width, monitor.height) >=
                width &&
              Math.min(monitor.width, monitor.height) >=
                height,
          ),
      )
      .map(([, height]) => height);
  };
  const preference = () =>
    appState.options.receiveVideoQuality;
  const sources = createMemo(
    () => sessionService?.getReceivedVideoQualities() ?? [],
  );
  const controls = createMemo(() =>
    sources().map((source) => source.control),
  );
  const label = (control: VideoQualityControl) => {
    const source = sources().find(
      (source) => source.control === control,
    );
    if (!source) return "";
    const peers = sources().filter(
      (item) =>
        item.clientId === source.clientId &&
        item.kind === source.kind,
    );
    const count =
      peers.findIndex((item) => item.control === control) +
      1;
    const name =
      appState.session.clientViewData[source.clientId]
        ?.name ?? source.clientId;
    const kind = t(
      source.kind === "screen"
        ? "meeting.screen_source"
        : source.kind === "camera"
          ? "meeting.unnamed_camera"
          : "meeting.video_source",
      { count },
    );
    return `${name} · ${kind}`;
  };
  const options = (
    values: readonly number[],
    selected?: number,
  ) =>
    [...new Set([0, ...values, selected ?? 0])].sort(
      (a, b) => a - b,
    );
  return (
    <SettingGroup
      title={t("video_quality.title")}
      description={t("video_quality.description")}
    >
      <SettingSelect<number>
        modal
        disallowEmptySelection
        label={t("video_quality.resolution")}
        value={preference().height ?? 0}
        options={options(
          resolutions(),
          preference().height,
        )}
        optionLabel={(height) =>
          height
            ? `${height}p`
            : t("video_quality.follow_resolution")
        }
        onChange={(height) =>
          setAppOptions(
            "receiveVideoQuality",
            "height",
            height || undefined,
          )
        }
      />
      <SettingSelect<number>
        modal
        disallowEmptySelection
        label={t("video_quality.framerate")}
        value={preference().fps ?? 0}
        options={options(
          nativeRates() ?? [
            15, 24, 30, 60, 90, 120, 144, 165, 240,
          ],
          preference().fps,
        )}
        optionLabel={(fps) =>
          fps ? `${fps} FPS` : t("video_quality.auto")
        }
        onChange={(fps) =>
          setAppOptions(
            "receiveVideoQuality",
            "fps",
            fps || undefined,
          )
        }
      />
      <SettingSlider
        minValue={0}
        maxValue={150 * 1024 * 1024}
        step={128 * 1024}
        value={[preference().bitrate ?? 0]}
        label={t("video_quality.bitrate")}
        getValueLabel={({ values }) =>
          values[0]
            ? `${formatBitSize(values[0], 0)}ps`
            : t("video_quality.follow_bitrate")
        }
        onChange={([bitrate]) =>
          setAppOptions(
            "receiveVideoQuality",
            "bitrate",
            bitrate || undefined,
          )
        }
      />
      <Show when={controls().length}>
        <SettingBlock>
          <p class="setting-description">
            {t("video_quality.source")}
          </p>
          <For each={controls()}>
            {(control) => (
              <div>
                <p class="text-sm">{label(control)}</p>
                <VideoQualityStatus control={control} />
              </div>
            )}
          </For>
        </SettingBlock>
      </Show>
    </SettingGroup>
  );
}
