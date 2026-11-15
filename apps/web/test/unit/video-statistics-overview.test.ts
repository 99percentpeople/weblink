import { expect, it, vi } from "vitest";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import { formatVideoStatisticsOverview } from "@/routes/home/components/video-statistics-overview";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

it("prioritizes presentation latency, FPS and 1% Low over transport readings", () => {
  const history = [
    {
      at: 1000,
      receiveToPresentMs: 30,
      fps: 59,
      onePercentLowFps: 45,
    },
  ];
  const result = formatVideoStatisticsOverview([
    {
      direction: "send",
      fps: 120,
      captureToEncodeMs: 4,
      roundTripMs: 10,
    },
    {
      direction: "receive",
      fps: 60,
      receiveToDecodeMs: 20,
      bitrate: 5_000_000,
    },
    {
      direction: "display",
      receiveToPresentMs: 30,
      fps: 59,
      onePercentLowFps: 45,
      droppedPerSecond: 2,
      history,
    },
  ]);
  expect(
    result.map(({ label, value }) => [label, value]),
  ).toEqual([
    ["video.statistics.receive_to_present", "30.0 ms"],
    ["video.statistics.frame_rate", "59.0 FPS"],
    ["video.statistics.one_percent_low_short", "45.0 FPS"],
  ]);
  expect(result.map((item) => item.trend?.key)).toEqual([
    "receiveToPresentMs",
    "fps",
    "onePercentLowFps",
  ]);
  for (const item of result)
    expect(item.trend?.samples).toBe(history);
});

it("preserves measured zeroes and unavailable presentation readings instead of substituting healthy decoder data", () => {
  const display: VideoStatisticsRow = {
    direction: "display",
    receiveToPresentMs: 0,
    fps: 0,
    history: [{ at: 1000, receiveToPresentMs: 0, fps: 0 }],
  };
  const receive: VideoStatisticsRow = {
    direction: "receive",
    fps: 60,
    receiveToDecodeMs: 10,
    roundTripMs: 5,
  };
  expect(
    formatVideoStatisticsOverview([display, receive])
      .slice(0, 2)
      .map((item) => item.value),
  ).toEqual(["0.0 ms", "0.0 FPS"]);
  const unavailable = formatVideoStatisticsOverview([
    {
      ...display,
      fps: undefined,
      receiveToPresentMs: undefined,
      history: [...display.history!, { at: 2000 }],
    },
    receive,
  ]);
  expect(
    unavailable.slice(0, 2).map((item) => item.value),
  ).toEqual(["—", "—"]);
  expect(unavailable[0].label).toBe(
    "video.statistics.receive_to_present",
  );
  expect(unavailable[1].label).toBe(
    "video.statistics.frame_rate",
  );
});

it("labels receive, sender and RTT fallbacks with their actual measurement stage", () => {
  const received = formatVideoStatisticsOverview([
    {
      direction: "display",
      onePercentLowState: "unsupported",
    },
    {
      direction: "receive",
      fps: 60,
      receiveToDecodeMs: 15,
      roundTripMs: 25,
    },
  ]);
  expect(received[0]).toMatchObject({
    label: "video.statistics.receive_to_decode",
    value: "15.0 ms",
  });
  expect(received[1]).toMatchObject({
    label: "video.statistics.decode",
    value: "60.0 FPS",
  });
  const sent = formatVideoStatisticsOverview([
    {
      direction: "send",
      fps: 30,
      captureToEncodeMs: 8,
      roundTripMs: 20,
    },
  ]);
  expect(sent[0]).toMatchObject({
    label: "video.statistics.capture_to_encode",
    value: "8.0 ms",
  });
  expect(sent[1]).toMatchObject({
    label: "video.statistics.encode",
    value: "30.0 FPS",
  });
  const network = formatVideoStatisticsOverview([
    {
      direction: "receive",
      receiveToDecodeMs: Number.NaN,
      roundTripMs: 20,
      fps: Infinity,
    },
  ]);
  expect(network[0]).toMatchObject({
    label: "video.statistics.rtt",
    value: "20.0 ms",
  });
  expect(network[1].value).toBe("—");
});

it("does not choose arbitrary viewers or mix their histories", () => {
  const rows: VideoStatisticsRow[] = [
    {
      direction: "send",
      peer: "A",
      fps: 60,
      roundTripMs: 10,
      history: [{ at: 1000, fps: 60, roundTripMs: 10 }],
    },
    {
      direction: "send",
      peer: "B",
      fps: 30,
      roundTripMs: 20,
      history: [{ at: 1000, fps: 30, roundTripMs: 20 }],
    },
  ];
  const result = formatVideoStatisticsOverview(rows);
  expect(result.map((item) => item.value)).toEqual([
    "—",
    "—",
    "—",
  ]);
  expect(
    result.every((item) => item.trend === undefined),
  ).toBe(true);
  expect(
    formatVideoStatisticsOverview([...rows].reverse()),
  ).toEqual(result);
});

it("keeps estimated lows explicit and never derives low FPS from drop counts", () => {
  const estimated = formatVideoStatisticsOverview([
    {
      direction: "display",
      onePercentLowFps: 45,
      onePercentLowState: "estimated",
    },
  ])[2];
  expect(estimated.value).toBe("≈ 45.0 FPS");
  const unsupported = formatVideoStatisticsOverview([
    {
      direction: "display",
      fps: 60,
      onePercentLowState: "unsupported",
      droppedPerSecond: 10,
      history: [{ at: 1000, onePercentLowFps: 45 }],
    },
  ])[2];
  expect(unsupported.value).toBe("—");
  expect(unsupported.trend).toBeUndefined();
  expect(unsupported.description).toBe(
    "video.statistics.low_unavailable",
  );
});
