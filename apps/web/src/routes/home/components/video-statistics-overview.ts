import { t } from "@/i18n";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import type { StatisticsHistoryKey } from "@/libs/hooks/video-statistics-history";
import { senderStatisticsOverview } from "@/libs/hooks/video-statistics-senders";
import {
  formatStatisticsValue,
  formatEndToEndLatency,
  formatSendLatency,
  hasStatisticsMeasurement,
  statisticsFrameRateLabel,
  statisticsMetricDescription,
  type StatisticsMetric,
} from "./video-statistics-format";

const metric = (
  label: string,
  key: StatisticsHistoryKey,
  row?: VideoStatisticsRow,
): StatisticsMetric => ({
  key,
  label: t(`video.statistics.${label}`),
  description: statisticsMetricDescription(label),
  value: formatStatisticsValue(key, row?.[key]) ?? "—",
  trend: row?.history
    ? { key, samples: row.history }
    : undefined,
});

/** Local playback plus sender totals, or one remote playback and transport. */
export function formatVideoStatisticsOverview(
  rows: readonly VideoStatisticsRow[],
): StatisticsMetric[] {
  const unique = (
    matches: readonly VideoStatisticsRow[],
  ) => {
    // Never pick an arbitrary viewer or blend different pipelines.
    return matches.length === 1 ? matches[0] : undefined;
  };
  const display = unique(
    rows.filter((row) => row.direction === "display"),
  );
  const local =
    display?.preview ??
    (rows.some((row) => row.preview) ||
      (!rows.some((row) => row.direction === "receive") &&
        rows.some(
          (row) =>
            row.direction === "send" ||
            row.direction === "capture",
        )));
  const receive = unique(
    rows.filter(
      (row) =>
        row.direction === "receive" &&
        !!row.preview === local,
    ),
  );
  const capture = unique(
    rows.filter((row) => row.direction === "capture"),
  );
  const senders = rows.filter(
    (row) => row.direction === "send" && !row.preview,
  );
  const senderOverview = senderStatisticsOverview(senders);
  const slowest = senderOverview.slowest
    .slice()
    .sort((a, b) =>
      (a.peer ?? "").localeCompare(b.peer ?? ""),
    );
  const sendLatency = local
    ? formatSendLatency(slowest[0])
    : undefined;
  const senderHistory = display?.senderOverviewHistory;
  if (sendLatency) {
    sendLatency.description = [
      t("video.statistics.slowest_receiver", {
        peer: slowest
          .map(
            (row) =>
              row.peer?.trim() ||
              t("video.statistics.unnamed_receiver"),
          )
          .join(", "),
      }),
      ...[
        ...new Set(
          slowest.map(
            (row) => formatSendLatency(row)?.description,
          ),
        ),
      ].sort(),
    ]
      .filter(Boolean)
      .join("\n");
    // Each point represents the slowest receiver at that time, not today's
    // slowest receiver projected backwards onto its own transport history.
    sendLatency.trend = senderHistory
      ? { key: "sendLatencyMs", samples: senderHistory }
      : senders.length === 1
        ? sendLatency.trend
        : undefined;
  }
  const traffic = local
    ? metric("total_bitrate", "bitrate", {
        direction: "send",
        bitrate: senderOverview.bitrate,
        history:
          senderHistory ??
          (senders.length === 1
            ? senders[0].history
            : undefined),
      })
    : metric("bitrate", "bitrate", receive);
  if (local)
    traffic.description = t(
      "video.statistics.total_bitrate_description",
    );
  const endToEnd = local
    ? undefined
    : formatEndToEndLatency(display);
  // Keep measured zeroes and gaps from the presentation history. A healthy
  // decoder must not disguise a stalled or temporarily unavailable display.
  const frames = [
    display,
    receive,
    ...(local ? [capture] : []),
  ].find((row) => hasStatisticsMeasurement(row, "fps"));
  return [
    ...(endToEnd !== undefined
      ? [
          {
            ...metric("end_to_end", "endToEndMs", display),
            value: endToEnd,
          },
        ]
      : []),
    ...(sendLatency ? [sendLatency] : []),
    metric(
      frames
        ? statisticsFrameRateLabel(frames)
        : "frame_rate",
      "fps",
      frames,
    ),
    traffic,
  ];
}
