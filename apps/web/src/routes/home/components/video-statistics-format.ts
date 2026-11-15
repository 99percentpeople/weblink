import { t } from "@/i18n";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import type {
  StatisticsHistoryKey,
  StatisticsTrend,
} from "@/libs/hooks/video-statistics-history";

export interface StatisticsMetric {
  label: string;
  value: string;
  trend?: StatisticsTrend;
  secondary?: boolean;
  description?: string;
}

export interface StatisticsView {
  title: string;
  codec?: string;
  implementation?: string;
  resolution?: string;
  summary: StatisticsMetric[];
  details: StatisticsMetric[];
}

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

export function formatStatisticsValue(
  key: StatisticsHistoryKey,
  value?: number,
): string | undefined {
  if (
    key === "bitrate" ||
    key === "targetBitrate" ||
    key === "encoderBitrate" ||
    key === "availableOutgoingBitrate"
  )
    return bitrate(value);
  return fixed(
    value,
    key === "fps" || key === "onePercentLowFps"
      ? "FPS"
      : key === "droppedPerSecond"
        ? "/s"
        : "ms",
  );
}

export function statisticsFrameRateLabel(
  row: VideoStatisticsRow,
): string {
  return row.direction === "send"
    ? "encode"
    : row.direction === "receive"
      ? row.preview && !row.codec
        ? "submitted"
        : "decode"
      : "frame_rate";
}

export function statisticsMetricDescription(
  key: string,
): string | undefined {
  return key === "capture_to_encode" ||
    key === "receive_to_present" ||
    key === "receive_to_decode"
    ? t(`video.statistics.${key}_description`)
    : undefined;
}

/** Keep compact labels and complete measurement names together. */
export function formatVideoStatistics(
  row: VideoStatisticsRow,
): StatisticsView {
  const summary: StatisticsMetric[] = [];
  const details: StatisticsMetric[] = [];
  const add = (
    list: StatisticsMetric[],
    key: string,
    value?: string,
    historyKey?: StatisticsHistoryKey,
  ) => {
    const trend =
      historyKey && row.history
        ? { key: historyKey, samples: row.history }
        : undefined;
    if (
      value !== undefined ||
      trend?.samples.some(
        (sample) => sample[trend.key] !== undefined,
      )
    )
      list.push({
        label: t(`video.statistics.${key}`),
        description: statisticsMetricDescription(key),
        value: value ?? "—",
        trend,
      });
  };
  const fpsLabel = statisticsFrameRateLabel(row);
  add(summary, fpsLabel, fixed(row.fps, "FPS"), "fps");
  add(summary, "bitrate", bitrate(row.bitrate), "bitrate");
  let low = fixed(row.onePercentLowFps, "FPS");
  if (row.onePercentLowState === "estimated" && low)
    low = "≈ " + low;
  if (row.onePercentLowState === "unsupported")
    add(
      details,
      "one_percent_low",
      t("video.statistics.low_unavailable"),
    );
  else
    add(
      summary,
      "one_percent_low",
      low,
      "onePercentLowFps",
    );

  for (const [key, value, historyKey] of [
    ["target_bitrate", row.targetBitrate, "targetBitrate"],
    [
      "encoder_bitrate",
      row.encoderBitrate,
      "encoderBitrate",
    ],
    [
      "bandwidth_estimate",
      row.availableOutgoingBitrate,
      "availableOutgoingBitrate",
    ],
  ] as const)
    add(details, key, bitrate(value), historyKey);
  add(
    details,
    "player_dropped",
    fixed(row.droppedPerSecond, "/s"),
    "droppedPerSecond",
  );
  for (const [key, value, historyKey] of [
    [
      "receive_to_present",
      row.receiveToPresentMs,
      "receiveToPresentMs",
    ],
    [
      "receive_to_decode",
      row.receiveToDecodeMs,
      "receiveToDecodeMs",
    ],
    ["encode", row.encodeMs, "encodeMs"],
    ["decode", row.decodeMs, "decodeMs"],
    [
      "buffer",
      row.direction === "receive"
        ? row.jitterMs
        : undefined,
      "jitterMs",
    ],
    ["encoder_queue", row.encoderQueueMs, "encoderQueueMs"],
    [
      "capture_to_encode",
      row.captureToEncodeMs,
      "captureToEncodeMs",
    ],
    ["send_queue", row.sendDelayMs, "sendDelayMs"],
    ["rtt", row.roundTripMs, "roundTripMs"],
  ] as const)
    add(details, key, fixed(value, "ms"), historyKey);

  return {
    title: `${t(`video.statistics.${row.direction}`)}${
      row.preview
        ? ` · ${t("video.statistics.preview")}`
        : row.peer
          ? ` · ${row.peer}`
          : ""
    }`,
    codec:
      row.codec?.replace(/^video\//i, "").trim() ||
      undefined,
    implementation: row.implementation?.trim() || undefined,
    resolution:
      row.width &&
      row.height &&
      Number.isFinite(row.width) &&
      Number.isFinite(row.height) &&
      row.width > 0 &&
      row.height > 0
        ? `${row.width} × ${row.height}`
        : undefined,
    summary,
    details,
  };
}

export function statisticsText(
  row: StatisticsView,
): string {
  return [
    row.title,
    row.codec,
    row.implementation,
    row.resolution,
    ...[...row.summary, ...row.details].map(
      ({ label, description, value }) =>
        `${description ?? label} ${value}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
