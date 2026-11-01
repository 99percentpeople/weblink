import { expect, it } from "vitest";
import { readNativeReceiveStats } from "../../src/libs/domain/native-receive-stats";
import { readVideoStatsReport } from "../../src/libs/domain/video-stats";
import { AutomationDiagnostics } from "../../src/libs/application/automation/diagnostics";

it("exports native GPU counters without treating them as shared-buffer or placeholder statistics", () => {
  const stats = readNativeReceiveStats({
    mode: "gpu",
    slots: 0,
    decodedFrames: 60,
    renderer: {
      path: "d3d11-composition",
      presentedFrames: 59,
      uploadedFrames: 0,
      decodedQueueMs: 0.4,
      submitMs: 0.3,
      privateTexture: "hidden",
    },
  });
  expect(stats).toMatchObject({
    mode: "gpu",
    slots: 0,
    renderer: {
      presentedFrames: 59,
      uploadedFrames: 0,
      decodedQueueMs: 0.4,
    },
  });
  expect(JSON.stringify(stats)).not.toContain(
    "privateTexture",
  );
  expect(
    readNativeReceiveStats({ mode: "gpu", slots: 2 }),
  ).toBeUndefined();
});

it("carries sanitized native stages through receive stats into bounded detailed captures", async () => {
  const reports = new Map([
    [
      "video",
      {
        id: "video",
        type: "inbound-rtp",
        kind: "video",
        timestamp: 1000,
        framesDecoded: 60,
        nativeReceive: {
          mode: "push",
          slots: 2,
          pushedFrames: 59,
          privateValue: "must not export",
          renderer: { submittedFrames: 58 },
        },
      },
    ],
  ]) as unknown as RTCStatsReport;
  const samples = readVideoStatsReport(reports, "receive");
  expect(samples[0].nativeReceive).toMatchObject({
    pushedFrames: 59,
    renderer: { submittedFrames: 58 },
  });
  let now = 1000;
  const diagnostics = new AutomationDiagnostics(
    () => [
      {
        id: "screen",
        read: async () => [
          { key: "native", direction: "receive", samples },
        ],
        state: () => ({}),
      },
    ],
    () => now,
  );
  try {
    await diagnostics.sample();
    expect(
      JSON.stringify(diagnostics.snapshot()),
    ).not.toContain("nativeReceive");
    diagnostics.detail(1000);
    await diagnostics.sample();
    const detail = JSON.stringify(diagnostics.snapshot());
    expect(detail).toContain('"pushedFrames":59');
    expect(detail).toContain('"submittedFrames":58');
    expect(detail).not.toContain("must not export");
    now += 1000;
    await diagnostics.sample();
    expect(
      JSON.stringify(diagnostics.snapshot()),
    ).not.toContain("nativeReceive");
  } finally {
    diagnostics.dispose();
  }
});

it("exports only known finite stages and rejects oversized diagnostic windows", () => {
  const timing = {
    count: 300,
    totalMs: 100,
    maxMs: 3,
    windowCount: 256,
    p50Ms: 0.2,
    p95Ms: 0.8,
  };
  const value = readNativeReceiveStats({
    mode: "push",
    slots: 2,
    decodedFrames: 300,
    arbitrary: "private",
    pixelCopyMs: timing,
    workerQueueMs: { ...timing, windowCount: 10000 },
    renderer: {
      submittedFrames: 299,
      hiddenFrames: -1,
      receivedFrames: Infinity,
      secret: "private",
      presenterWriteMs: timing,
    },
  });
  expect(value).toMatchObject({
    mode: "push",
    decodedFrames: 300,
    pixelCopyMs: timing,
    renderer: {
      submittedFrames: 299,
      presenterWriteMs: timing,
    },
  });
  expect(value?.workerQueueMs).toBeUndefined();
  expect(value?.renderer?.hiddenFrames).toBeUndefined();
  expect(value?.renderer?.receivedFrames).toBeUndefined();
  expect(JSON.stringify(value)).not.toContain("private");
  expect(
    readNativeReceiveStats({ mode: "push", slots: 999 }),
  ).toBeUndefined();
  expect(readNativeReceiveStats(null)).toBeUndefined();
});

it("keeps absent decode-stage data absent and accepts an empty sample window", () => {
  const value = readNativeReceiveStats({
    mode: "push",
    slots: 2,
    pixelCopyMs: {
      count: 0,
      totalMs: 0,
      maxMs: 0,
      windowCount: 0,
      p50Ms: null,
      p95Ms: null,
    },
  });
  expect(value?.decodedQueueMs).toBeUndefined();
  expect(value?.pixelCopyMs).toEqual({
    count: 0,
    totalMs: 0,
    maxMs: 0,
    windowCount: 0,
    p50Ms: undefined,
    p95Ms: undefined,
  });
});
