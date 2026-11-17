import { expect, it } from "vitest";
import { createNativePresentationStats } from "../src/presentation-stats";
import type { NativePresentationSnapshot } from "../src/presentation-stats";

it("keeps native same-frame segments together and expires all presentation timings", () => {
  const value: NativePresentationSnapshot = {
    at: 1000,
    frames: 1,
    visible: true,
    timingAgeMs: 100,
    endToEndMs: 60,
    captureToReceiveMs: 30,
    receiveToPresentMs: 30,
    decodeToPresentMs: 20,
    presentationQueueMs: 4,
    submitMs: 1,
  };
  const stats = createNativePresentationStats(() => value);
  const fresh = stats.read(1000);
  expect(
    fresh.captureToReceiveMs! + fresh.receiveToPresentMs!,
  ).toBe(fresh.endToEndMs);
  expect(fresh.decodeToPresentMs).toBe(20);
  expect(fresh.latencyEndpoint).toBe("compositor-submit");
  const stale = stats.read(2401);
  for (const key of [
    "endToEndMs",
    "captureToReceiveMs",
    "receiveToPresentMs",
    "decodeToPresentMs",
    "presentationQueueMs",
    "submitMs",
  ] as const)
    expect(stale[key]).toBeUndefined();
  value.at = 2500;
  value.timingAgeMs = 1600;
  expect(
    stats.read(2500).receiveToPresentMs,
  ).toBeUndefined();
  stats.close();
});

it("exports native end-to-end estimates and expires them using the frame age, not the polling age", () => {
  const value: NativePresentationSnapshot = {
    at: 1000,
    frames: 60,
    visible: true,
    endToEndMs: 80,
    endToEndAgeMs: 400,
  };
  const sampler = createNativePresentationStats(
    () => value,
  );
  expect(sampler.read(1000)).toMatchObject({
    endToEndMs: 80,
    endToEndState: "estimated",
  });
  expect(sampler.read(2100).endToEndMs).toBe(80);
  expect(sampler.read(2101).endToEndMs).toBeUndefined();
  expect(sampler.read(2101).endToEndState).toBeUndefined();
  expect(sampler.read(999).endToEndMs).toBeUndefined();
  value.at = 2200;
  value.endToEndAgeMs = 1600;
  expect(sampler.read(2200).endToEndMs).toBeUndefined();
  value.frames = 61;
  value.endToEndAgeMs = 0;
  value.endToEndMs = 0;
  expect(sampler.read(2200)).toMatchObject({
    endToEndMs: 0,
    endToEndState: "estimated",
  });
  value.visible = false;
  expect(sampler.read(2200)).toEqual({});
  value.visible = true;
  sampler.close();
  expect(sampler.read(2200)).toEqual({});
});

it.each([undefined, null, NaN, Infinity, -1])(
  "omits unavailable end-to-end delay or age: %s",
  (invalid) => {
    const value: NativePresentationSnapshot = {
      at: 1000,
      frames: 60,
      visible: true,
      endToEndMs: invalid,
      endToEndAgeMs: 0,
    };
    const sampler = createNativePresentationStats(
      () => value,
    );
    expect(sampler.read(1000).endToEndMs).toBeUndefined();
    value.endToEndMs = 80;
    value.endToEndAgeMs = invalid;
    expect(sampler.read(1000).endToEndMs).toBeUndefined();
    expect(
      sampler.read(1000).endToEndState,
    ).toBeUndefined();
    sampler.close();
  },
);

it("reports actual native submission and ready-to-submit timings only after a frame is presented", () => {
  const value: NativePresentationSnapshot = {
    at: 1000,
    frames: 0,
    visible: true,
    submitMs: 0,
    presentationQueueMs: 0,
    timingAgeMs: 0,
  };
  const sampler = createNativePresentationStats(
    () => value,
  );
  expect(sampler.read().submitMs).toBeUndefined();
  expect(
    sampler.read().presentationQueueMs,
  ).toBeUndefined();
  value.frames = 1;
  value.submitMs = 0.25;
  value.presentationQueueMs = 1.5;
  expect(sampler.read(1000)).toMatchObject({
    submitMs: 0.25,
    presentationQueueMs: 1.5,
  });
  value.submitMs = 0;
  value.presentationQueueMs = 0;
  expect(sampler.read(1000)).toMatchObject({
    submitMs: 0,
    presentationQueueMs: 0,
  });
  value.visible = false;
  expect(sampler.read()).toEqual({});
  value.visible = true;
  sampler.close();
  expect(sampler.read()).toEqual({});
});

