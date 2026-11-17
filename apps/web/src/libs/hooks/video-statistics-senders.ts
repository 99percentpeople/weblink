import type { VideoStatisticsRow } from "./video-statistics";

export interface SenderStatisticsOverview {
  sendLatencyMs?: number;
  sendScope?: string;
  bitrate?: number;
  slowest: VideoStatisticsRow[];
}

const valid = (value?: number): value is number =>
  value !== undefined &&
  Number.isFinite(value) &&
  value >= 0;

/** Aggregate actual outgoing connections, excluding local preview loopback. */
export function senderStatisticsOverview(
  rows: readonly VideoStatisticsRow[],
): SenderStatisticsOverview {
  const senders = rows.filter(
    (row) => row.direction === "send" && !row.preview,
  );
  let sendLatencyMs: number | undefined;
  let slowest: VideoStatisticsRow[] = [];
  const measured = senders.filter(
    (row) =>
      valid(row.sendLatencyMs) && row.sendLatencyBasis,
  );
  const scopes = new Set(
    measured.map((row) =>
      row.sendLatencyBasis === "frame"
        ? row.sendLatencyEndpoint
        : "interval",
    ),
  );
  // A partial interval cannot compete with a complete sender interval.
  const sendScope =
    scopes.size === 1
      ? scopes.values().next().value
      : undefined;
  for (const row of sendScope ? measured : []) {
    if (!valid(row.sendLatencyMs)) continue;
    if (
      sendLatencyMs === undefined ||
      row.sendLatencyMs > sendLatencyMs
    ) {
      sendLatencyMs = row.sendLatencyMs;
      slowest = [row];
    } else if (row.sendLatencyMs === sendLatencyMs)
      slowest.push(row);
  }
  // A missing stream is unknown traffic, not zero traffic.
  const total =
    senders.length &&
    senders.every((row) => valid(row.bitrate))
      ? senders.reduce((sum, row) => sum + row.bitrate!, 0)
      : undefined;
  return {
    sendLatencyMs,
    sendScope,
    bitrate: valid(total) ? total : undefined,
    slowest,
  };
}
