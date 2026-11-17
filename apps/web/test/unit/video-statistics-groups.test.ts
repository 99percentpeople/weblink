import { expect, it, vi } from "vitest";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import { formatVideoStatisticsGroups } from "@/routes/home/components/video-statistics-groups";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

it("merges raw local preview and presentation with one authoritative FPS and low", () => {
  const displayHistory = [
    {
      at: 1000,
      fps: 59,
      onePercentLowFps: 40,
      submitMs: 0.1,
    },
  ];
  const rows: VideoStatisticsRow[] = [
    { direction: "send", peer: "A", encodeMs: 2, fps: 60 },
    {
      direction: "receive",
      preview: true,
      fps: 60,
      width: 1920,
      height: 1080,
      implementation: "D3D11",
      history: [{ at: 1000, fps: 60 }],
    },
    {
      direction: "display",
      preview: true,
      fps: 59,
      onePercentLowFps: 40,
      submitMs: 0.1,
      presentationQueueMs: 1,
      implementation: "D3D11",
      history: displayHistory,
    },
  ];
  const before = structuredClone(rows);
  const groups = formatVideoStatisticsGroups(rows);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    title: "video.statistics.preview",
    resolution: "1920 × 1080",
    implementation: "D3D11",
  });
  expect(
    groups[0].summary.map((metric) => [
      metric.key,
      metric.value,
    ]),
  ).toEqual([
    ["submitMs", "0.1 ms"],
    ["fps", "59.0 FPS"],
    ["onePercentLowFps", "40.0 FPS"],
  ]);
  expect(
    groups[0].summary.find((metric) => metric.key === "fps")
      ?.trend?.samples,
  ).toBe(displayHistory);
  expect(
    groups[0].details.map((metric) => metric.key),
  ).toEqual(["presentationQueueMs"]);
  expect(groups[1].summary[0]).toMatchObject({
    key: "encodeMs",
    value: "2.0 ms",
  });
  expect(rows).toEqual(before);
});

it("keeps presentation zeroes and gaps without duplicating healthy raw preview FPS", () => {
  for (const fps of [0, undefined]) {
    const [group] = formatVideoStatisticsGroups([
      { direction: "receive", preview: true, fps: 60 },
      {
        direction: "display",
        preview: true,
        fps,
        history: [
          { at: 1000, fps: 0 },
          { at: 2000, fps },
        ],
      },
    ]);
    const metrics = [
      ...group.summary,
      ...group.details,
    ].filter((metric) => metric.key === "fps");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      label: "video.statistics.frame_rate",
      value: fps === 0 ? "0.0 FPS" : "—",
    });
  }
});

it("labels a raw preview fallback as submissions until presentation has a measurement", () => {
  const [group] = formatVideoStatisticsGroups([
    { direction: "receive", preview: true, fps: 60 },
    { direction: "display", preview: true, submitMs: 0.1 },
  ]);
  expect(
    group.summary.find((metric) => metric.key === "fps"),
  ).toMatchObject({
    label: "video.statistics.submitted",
    value: "60.0 FPS",
  });
});

it("combines receive and playback while retaining decoder rates and independent histories", () => {
  const receiverHistory = [
    {
      at: 1000,
      fps: 60,
      receiveToDecodeMs: 12,
      roundTripMs: 20,
      jitterMs: 8,
      decodeMs: 2,
    },
  ];
  const [group] = formatVideoStatisticsGroups([
    {
      direction: "receive",
      peer: "Alice",
      codec: "video/H264",
      fps: 60,
      receiveToDecodeMs: 12,
      roundTripMs: 20,
      jitterMs: 8,
      decodeMs: 2,
      history: receiverHistory,
    },
    {
      direction: "display",
      fps: 59,
      onePercentLowFps: 30,
      receiveToPresentMs: 25,
      submitMs: 0.3,
    },
  ]);
  expect(group.title).toBe(
    "video.statistics.receive · Alice",
  );
  expect(group.codec).toBe("H264");
  expect(group.summary.map((metric) => metric.key)).toEqual(
    [
      "receiveToPresentMs",
      "roundTripMs",
      "fps",
      "onePercentLowFps",
    ],
  );
  expect(
    group.details.find(
      (metric) => metric.key === "receiveToDecodeMs",
    )?.trend?.samples,
  ).toBe(receiverHistory);
  expect(
    group.details.find((metric) => metric.key === "fps"),
  ).toMatchObject({
    label: "video.statistics.decode_frame_rate",
    value: "60.0 FPS",
    trend: { samples: receiverHistory },
  });
  expect(
    group.details.find(
      (metric) => metric.key === "decodeMs",
    ),
  ).toMatchObject({
    label: "video.statistics.decode_time",
    value: "2.0 ms",
  });
  expect(
    group.details.find(
      (metric) => metric.key === "submitMs",
    )?.value,
  ).toBe("0.3 ms");
});

it("keeps encoded loopback preview stages while merging its playback", () => {
  const groups = formatVideoStatisticsGroups([
    {
      direction: "send",
      preview: true,
      codec: "video/VP8",
      fps: 60,
      encodeMs: 2,
    },
    {
      direction: "receive",
      preview: true,
      codec: "video/VP8",
      fps: 60,
      decodeMs: 1,
    },
    {
      direction: "display",
      preview: true,
      fps: 59,
      onePercentLowFps: 45,
    },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0].title).toBe("video.statistics.preview");
  expect(
    groups[0].details.find((metric) => metric.key === "fps")
      ?.label,
  ).toBe("video.statistics.decode_frame_rate");
  expect(groups[1].title).toBe(
    "video.statistics.encode · video.statistics.preview",
  );
});

it("does not merge ambiguous peers or unrelated local and remote playback", () => {
  for (const rows of [
    [
      { direction: "receive", peer: "A" },
      { direction: "receive", peer: "B" },
      { direction: "display" },
    ],
    [
      { direction: "receive", preview: true },
      { direction: "display" },
    ],
    [
      { direction: "receive", peer: "A" },
      { direction: "display", peer: "B" },
    ],
  ] satisfies VideoStatisticsRow[][]) {
    expect(formatVideoStatisticsGroups(rows)).toHaveLength(
      rows.length,
    );
  }
});
