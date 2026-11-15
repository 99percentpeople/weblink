import { t } from "@/i18n";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import type { StatisticsHistoryKey } from "@/libs/hooks/video-statistics-history";
import {
  formatStatisticsValue,
  statisticsFrameRateLabel,
  statisticsMetricDescription,
  type StatisticsMetric,
} from "./video-statistics-format";

const hasMeasurement = (
  row: VideoStatisticsRow | undefined,
  key: StatisticsHistoryKey,
): boolean =>
  formatStatisticsValue(key, row?.[key]) !== undefined ||
  row?.history?.some(
    (sample) =>
      formatStatisticsValue(key, sample[key]) !== undefined,
  ) === true;

const metric = (
  label: string,
  key: StatisticsHistoryKey,
  row?: VideoStatisticsRow,
): StatisticsMetric => ({
  label: t(`video.statistics.${label}`),
  description: statisticsMetricDescription(label),
  value: formatStatisticsValue(key, row?.[key]) ?? "—",
  trend: row?.history
    ? { key, samples: row.history }
    : undefined,
});

/** One playback overview; per-peer transport readings stay in details. */
export function formatVideoStatisticsOverview(
  rows: readonly VideoStatisticsRow[],
): StatisticsMetric[] {
  const unique = (
    direction: VideoStatisticsRow["direction"],
  ) => {
    const matches = rows.filter(
      (row) => row.direction === direction,
    );
    // Never pick an arbitrary viewer or blend different pipelines.
    return matches.length === 1 ? matches[0] : undefined;
  };
  const display = unique("display");
  const receive = unique("receive");
  const capture = unique("capture");
  const send = unique("send");
  const latency = (
    [
      [display, "receiveToPresentMs", "receive_to_present"],
      [receive, "receiveToDecodeMs", "receive_to_decode"],
      [send, "captureToEncodeMs", "capture_to_encode"],
      [receive, "roundTripMs", "rtt"],
      [send, "roundTripMs", "rtt"],
    ] as const
  ).find(([row, key]) => hasMeasurement(row, key));
  // Keep measured zeroes and gaps from the presentation history. A healthy
  // decoder must not disguise a stalled or temporarily unavailable display.
  const frames = [display, receive, capture, send].find(
    (row) => hasMeasurement(row, "fps"),
  );
  const low = metric(
    "one_percent_low_short",
    "onePercentLowFps",
    display,
  );
  low.secondary = true;
  low.description = t("video.statistics.one_percent_low");
  if (display?.onePercentLowState === "unsupported") {
    low.value = "—";
    low.trend = undefined;
    low.description = t("video.statistics.low_unavailable");
  } else if (
    display?.onePercentLowState === "estimated" &&
    low.value !== "—"
  ) {
    low.value = "≈ " + low.value;
  }
  return [
    latency
      ? metric(latency[2], latency[1], latency[0])
      : metric("latency", "receiveToPresentMs"),
    metric(
      frames
        ? statisticsFrameRateLabel(frames)
        : "frame_rate",
      "fps",
      frames,
    ),
    low,
  ];
}
