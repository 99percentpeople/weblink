import { expect, it } from "vitest";
import { createNativePresentationStats } from "../src/presentation-stats";
import type { NativePresentationSnapshot } from "../src/presentation-stats";
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
