import { expect, it, vi } from "vitest";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import { formatVideoStatisticsOverview } from "@/routes/home/components/video-statistics-overview";

vi.mock("@/i18n", () => ({
  t: (key: string, args?: Record<string, unknown>) =>
    args?.peer ? `${key}: ${args.peer}` : key,
}));

it("labels measured sender frames by their endpoint and never adds an estimate marker", () => {
  for (const endpoint of [
    "transport-submit",
    "packetizer-input",
  ] as const) {
    const result = formatVideoStatisticsOverview([
      {
        direction: "send",
        peer: "Viewer",
        sendLatencyMs: 12,
        sendLatencyBasis: "frame",
        sendLatencyEndpoint: endpoint,
        bitrate: 1000,
      },
      { direction: "display", preview: true, fps: 60 },
    ]);
    expect(result[0]).toMatchObject({
      key: "sendLatencyMs",
      value: "12.0 ms",
      label:
        endpoint === "transport-submit"
          ? "video.statistics.send_latency"
          : "video.statistics.send_pre_packetizer",
    });
    expect(result[0].description).toContain("Viewer");
  }
});

it("does not rank different sender intervals against one another", () => {
  const result = formatVideoStatisticsOverview([
    {
      direction: "send",
      peer: "Full",
      sendLatencyMs: 20,
      sendLatencyBasis: "frame",
      sendLatencyEndpoint: "transport-submit",
      bitrate: 1000,
    },
    {
      direction: "send",
      peer: "Partial",
      sendLatencyMs: 40,
      sendLatencyBasis: "frame",
      sendLatencyEndpoint: "packetizer-input",
      bitrate: 2000,
    },
    { direction: "display", preview: true, fps: 60 },
  ]);
  expect(result.map((metric) => metric.key)).toEqual([
    "fps",
    "bitrate",
  ]);
  expect(result[1].value).toBe("3.0 kbps");
});

it("shows only end-to-end latency, FPS and bitrate in the receive overview", () => {
  for (const state of ["estimated", undefined] as const) {
    const history = [{ at: 1000, endToEndMs: 80 }];
    const result = formatVideoStatisticsOverview([
      {
        direction: "receive",
        roundTripMs: 10,
        receiveToDecodeMs: 20,
        jitterMs: 8,
        bitrate: 7_000_000,
      },
      {
        direction: "display",
        endToEndMs: 80,
        endToEndState: state,
        fps: 60,
        onePercentLowFps: 45,
        history,
      },
    ]);
    expect(result[0]).toMatchObject({
      key: "endToEndMs",
      label: "video.statistics.end_to_end",
      value: "80.0 ms",
      trend: { key: "endToEndMs", samples: history },
    });
    expect(result.map((metric) => metric.key)).toEqual([
      "endToEndMs",
      "fps",
      "bitrate",
    ]);
    expect(result[2].value).toBe("7.0 Mbps");
  }
});

it("hides unavailable end-to-end latency even with history, and never shows it for local preview", () => {
  for (const value of [
    undefined,
    Number.NaN,
    Infinity,
    -1,
  ]) {
    const rows: VideoStatisticsRow[] = [
      {
        direction: "display",
        endToEndMs: value,
        endToEndState: "estimated",
        history: [
          { at: 1000, endToEndMs: 80 },
          { at: 2000 },
        ],
      },
    ];
    expect(
      formatVideoStatisticsOverview(rows).some(
        (metric) => metric.key === "endToEndMs",
      ),
    ).toBe(false);
  }
  expect(
    formatVideoStatisticsOverview([
      {
        direction: "display",
        preview: true,
        endToEndMs: 80,
      },
    ]).some((metric) => metric.key === "endToEndMs"),
  ).toBe(false);
  expect(
    formatVideoStatisticsOverview([
      { direction: "display", endToEndMs: 0 },
    ])[0].value,
  ).toBe("0.0 ms");
});

