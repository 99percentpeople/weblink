import { t } from "@/i18n";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import {
  formatVideoStatistics,
  hasStatisticsMeasurement,
  type StatisticsMetric,
  type StatisticsView,
} from "./video-statistics-format";

/** Combine transport and presentation for the same playback without merging
 * their counters or histories. Ambiguous tracks remain separate. */
export function formatVideoStatisticsGroups(
  rows: readonly VideoStatisticsRow[],
): StatisticsView[] {
  const views = rows.map(formatVideoStatistics);
  const displays = rows.filter(
    (row) => row.direction === "display",
  );
  if (displays.length !== 1) return views;
  const display = displays[0];
  const matches = rows.filter(
    (row) =>
      row.direction === "receive" &&
      !!row.preview === !!display.preview &&
      (!display.peer || row.peer === display.peer),
  );
  const displayIndex = rows.indexOf(display);
  const presentation = views[displayIndex];
  if (matches.length !== 1)
    return display.preview
      ? [
          presentation,
          ...views.filter(
            (_, index) => index !== displayIndex,
          ),
        ]
      : views;

  const receive = matches[0];
  const receiveIndex = rows.indexOf(receive);
  const transport = views[receiveIndex];
  const presentationMetrics = [
    ...presentation.summary,
    ...presentation.details,
  ];
  const transportMetrics = [
    ...transport.summary,
    ...transport.details,
  ].filter((metric) => {
    if (metric.key === "onePercentLowFps")
      return !presentationMetrics.some(
        (item) => item.key === metric.key,
      );
    // Raw preview submissions duplicate the compositor counter on GPU paths.
    // Encoded receive FPS remains useful as a separate decoder measurement.
    return !(
      metric.key === "fps" &&
      receive.preview &&
      !receive.codec &&
      hasStatisticsMeasurement(display, "fps")
    );
  });
  const metrics = [
    ...presentationMetrics,
    ...transportMetrics,
  ];
  const primary = display.preview
    ? ["submitMs", "fps", "onePercentLowFps"]
    : [
        "endToEndMs",
        "captureToReceiveMs",
        "receiveToPresentMs",
        "roundTripMs",
        ...(display.receiveToPresentMs === undefined
          ? ["receiveToDecodeMs"]
          : []),
        "fps",
        "onePercentLowFps",
      ];
  const summary = primary.flatMap((key) => {
    const metric = metrics.find((item) => item.key === key);
    return metric ? [metric] : [];
  });
  const group: StatisticsView = {
    title: display.preview
      ? t("video.statistics.preview")
      : transport.title,
    codec: transport.codec ?? presentation.codec,
    resolution:
      transport.resolution ?? presentation.resolution,
    implementation:
      [
        ...new Set(
          [
            transport.implementation,
            presentation.implementation,
          ].filter(Boolean),
        ),
      ].join(" · ") || undefined,
    summary,
    details: metrics.filter(
      (metric) => !summary.includes(metric),
    ),
  };
  return [
    group,
    ...views.filter(
      (_, index) =>
        index !== displayIndex && index !== receiveIndex,
    ),
  ];
}

/** The window shows essentials; complete views remain available to exports. */
export function visibleStatisticsMetrics(
  view: StatisticsView,
): StatisticsMetric[] {
  return [
    ...view.summary,
    ...view.details.filter(
      (metric) => metric.key === "bitrate",
    ),
  ];
}
