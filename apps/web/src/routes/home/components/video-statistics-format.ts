import { t } from "@/i18n";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import type {
  StatisticsHistoryKey,
  StatisticsTrend,
} from "@/libs/hooks/video-statistics-history";

export interface StatisticsMetric {
  key?: StatisticsHistoryKey;
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

export function hasStatisticsMeasurement(
  row: VideoStatisticsRow | undefined,
  key: StatisticsHistoryKey,
): boolean {
  return (
    formatStatisticsValue(key, row?.[key]) !== undefined ||
    row?.history?.some(
      (sample) =>
        formatStatisticsValue(key, sample[key]) !==
        undefined,
    ) === true
  );
}

/** Historical values stay in diagnostics but never stand in for a live latency. */
export function formatEndToEndLatency(
  row?: VideoStatisticsRow,
): string | undefined {
  if (!row || row.preview || row.direction !== "display")
    return;
  return formatStatisticsValue(
    "endToEndMs",
    row.endToEndMs,
  );
}

/** Explain the sender timing scope in its description; keep numeric values plain. */
export function formatSendLatency(
  row?: VideoStatisticsRow,
): StatisticsMetric | undefined {
  if (!row || row.preview || row.direction !== "send")
    return;
  const value = formatStatisticsValue(
    "sendLatencyMs",
    row.sendLatencyMs,
  );
  if (value === undefined || !row.sendLatencyBasis) return;
  return {
    key: "sendLatencyMs",
    label: t(
      row.sendLatencyEndpoint === "packetizer-input"
        ? "video.statistics.send_pre_packetizer"
        : "video.statistics.send_latency",
    ),
    description: t(
      row.sendLatencyBasis === "frame"
        ? row.sendLatencyEndpoint === "transport-submit"
          ? "video.statistics.send_latency_frame_description"
          : "video.statistics.send_pre_packetizer_description"
        : row.sendLatencyBasis === "capture"
          ? "video.statistics.send_latency_description"
          : "video.statistics.send_latency_partial_description",
    ),
    value,
    trend: row.history
      ? { key: "sendLatencyMs", samples: row.history }
      : undefined,
  };
}

export function statisticsFrameRateLabel(
  row: VideoStatisticsRow,
): string {
  return row.direction === "send"
    ? "encode_frame_rate"
    : row.direction === "receive"
      ? row.preview && !row.codec
        ? "submitted"
        : "decode_frame_rate"
      : "frame_rate";
}

export function statisticsMetricDescription(
  key: string,
): string | undefined {
  if (key === "one_percent_low")
    return t("video.statistics.one_percent_low");
  return [
    "end_to_end",
    "capture_to_encode",
    "receive_to_present",
    "receive_to_decode",
    "submit_latency",
    "presentation_queue",
    "encode_latency",
    "decode_time",
    "buffer",
    "rtt",
    "capture_to_receive",
    "decode_to_present",
    "display_wait",
    "frame_decode",
    "capture_to_packetizer",
    "packetizer_to_send",
  ].includes(key)
    ? t(`video.statistics.${key}_description`)
    : undefined;
}

function statisticsTitle(row: VideoStatisticsRow): string {
  if (row.preview) {
    const preview = t("video.statistics.preview");
    // Raw previews submit captured frames locally; the reused receive category
    // does not imply RTP reception, decoding, or a capture frame counter.
    if (
      row.direction === "display" ||
      (row.direction === "receive" && !row.codec)
    )
      return preview;
    const stage =
      row.direction === "send"
        ? "encode"
        : row.direction === "receive"
          ? "decode"
          : row.direction;
    return `${t(`video.statistics.${stage}`)} · ${preview}`;
  }
  return [t(`video.statistics.${row.direction}`), row.peer]
    .filter(Boolean)
    .join(" · ");
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
    const labelKey =
      key === "one_percent_low"
        ? "one_percent_low_short"
        : key;
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
        label: t(`video.statistics.${labelKey}`),
        key: historyKey,
        description: statisticsMetricDescription(key),
        value: value ?? "—",
        trend,
      });
  };
  const fpsLabel = statisticsFrameRateLabel(row);
  const endToEnd = formatEndToEndLatency(row);
  if (endToEnd !== undefined)
    add(summary, "end_to_end", endToEnd, "endToEndMs");
  const sendLatency = formatSendLatency(row);
  add(summary, fpsLabel, fixed(row.fps, "FPS"), "fps");
  const low = fixed(row.onePercentLowFps, "FPS");
  if (row.onePercentLowState === "unsupported")
    details.push({
      key: "onePercentLowFps",
      label: t("video.statistics.one_percent_low_short"),
      value: t("video.statistics.low_unavailable"),
      description: statisticsMetricDescription(
        "one_percent_low",
      ),
    });
  else
    add(
      summary,
      "one_percent_low",
      low,
      "onePercentLowFps",
    );
  add(details, "bitrate", bitrate(row.bitrate), "bitrate");

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
      "capture_to_packetizer",
      row.captureToPacketizerMs,
      "captureToPacketizerMs",
    ],
    [
      "packetizer_to_send",
      row.packetizerToSendMs,
      "packetizerToSendMs",
    ],
    [
      "capture_to_receive",
      row.captureToReceiveMs,
      "captureToReceiveMs",
    ],
    [
      "decode_to_present",
      row.decodeToPresentMs,
      "decodeToPresentMs",
    ],
    ["display_wait", row.displayWaitMs, "displayWaitMs"],
    ["frame_decode", row.frameDecodeMs, "frameDecodeMs"],
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
    ["submit_latency", row.submitMs, "submitMs"],
    [
      "presentation_queue",
      row.presentationQueueMs,
      "presentationQueueMs",
    ],
    ["encode_latency", row.encodeMs, "encodeMs"],
    ["decode_time", row.decodeMs, "decodeMs"],
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

  const primary =
    row.direction === "send"
      ? sendLatency
        ? []
        : [
            row.captureToEncodeMs !== undefined
              ? "captureToEncodeMs"
              : "encodeMs",
            "sendDelayMs",
          ]
      : row.direction === "receive" && !row.preview
        ? ["roundTripMs", "receiveToDecodeMs"]
        : row.preview
          ? ["submitMs"]
          : [];
  const latency = primary.flatMap((key) =>
    details.filter((item) => item.key === key),
  );
  return {
    title: statisticsTitle(row),
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
    summary: [
      ...(sendLatency ? [sendLatency] : []),
      ...latency,
      ...summary,
    ],
    details: details.filter(
      (item) => !latency.includes(item),
    ),
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