it("keeps partial receive timings out of the overview when end-to-end data is unavailable", () => {
  const receiveHistory = [
    {
      at: 1000,
      roundTripMs: 10,
      receiveToDecodeMs: 20,
      jitterMs: 8,
      bitrate: 5_000_000,
    },
  ];
  const displayHistory = [
    { at: 1000, fps: 59, onePercentLowFps: 45 },
  ];
  const result = formatVideoStatisticsOverview([
    {
      direction: "send",
      fps: 120,
      encodeMs: 4,
      roundTripMs: 99,
    },
    {
      direction: "receive",
      fps: 60,
      roundTripMs: 10,
      receiveToDecodeMs: 20,
      jitterMs: 8,
      decodeMs: 2,
      bitrate: 5_000_000,
      history: receiveHistory,
    },
    {
      direction: "display",
      receiveToPresentMs: 30,
      fps: 59,
      onePercentLowFps: 45,
      submitMs: 0.1,
      history: displayHistory,
    },
  ]);
  expect(
    result.map(({ label, value }) => [label, value]),
  ).toEqual([
    ["video.statistics.frame_rate", "59.0 FPS"],
    ["video.statistics.bitrate", "5.0 Mbps"],
  ]);
  expect(result.map((item) => item.trend?.key)).toEqual([
    "fps",
    "bitrate",
  ]);
  expect(result[0].trend?.samples).toBe(displayHistory);
  expect(result[1].trend?.samples).toBe(receiveHistory);
});

it("shows one sender latency without adding preview submission or network delay", () => {
  const history = [{ at: 1000, sendLatencyMs: 11 }];
  const result = formatVideoStatisticsOverview([
    {
      direction: "send",
      encodeMs: 4,
      captureToEncodeMs: 8,
      sendDelayMs: 3,
      sendLatencyMs: 11,
      sendLatencyBasis: "capture",
      history,
      roundTripMs: 10,
      bitrate: 8_000_000,
    },
    {
      direction: "send",
      preview: true,
      encodeMs: 2,
      bitrate: 2_000_000,
    },
    {
      direction: "receive",
      preview: true,
      fps: 60,
      receiveToDecodeMs: 3,
      roundTripMs: 1,
    },
    {
      direction: "display",
      preview: true,
      fps: 59,
      onePercentLowFps: 45,
      submitMs: 0.2,
      presentationQueueMs: 1.5,
    },
  ]);
  expect(
    result.map(({ label, value }) => [label, value]),
  ).toEqual([
    ["video.statistics.send_latency", "11.0 ms"],
    ["video.statistics.frame_rate", "59.0 FPS"],
    ["video.statistics.total_bitrate", "8.0 Mbps"],
  ]);
  expect(result[0]).toMatchObject({
    description:
      "video.statistics.slowest_receiver: video.statistics.unnamed_receiver\nvideo.statistics.send_latency_description",
    trend: { key: "sendLatencyMs", samples: history },
  });
});

it("omits unmeasured local latency instead of borrowing other pipeline stages", () => {
  const result = formatVideoStatisticsOverview([
    {
      direction: "send",
      captureToEncodeMs: 8,
      encodeMs: 4,
      history: [{ at: 1000, sendLatencyMs: 11 }],
      roundTripMs: 10,
    },
    { direction: "receive", preview: true, fps: 60 },
    {
      direction: "display",
      preview: true,
      fps: 59,
      onePercentLowFps: 45,
      submitMs: 0.2,
    },
  ]);
  expect(result.map((item) => item.key)).toEqual([
    "fps",
    "bitrate",
  ]);
  expect(result.map((item) => item.value)).toEqual([
    "59.0 FPS",
    "—",
  ]);
});

