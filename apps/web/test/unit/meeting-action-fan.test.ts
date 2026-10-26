import { describe, expect, it } from "vitest";
import {
  layoutActionFan,
  type ActionFanSpace,
} from "@/routes/home/components/meeting-action-fan";

const space: ActionFanSpace = {
  width: 600,
  height: 600,
  x: 278,
  y: 278,
  size: 44,
};

describe("meeting action layout selection", () => {
  it.each([1, 2, 5, 8, 18])(
    "prefers a complete circle with %i distinct action slots",
    (count) => {
      const layout = layoutActionFan(count, space)!;
      expect(layout.shape).toBe("circle");
      expect(layout.points).toHaveLength(count);
      expect(
        new Set(
          layout.points.map(
            (point) => `${point.x},${point.y}`,
          ),
        ).size,
      ).toBe(count);
    },
  );

  it.each([
    { x: 0, y: 278 },
    { x: 556, y: 278 },
    { x: 278, y: 0 },
    { x: 278, y: 556 },
    { x: 556, y: 556 },
  ])(
    "uses a fan where a full circle cannot fit ($x, $y)",
    (position) => {
      const layout = layoutActionFan(8, {
        ...space,
        ...position,
      })!;
      expect(layout.shape).toBe("fan");
      expect(layout.points).toHaveLength(8);
    },
  );

  it("retains the list fallback when there is no usable radial space", () => {
    expect(
      layoutActionFan(8, {
        width: 70,
        height: 70,
        x: 13,
        y: 13,
        size: 44,
      }),
    ).toBeUndefined();
  });
});