it.each([undefined, Number.NaN, Infinity, -1])(
  "omits unavailable native timings: %s",
  (value) => {
    const sampler = createNativePresentationStats(() => ({
      at: 1000,
      frames: 60,
      visible: true,
      submitMs: value,
      presentationQueueMs: value,
    }));
    expect(sampler.read().submitMs).toBeUndefined();
    expect(
      sampler.read().presentationQueueMs,
    ).toBeUndefined();
    sampler.close();
  },
);

it("counts native submissions and ignores repeated snapshots, hides and counter resets", () => {
  let value = { at: 1000, frames: 100, visible: true };
  const sampler = createNativePresentationStats(
    () => value,
  );
  expect(sampler.read().fps).toBeUndefined();
  value = { ...value, at: 2000, frames: 160 };
  expect(sampler.read().fps).toBe(60);
  expect(sampler.read().fps).toBe(60);
  value.visible = false;
  expect(sampler.read()).toEqual({});
  value = { at: 5000, frames: 190, visible: true };
  expect(sampler.read().fps).toBeUndefined();
  value = { at: 6000, frames: 10, visible: true };
  expect(sampler.read().fps).toBeUndefined();
  sampler.close();
  expect(sampler.read()).toEqual({});
});

it("uses measured native low FPS independently of the per-second frame average", () => {
  const value: NativePresentationSnapshot = {
    at: 1000,
    frames: 100,
    visible: true,
    onePercentLowFps: 25,
  };
  const sampler = createNativePresentationStats(
    () => value,
  );
  expect(sampler.read()).toMatchObject({
    onePercentLowFps: 25,
    totalFrames: 100,
  });
  value.at = 2000;
  value.frames = 160;
  value.onePercentLowFps = 40;
  expect(sampler.read()).toMatchObject({
    fps: 60,
    onePercentLowFps: 40,
  });
  expect(sampler.read().onePercentLowState).toBeUndefined();
  value.at = 3000;
  value.frames = 160;
  value.onePercentLowFps = 0;
  expect(sampler.read()).toMatchObject({
    fps: 0,
    onePercentLowFps: 0,
  });
  value.visible = false;
  expect(sampler.read()).toEqual({});
  value.visible = true;
  value.at = 5000;
  expect(sampler.read().fps).toBeUndefined();
  expect(sampler.read().onePercentLowFps).toBe(0);
  sampler.close();
  expect(sampler.read()).toEqual({});
});

it.each([undefined, null, Number.NaN, Infinity, -1])(
  "keeps unsupported or invalid low FPS unavailable: %s",
  (low) => {
    const sampler = createNativePresentationStats(() => ({
      at: 1000,
      frames: 60,
      visible: true,
      onePercentLowFps: low,
    }));
    expect(sampler.read().onePercentLowFps).toBeUndefined();
    expect(sampler.read().onePercentLowState).toBe(
      "unsupported",
    );
    sampler.close();
  },
);

it("preserves low estimates and resets average FPS when the sample clock restarts", () => {
  let value: NativePresentationSnapshot = {
    at: 1000,
    frames: 100,
    visible: true,
    onePercentLowFps: 30,
    onePercentLowState: "estimated",
  };
  const sampler = createNativePresentationStats(
    () => value,
  );
  expect(sampler.read().onePercentLowState).toBe(
    "estimated",
  );
  value = { ...value, at: 2000, frames: 160 };
  expect(sampler.read().fps).toBe(60);
  value = {
    ...value,
    at: 100,
    frames: 1,
    onePercentLowFps: 0,
  };
  expect(sampler.read().fps).toBeUndefined();
  expect(sampler.read().onePercentLowFps).toBe(0);
  sampler.close();
});