it("explains partial sender estimates, retains zeroes and hides unavailable or preview values", () => {
  const sender: VideoStatisticsRow = {
    direction: "send",
    sendLatencyMs: 0,
    sendLatencyBasis: "encode",
    history: [{ at: 1000, sendLatencyMs: 12 }],
  };
  expect(
    formatVideoStatisticsOverview([sender])[0],
  ).toMatchObject({
    key: "sendLatencyMs",
    value: "0.0 ms",
    description:
      "video.statistics.slowest_receiver: video.statistics.unnamed_receiver\nvideo.statistics.send_latency_partial_description",
  });
  for (const row of [
    ...[undefined, NaN, Infinity, -1].map(
      (sendLatencyMs) => ({ ...sender, sendLatencyMs }),
    ),
    { ...sender, sendLatencyBasis: undefined },
    { ...sender, preview: true },
  ]) {
    expect(
      formatVideoStatisticsOverview([row]).map(
        (metric) => metric.key,
      ),
    ).toEqual(["fps", "bitrate"]);
  }
});

it("preserves measured zeroes and gaps instead of substituting healthy decoder data", () => {
  const display: VideoStatisticsRow = {
    direction: "display",
    fps: 0,
    history: [{ at: 1000, fps: 0 }],
  };
  const receive: VideoStatisticsRow = {
    direction: "receive",
    fps: 60,
    receiveToDecodeMs: 0,
    roundTripMs: 0,
    jitterMs: 0,
    history: [
      {
        at: 1000,
        receiveToDecodeMs: 0,
        roundTripMs: 0,
        jitterMs: 0,
      },
    ],
  };
  expect(
    formatVideoStatisticsOverview([display, receive]).map(
      (item) => item.value,
    ),
  ).toEqual(["0.0 FPS", "—"]);
  const unavailable = formatVideoStatisticsOverview([
    {
      ...display,
      fps: undefined,
      history: [...display.history!, { at: 2000 }],
    },
    {
      ...receive,
      receiveToDecodeMs: undefined,
      roundTripMs: undefined,
      jitterMs: undefined,
      history: [...receive.history!, { at: 2000 }],
    },
  ]);
  expect(unavailable.map((item) => item.value)).toEqual([
    "—",
    "—",
  ]);
  expect(
    unavailable.find((item) => item.key === "fps")?.label,
  ).toBe("video.statistics.frame_rate");
});

it("labels frame rate fallbacks with the stage actually measured", () => {
  for (const [row, label] of [
    [
      { direction: "receive", fps: 60 },
      "decode_frame_rate",
    ],
    [
      { direction: "receive", preview: true, fps: 60 },
      "submitted",
    ],
  ] as const) {
    const result = formatVideoStatisticsOverview([row]);
    expect(result[0]).toMatchObject({
      label: `video.statistics.${label}`,
      value: "60.0 FPS",
    });
  }
  const result = formatVideoStatisticsOverview([
    {
      direction: "receive",
      receiveToDecodeMs: Number.NaN,
      roundTripMs: 20,
      fps: Infinity,
    },
  ]);
  expect(result.map((item) => item.value)).toEqual([
    "—",
    "—",
  ]);
});

it("shows the slowest receiver, local FPS and total traffic with sampled aggregate histories", () => {
  const history = [
    { at: 1000, sendLatencyMs: 12, bitrate: 5_000_000 },
    { at: 2000, sendLatencyMs: 10, bitrate: 10_000_000 },
  ];
  const rows: VideoStatisticsRow[] = [
    {
      direction: "send",
      peer: "A",
      fps: 60,
      encodeMs: 4,
      sendLatencyMs: 6,
      sendLatencyBasis: "encode",
      bitrate: 4_000_000,
      history: [
        { at: 1000, sendLatencyMs: 12 },
        { at: 2000, sendLatencyMs: 6 },
      ],
    },
    {
      direction: "send",
      peer: "B",
      fps: 30,
      encodeMs: 8,
      sendLatencyMs: 10,
      sendLatencyBasis: "encode",
      bitrate: 6_000_000,
      history: [
        { at: 1000, sendLatencyMs: 4 },
        { at: 2000, sendLatencyMs: 10 },
      ],
    },
    {
      direction: "send",
      preview: true,
      encodeMs: 1,
      bitrate: 100_000_000,
      sendLatencyMs: 900,
      sendLatencyBasis: "encode",
    },
    {
      direction: "display",
      preview: true,
      fps: 59,
      senderOverviewHistory: history,
    },
  ];
  const before = structuredClone(rows);
  const result = formatVideoStatisticsOverview(rows);
  expect(result.map((item) => item.value)).toEqual([
    "10.0 ms",
    "59.0 FPS",
    "10.0 Mbps",
  ]);
  expect(result[0].description).toBe(
    "video.statistics.slowest_receiver: B\nvideo.statistics.send_latency_partial_description",
  );
  expect(result[0].trend?.samples).toBe(history);
  expect(result[2]).toMatchObject({
    label: "video.statistics.total_bitrate",
    trend: { key: "bitrate", samples: history },
  });
  expect(
    formatVideoStatisticsOverview([...rows].reverse()),
  ).toEqual(result);
  expect(rows).toEqual(before);
});

