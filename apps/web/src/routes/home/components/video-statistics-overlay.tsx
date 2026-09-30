import { createMemo, For, Show } from "solid-js";
import { t } from "@/i18n";
import { createVideoStatistics } from "@/libs/hooks/video-statistics";
import type { VideoStatsBatch } from "@/libs/domain/video-stats";
import { useVideoDisplay } from "./video-display";

const fixed = (value: number | undefined, unit: string) =>
  value === undefined ||
  !Number.isFinite(value) ||
  value < 0
    ? undefined
    : `${value.toFixed(1)} ${unit}`;
const bitrate = (value?: number) =>
  value === undefined
    ? undefined
    : value >= 1_000_000
      ? fixed(value / 1_000_000, "Mbps")
      : fixed(value / 1000, "kbps");

export function VideoStatisticsOverlay(props: {
  local?: boolean;
  read: (
    track: MediaStreamTrack,
  ) => Promise<VideoStatsBatch[]>;
}) {
  const { videoRef, videoTrack } = useVideoDisplay();
  const rows = createVideoStatistics(
    videoTrack,
    videoRef,
    props.read,
    () => props.local === true,
  );
  const visibleRows = createMemo(() => {
    const duration = (
      kind:
        | "encode"
        | "decode"
        | "buffer"
        | "encoder_queue"
        | "capture_to_encode"
        | "send_queue"
        | "receive_to_present"
        | "rtt",
      value?: number,
    ) => {
      const text = fixed(value, "ms");
      return text
        ? `${t(`video.statistics.${kind}`)} ${text}`
        : undefined;
    };
    return rows()
      .map((row) => {
        const codec = row.codec
          ?.replace(/^video\//i, "")
          .trim();
        const implementation = row.implementation?.trim();
        const fps = fixed(row.fps, "FPS");
        const dropped = fixed(row.droppedPerSecond, "/s");
        const fpsLabel =
          row.direction === "send"
            ? t("video.statistics.encode")
            : row.direction === "receive"
              ? t(
                  row.preview && !row.codec
                    ? "video.statistics.submitted"
                    : "video.statistics.decode",
                )
              : undefined;
        const lines = [
          codec
            ? `${codec}${implementation ? ` (${implementation})` : ""}`
            : implementation,
          [
            row.width &&
            row.height &&
            Number.isFinite(row.width) &&
            Number.isFinite(row.height) &&
            row.width > 0 &&
            row.height > 0
              ? `${row.width} × ${row.height}`
              : undefined,
            fps
              ? `${fpsLabel ? `${fpsLabel} ` : ""}${fps}`
              : undefined,
            bitrate(row.bitrate),
          ]
            .filter(Boolean)
            .join(" · "),
          [
            dropped
              ? `${t("video.statistics.player_dropped")} ${dropped}`
              : undefined,
            duration(
              "receive_to_present",
              row.receiveToPresentMs,
            ),
          ]
            .filter(Boolean)
            .join(" · "),
          [
            duration("encode", row.encodeMs),
            duration("decode", row.decodeMs),
          ]
            .filter(Boolean)
            .join(" · "),
          row.direction === "receive"
            ? duration("buffer", row.jitterMs)
            : undefined,
          [
            duration("encoder_queue", row.encoderQueueMs),
            duration(
              "capture_to_encode",
              row.captureToEncodeMs,
            ),
          ]
            .filter(Boolean)
            .join(" · "),
          [
            duration("send_queue", row.sendDelayMs),
            duration("rtt", row.roundTripMs),
          ]
            .filter(Boolean)
            .join(" · "),
        ].filter((line): line is string => Boolean(line));
        return { ...row, lines };
      })
      .filter((row) => row.lines.length > 0);
  });
  return (
    <Show when={videoTrack() && visibleRows().length > 0}>
      <div
        class="pointer-events-none absolute left-2 top-2 z-10
          max-h-[calc(100%-1rem)] max-w-[calc(100%-1rem)]
          overflow-hidden rounded-md bg-black/75 px-2 py-1.5 font-mono
          text-[10px] tabular-nums leading-relaxed text-white"
        role="group"
        aria-label={t("video.statistics.title")}
        data-stream-statistics
      >
        <For each={visibleRows()}>
          {(row) => (
            <div class="py-0.5">
              <div class="truncate text-white/70">
                {t(`video.statistics.${row.direction}`)}
                {row.preview
                  ? ` · ${t("video.statistics.preview")}`
                  : row.peer
                    ? ` · ${row.peer}`
                    : ""}
              </div>
              <For each={row.lines}>
                {(line) => (
                  <div class="truncate">{line}</div>
                )}
              </For>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
