export const STATISTICS_HISTORY_MS = 60_000;
const MAX_POINTS = 61;
const fields = [
  "fps",
  "bitrate",
  "onePercentLowFps",
  "targetBitrate",
  "encoderBitrate",
  "availableOutgoingBitrate",
  "droppedPerSecond",
  "receiveToPresentMs",
  "captureToReceiveMs",
  "decodeToPresentMs",
  "displayWaitMs",
  "frameDecodeMs",
  "endToEndMs",
  "receiveToDecodeMs",
  "submitMs",
  "presentationQueueMs",
  "encodeMs",
  "decodeMs",
  "jitterMs",
  "encoderQueueMs",
  "captureToEncodeMs",
  "sendDelayMs",
  "sendLatencyMs",
  "captureToPacketizerMs",
  "packetizerToSendMs",
  "roundTripMs",
] as const;

export type StatisticsHistoryKey = (typeof fields)[number];
type Values = Partial<Record<StatisticsHistoryKey, number>>;
export interface StatisticsHistoryPoint extends Values {
  /** Monotonic sampling time, in milliseconds. */
  at: number;
}
export interface StatisticsTrend {
  key: StatisticsHistoryKey;
  samples: readonly StatisticsHistoryPoint[];
}

/** A bounded numeric history; missing readings remain gaps, never zeroes. */
export function appendStatisticsHistory(
  history: readonly StatisticsHistoryPoint[],
  values: Values,
  at: number,
): StatisticsHistoryPoint[] {
  const point: StatisticsHistoryPoint = { at };
  for (const key of fields) {
    const value = values[key];
    if (
      value !== undefined &&
      Number.isFinite(value) &&
      value >= 0
    )
      point[key] = value;
  }
  const previous =
    (history.at(-1)?.at ?? at) > at ? [] : history;
  return [
    ...previous
      .filter(
        (sample) =>
          sample.at >= at - STATISTICS_HISTORY_MS &&
          sample.at < at,
      )
      .slice(-(MAX_POINTS - 1)),
    point,
  ];
}

/** Do not interpolate across unavailable readings or delayed sampling. */
export function statisticsTrendSegments(
  trend: StatisticsTrend,
): StatisticsHistoryPoint[][] {
  const segments: StatisticsHistoryPoint[][] = [];
  let previous: StatisticsHistoryPoint | undefined;
  for (const sample of trend.samples) {
    const value = sample[trend.key];
    if (
      value === undefined ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      previous = undefined;
      continue;
    }
    if (
      !previous ||
      sample.at <= previous.at ||
      sample.at - previous.at > 2500
    )
      segments.push([]);
    segments[segments.length - 1].push(sample);
    previous = sample;
  }
  return segments;
}
