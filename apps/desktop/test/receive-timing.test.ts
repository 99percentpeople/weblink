import { expect, it } from "vitest";
import { ReceiveTiming } from "../src/receive-timing";

it("keeps lifetime totals and a bounded recent distribution", () => {
  const timing = new ReceiveTiming();
  for (const sample of [NaN, Infinity, -1])
    timing.record(sample);
  expect(timing.read()).toMatchObject({
    count: 0,
    windowCount: 0,
    p95Ms: null,
  });
  for (let sample = 1; sample <= 300; sample++)
    timing.record(sample);
  expect(timing.read()).toEqual({
    count: 300,
    totalMs: 45150,
    maxMs: 300,
    windowCount: 256,
    p50Ms: 172,
    p95Ms: 288,
  });
});
