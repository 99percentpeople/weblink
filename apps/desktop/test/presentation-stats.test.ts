import { expect, it } from "vitest";
import { createNativePresentationStats } from "../src/presentation-stats";
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
