import { expect, it } from "vitest";
import {
  touchMovementSamples,
  touchSample,
} from "@/libs/domain/remote-control/touch-sampling";

const position = { x: 0.25, y: 0.75 };
const size = { width: 200, height: 100 };

it("normalizes browser contact dimensions against video content and preserves pressure", () => {
  expect(
    touchSample(
      { pressure: 0.25, width: 20, height: 15 },
      position,
      size,
      true,
    ),
  ).toEqual({
    ...position,
    pressure: 0.25,
    width: 0.1,
    height: 0.15,
  });
  expect(
    touchSample(
      { pressure: 1, width: 400, height: 300 },
      position,
      size,
      true,
    ),
  ).toEqual({
    ...position,
    pressure: 1,
    width: 1,
    height: 1,
  });
  expect(
    touchSample(
      { pressure: 0.5, width: 0.5, height: 0.5 },
      position,
      size,
      true,
    ),
  ).toMatchObject({ width: 0.0025, height: 0.005 });
});

it("omits properties when disabled or unavailable instead of inventing contact geometry", () => {
  expect(
    touchSample(
      { pressure: 0.25, width: 20, height: 15 },
      position,
      size,
      false,
    ),
  ).toEqual(position);
  expect(
    touchSample(
      { pressure: 0.5, width: 1, height: 1 },
      position,
      size,
      true,
    ),
  ).toEqual({ ...position, pressure: 0.5 });
  expect(
    touchSample(
      { pressure: NaN, width: Infinity, height: -1 },
      position,
      size,
      true,
    ),
  ).toEqual(position);
  expect(
    touchSample(
      { pressure: 2, width: 10, height: 10 },
      position,
      { width: 0, height: 100 },
      true,
    ),
  ).toEqual(position);
});

it("uses actual coalesced movement in order without duplicating the parent or adding predictions", () => {
  const samples = [
    { clientX: 10 },
    { clientX: 20 },
  ] as PointerEvent[];
  const event = {
    getCoalescedEvents: () => samples,
    getPredictedEvents: () => {
      throw new Error("Do not send predictions");
    },
  } as unknown as PointerEvent;
  expect(touchMovementSamples(event)).toBe(samples);
  const unsupported = {} as PointerEvent;
  expect(touchMovementSamples(unsupported)).toEqual([
    unsupported,
  ]);
  const empty = {
    getCoalescedEvents: () => [],
  } as unknown as PointerEvent;
  expect(touchMovementSamples(empty)).toEqual([empty]);
});
