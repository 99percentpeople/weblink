import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ThreeFingerTap } from "@/libs/domain/remote-control/three-finger-tap";
beforeEach(() =>
  vi.useFakeTimers({ toFake: ["performance"] }),
);
afterEach(() => vi.useRealTimers());
function start() {
  const gesture = new ThreeFingerTap();
  gesture.down(1, 10, 20);
  gesture.down(2, 30, 20);
  expect(gesture.consumed).toBe(false);
  gesture.down(3, 50, 20);
  expect(gesture.consumed).toBe(true);
  return gesture;
}
it.each([
  [1, 2, 3],
  [3, 1, 2],
  [2, 3, 1],
])(
  "activates once on normal final release in order %j",
  (first, second, last) => {
    const gesture = start();
    expect(gesture.up(first, first * 20 - 10, 20)).toBe(
      false,
    );
    expect(gesture.up(second, second * 20 - 10, 20)).toBe(
      false,
    );
    expect(gesture.consumed).toBe(true);
    expect(gesture.up(last, last * 20 - 10, 20)).toBe(true);
    expect(gesture.finish()).toBe(false);
  },
);
it("can finish a validated three-finger shortcut on native cancellation", () => {
  const gesture = start();
  expect(gesture.finish()).toBe(true);
  expect(gesture.finish()).toBe(false);
  expect(gesture.consumed).toBe(false);
  for (const id of [1, 2, 3])
    expect(gesture.up(id, id * 20 - 10, 20)).toBe(false);
});
it.each(["move", "hold", "fourth", "replace", "cancel"])(
  "rejects %s even on native cancellation",
  (reason) => {
    const gesture = start();
    if (reason === "move") gesture.move(1, 40, 20);
    if (reason === "hold") vi.advanceTimersByTime(601);
    if (reason === "fourth") gesture.down(4, 70, 20);
    if (reason === "replace") {
      gesture.up(1, 10, 20);
      gesture.down(4, 70, 20);
    }
    if (reason === "cancel") gesture.cancel();
    expect(gesture.finish()).toBe(false);
  },
);
it.each([[1], [2, 3]])(
  "does not activate for smaller gestures: %j",
  (...ids) => {
    const gesture = new ThreeFingerTap();
    for (const id of ids) gesture.down(id, 10, 20);
    expect(gesture.finish()).toBe(false);
  },
);
it("does not combine separate taps into a shortcut", () => {
  const gesture = new ThreeFingerTap();
  for (const id of [1, 2, 3]) {
    gesture.down(id, 10, 20);
    expect(gesture.up(id, 10, 20)).toBe(false);
  }
  expect(gesture.finish()).toBe(false);
});
it("accepts staggered contacts with small touch-centroid drift", () => {
  const gesture = new ThreeFingerTap();
  gesture.down(1, 10, 20);
  vi.advanceTimersByTime(120);
  gesture.down(2, 30, 20);
  gesture.move(1, 22, 25);
  vi.advanceTimersByTime(120);
  gesture.down(3, 50, 20);
  vi.advanceTimersByTime(180);
  expect(gesture.finish()).toBe(true);
});