it("names tied receivers and keeps local frame gaps instead of using a viewer's encoder FPS", () => {
  const senders: VideoStatisticsRow[] = ["B", "A"].map(
    (peer) => ({
      direction: "send",
      peer,
      sendLatencyMs: 0,
      sendLatencyBasis: "encode",
      bitrate: 0,
      fps: 60,
    }),
  );
  for (const display of [
    [],
    [
      {
        direction: "display",
        preview: true,
        history: [{ at: 1000, fps: 59 }, { at: 2000 }],
      },
    ],
  ] as VideoStatisticsRow[][]) {
    const result = formatVideoStatisticsOverview([
      ...senders,
      ...display,
    ]);
    expect(result.map((metric) => metric.value)).toEqual([
      "0.0 ms",
      "—",
      "0.0 kbps",
    ]);
    expect(result[0].description).toContain(
      "video.statistics.slowest_receiver: A, B",
    );
    expect(result[1].label).toBe(
      "video.statistics.frame_rate",
    );
  }
});

it("does not count missing bitrates as zero or take stale and unsupported delays as the slowest", () => {
  const sender: VideoStatisticsRow = {
    direction: "send",
    peer: "A",
    bitrate: 5_000_000,
    sendLatencyMs: 8,
    sendLatencyBasis: "capture",
  };
  for (const invalid of [undefined, NaN, Infinity, -1]) {
    const result = formatVideoStatisticsOverview([
      sender,
      {
        direction: "send",
        peer: "B",
        bitrate: invalid,
        sendLatencyMs: invalid,
        sendLatencyBasis: "encode",
        history: [
          {
            at: 1000,
            bitrate: 4_000_000,
            sendLatencyMs: 100,
          },
        ],
      },
    ]);
    expect(result.map((metric) => metric.value)).toEqual([
      "8.0 ms",
      "—",
      "—",
    ]);
    expect(result[0].description).toContain(
      "video.statistics.slowest_receiver: A\n",
    );
    expect(result[0].trend).toBeUndefined();
    expect(result[2].trend).toBeUndefined();
  }
  const preview: VideoStatisticsRow = {
    ...sender,
    preview: true,
  };
  expect(
    formatVideoStatisticsOverview([preview]).map(
      (metric) => metric.value,
    ),
  ).toEqual(["—", "—"]);
  const unknownScope = formatVideoStatisticsOverview([
    sender,
    {
      ...sender,
      peer: "B",
      sendLatencyMs: 100,
      sendLatencyBasis: undefined,
    },
  ]);
  expect(unknownScope[0].value).toBe("8.0 ms");
  expect(unknownScope[2].value).toBe("10.0 Mbps");
});

it("preserves zero bitrate and unavailable samples without borrowing send traffic", () => {
  for (const [bitrate, value] of [
    [0, "0.0 kbps"],
    [undefined, "—"],
    [Infinity, "—"],
  ] as const) {
    const history = [{ at: 1000, bitrate: 5_000_000 }];
    const result = formatVideoStatisticsOverview([
      { direction: "receive", bitrate, history },
      { direction: "send", bitrate: 8_000_000 },
    ]);
    expect(result[1]).toMatchObject({
      key: "bitrate",
      value,
      trend: { key: "bitrate", samples: history },
    });
  }
});
