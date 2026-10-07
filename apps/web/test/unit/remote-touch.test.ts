import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { Trackpad } from "@/libs/domain/remote-control/trackpad";
import { DirectTouch } from "@/libs/domain/remote-control/direct-touch";
import {
  TOUCH_SAMPLE_RATES,
  defaultRemoteTouchOptions,
  resolveRemoteTouchOptions,
} from "@/libs/domain/remote-control/touch-options";
import type { RemoteTouchOptions } from "@/libs/domain/remote-control/touch-options";
import type { TouchContact } from "@/libs/domain/remote-control/touch-types";

beforeEach(() =>
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  }),
);
afterEach(() => vi.useRealTimers());
function pad(options: Partial<RemoteTouchOptions> = {}) {
  const move = vi.fn(),
    input = vi.fn(),
    pan = vi.fn();
  const p = new Trackpad(
    {
      move,
      input,
      pan,
      position: () => ({ x: 0.5, y: 0.5 }),
      size: () => ({ width: 200, height: 100 }),
    },
    { ...defaultRemoteTouchOptions, ...options },
  );
  return { p, move, input, pan };
}
it("moves relative to the cursor with speed and clamps to the remote display", () => {
  const { p, move, input } = pad({ pointerSpeed: 2 });
  p.down(17, 120, 30);
  p.move(17, 140, 40);
  expect(move).toHaveBeenLastCalledWith({ x: 0.7, y: 0.7 });
  p.move(17, 400, -100);
  expect(move).toHaveBeenLastCalledWith({ x: 1, y: 0 });
  p.up(17, 400, -100);
  expect(input).not.toHaveBeenCalled();
});
it("taps click at the cursor and two finger taps produce only right click", () => {
  const { p, input, move } = pad();
  p.down(1, 40, 40);
  p.up(1, 40, 40);
  expect(
    input.mock.calls.map(([v]) => [v.button, v.down]),
  ).toEqual([
    [0, true],
    [0, false],
  ]);
  input.mockClear();
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  p.up(1, 40, 40);
  p.up(2, 80, 40);
  expect(
    input.mock.calls.map(([v]) => [v.button, v.down]),
  ).toEqual([
    [2, true],
    [2, false],
  ]);
  expect(input.mock.calls[0][0]).toMatchObject({
    x: 0.5,
    y: 0.5,
  });
  expect(move).not.toHaveBeenCalled();
});
it("sends a native pan with no wheel events, cursor movement, or click after scrolling", () => {
  const { p, move, input, pan } = pad();
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  p.move(1, 40, 60);
  p.move(2, 80, 60);
  p.up(1, 40, 60);
  p.move(2, 80, 90);
  p.up(2, 80, 90);
  expect(move).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
  expect(pan.mock.calls.map(([v]) => v)).toEqual([
    { phase: "start" },
    { phase: "update", x: 0, y: 20 },
    { phase: "end" },
  ]);
});
it("keeps cumulative native displacement independent of event granularity, with speed and direction settings", () => {
  const scroll = (
    steps: number,
    options: Partial<RemoteTouchOptions> = {},
  ) => {
    const { p, pan } = pad(options);
    p.down(1, 40, 40);
    p.down(2, 80, 40);
    for (let i = 1; i <= steps; i++) {
      p.move(1, 40, 40 + (40 * i) / steps);
      p.move(2, 80, 40 + (40 * i) / steps);
      vi.advanceTimersByTime(9);
    }
    p.up(1, 40, 80);
    p.up(2, 80, 80);
    return pan.mock.calls
      .filter(([v]) => v.phase === "update")
      .at(-1)?.[0].y;
  };
  expect(scroll(1)).toBe(40);
  expect(scroll(100)).toBe(40);
  expect(scroll(100, { scrollSpeed: 2 })).toBe(80);
  expect(scroll(1, { naturalScroll: false })).toBe(-40);
  expect(
    scroll(100, { twoFingerScroll: false }),
  ).toBeUndefined();
});
it.each(TOUCH_SAMPLE_RATES)(
  "sends a stationary-centroid pinch at %i Hz and flushes its final scale before release",
  (sampleRate) => {
    const { p, pan, input, move } = pad({ sampleRate });
    p.down(1, 40, 40);
    p.down(2, 80, 40);
    p.move(1, 20, 40);
    p.move(2, 100, 40);
    const interval = Math.ceil(1000 / sampleRate);
    vi.advanceTimersByTime(interval - 1);
    expect(pan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(pan).toHaveBeenLastCalledWith({
      phase: "update",
      x: 0,
      y: 0,
      scale: 2,
    });
    p.move(1, 50, 40);
    p.move(2, 70, 40);
    p.up(1, 50, 40);
    p.move(2, 100, 50);
    p.up(2, 100, 50);
    expect(
      pan.mock.calls.slice(-2).map(([event]) => event),
    ).toEqual([
      { phase: "update", x: 0, y: 0, scale: 0.5 },
      { phase: "end" },
    ]);
    expect(input).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
it("keeps pinch independent from scroll speed, direction and enablement", () => {
  for (const twoFingerScroll of [false, true]) {
    const { p, pan } = pad({
      twoFingerScroll,
      scrollSpeed: 2,
      naturalScroll: false,
    });
    p.down(1, 40, 40);
    p.down(2, 80, 40);
    p.move(1, 30, 60);
    p.move(2, 110, 60);
    vi.advanceTimersByTime(9);
    expect(pan).toHaveBeenLastCalledWith({
      phase: "update",
      x: twoFingerScroll ? -20 : 0,
      y: twoFingerScroll ? -40 : 0,
      scale: 2,
    });
    p.cancel();
  }
});
it("ignores small span jitter while scrolling, and keeps scrolling when pinch is disabled", () => {
  for (const twoFingerZoom of [false, true]) {
    const { p, pan } = pad({ twoFingerZoom });
    p.down(1, 40, 40);
    p.down(2, 80, 40);
    p.move(1, 38, 60);
    p.move(2, 82, 60);
    vi.advanceTimersByTime(9);
    expect(pan).toHaveBeenLastCalledWith({
      phase: "update",
      x: 0,
      y: 20,
    });
    p.move(1, 20, 80);
    p.move(2, 100, 80);
    vi.advanceTimersByTime(9);
    expect(pan).toHaveBeenLastCalledWith({
      phase: "update",
      x: 0,
      y: 40,
      ...(twoFingerZoom ? { scale: 2 } : {}),
    });
    p.cancel();
  }
});
it("cancels pinch without flushing queued motion and resets its origin for the next gesture", () => {
  const { p, pan } = pad();
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  p.move(1, 20, 40);
  p.move(2, 100, 40);
  p.cancel();
  vi.advanceTimersByTime(100);
  expect(pan.mock.calls.map(([event]) => event)).toEqual([
    { phase: "start" },
    { phase: "cancel" },
  ]);
  p.down(1, 20, 40);
  p.down(2, 100, 40);
  p.move(1, 40, 40);
  p.move(2, 80, 40);
  vi.advanceTimersByTime(9);
  expect(pan).toHaveBeenLastCalledWith({
    phase: "update",
    x: 0,
    y: 0,
    scale: 0.5,
  });
  p.cancel();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds scale and allows a pinch to return to its original span", () => {
  const { p, pan } = pad();
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  for (const [left, right, scale] of [
    [-100, 220, 4],
    [60, 60, 0.1],
    [40, 80, 1],
  ]) {
    p.move(1, left, 40);
    p.move(2, right, 40);
    vi.advanceTimersByTime(9);
    expect(pan).toHaveBeenLastCalledWith({
      phase: "update",
      x: 0,
      y: 0,
      scale,
    });
  }
  p.cancel();
});
it("waits for a usable span when both contacts initially coincide", () => {
  const { p, pan } = pad();
  p.down(1, 60, 40);
  p.down(2, 60, 40);
  p.move(1, 40, 40);
  p.move(2, 80, 40);
  vi.advanceTimersByTime(9);
  expect(pan).toHaveBeenCalledTimes(1);
  p.move(1, 20, 40);
  p.move(2, 100, 40);
  vi.advanceTimersByTime(9);
  expect(pan).toHaveBeenLastCalledWith({
    phase: "update",
    x: 0,
    y: 0,
    scale: 2,
  });
  p.cancel();
});
it("samples both fingers once per frame and cancels without replaying queued motion", () => {
  const { p, pan } = pad();
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  for (let y = 41; y <= 80; y++) {
    p.move(1, 40, y);
    p.move(2, 80, y);
  }
  expect(pan).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(9);
  expect(pan).toHaveBeenLastCalledWith({
    phase: "update",
    x: 0,
    y: 40,
  });
  p.move(1, 40, 90);
  p.move(2, 80, 90);
  p.cancel();
  vi.advanceTimersByTime(100);
  expect(pan).toHaveBeenCalledTimes(3);
  expect(pan).toHaveBeenLastCalledWith({ phase: "cancel" });
  expect(vi.getTimerCount()).toBe(0);
});
it("never substitutes wheel events when native pan is unavailable", () => {
  const input = vi.fn();
  const p = new Trackpad(
    {
      move: vi.fn(),
      input,
      position: () => ({ x: 0.5, y: 0.5 }),
      size: () => ({ width: 200, height: 100 }),
    },
    defaultRemoteTouchOptions,
  );
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  p.move(1, 40, 80);
  p.move(2, 80, 80);
  p.up(1, 40, 80);
  p.up(2, 80, 80);
  expect(input).not.toHaveBeenCalled();
});
it("uses relative movement and taps without cached cursor coordinates", () => {
  const relative = vi.fn(),
    move = vi.fn(),
    input = vi.fn();
  const p = new Trackpad(
    {
      relative,
      move,
      input,
      position: () => ({ x: 0.1, y: 0.2 }),
      size: () => ({ width: 200, height: 100 }),
    },
    defaultRemoteTouchOptions,
  );
  p.down(1, 40, 40);
  p.move(1, 60, 50);
  p.up(1, 60, 50);
  expect(relative).toHaveBeenCalledWith({
    type: "move",
    x: 0.1,
    y: 0.1,
  });
  p.down(1, 40, 40);
  p.up(1, 40, 40);
  expect(
    relative.mock.calls.slice(-2).map(([v]) => v),
  ).toEqual([
    { type: "button", button: 0, down: true },
    { type: "button", button: 0, down: false },
  ]);
  expect(move).not.toHaveBeenCalled();
  expect(input).not.toHaveBeenCalled();
});
it("long press drags and releases exactly once on cancellation", () => {
  const { p, input } = pad();
  p.down(1, 40, 40);
  vi.advanceTimersByTime(500);
  p.contextMenu();
  expect(input).toHaveBeenLastCalledWith(
    expect.objectContaining({ button: 0, down: true }),
  );
  p.move(1, 60, 40);
  p.cancel();
  p.cancel();
  expect(input.mock.calls.map(([v]) => v.down)).toEqual([
    true,
    false,
  ]);
  vi.advanceTimersByTime(1000);
  expect(vi.getTimerCount()).toBe(0);
});
it("long press right click and disabled tap preferences are respected", () => {
  const { p, input } = pad({
    longPress: "right-click",
    tapToClick: false,
    twoFingerRightClick: false,
  });
  p.down(1, 40, 40);
  p.up(1, 40, 40);
  p.down(1, 40, 40);
  p.down(2, 80, 40);
  p.up(1, 40, 40);
  p.up(2, 80, 40);
  expect(input).not.toHaveBeenCalled();
  p.down(1, 40, 40);
  vi.advanceTimersByTime(500);
  p.contextMenu();
  p.up(1, 40, 40);
  expect(
    input.mock.calls.map(([v]) => [v.button, v.down]),
  ).toEqual([
    [2, true],
    [2, false],
  ]);
});
it("a third finger cancels gestures and cannot leave a held button", () => {
  const { p, input } = pad();
  p.down(1, 0, 0);
  vi.advanceTimersByTime(500);
  p.contextMenu();
  p.down(2, 20, 20);
  expect(p.down(3, 40, 40)).toBe(false);
  p.up(1, 0, 0);
  p.up(2, 20, 20);
  expect(input.mock.calls.map(([v]) => v.down)).toEqual([
    true,
    false,
  ]);
  expect(vi.getTimerCount()).toBe(0);
});
it("touch frames include all active contacts and ordered final movement before up", () => {
  const frames: TouchContact[][] = [];
  const d = new DirectTouch((c) => frames.push(c));
  d.down(100, { x: 0.1, y: 0.2 });
  d.down(600, { x: 0.6, y: 0.7 });
  expect(frames[1]).toEqual([
    { id: 1, x: 0.1, y: 0.2, phase: "update" },
    { id: 2, x: 0.6, y: 0.7, phase: "down" },
  ]);
  d.move(100, { x: 0.2, y: 0.3 });
  d.move(100, { x: 0.3, y: 0.4 });
  expect(frames).toHaveLength(2);
  vi.advanceTimersByTime(17);
  expect(frames.at(-1)?.[0]).toMatchObject({
    x: 0.3,
    y: 0.4,
    phase: "update",
  });
  d.up(100, { x: 0.4, y: 0.5 });
  expect(frames.slice(-2).map((f) => f[0])).toEqual([
    { id: 1, x: 0.4, y: 0.5, phase: "update" },
    { id: 1, x: 0.4, y: 0.5, phase: "up" },
  ]);
  d.down(123, { x: 0.1, y: 0.1 });
  expect(
    frames.at(-1)?.map((c) => [c.id, c.phase]),
  ).toEqual([
    [2, "update"],
    [1, "down"],
  ]);
  d.cancel();
  expect(
    frames.at(-1)?.every((c) => c.phase === "cancel"),
  ).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps stationary contacts alive for native long press and stops after lift", () => {
  const send = vi.fn();
  const d = new DirectTouch(send);
  d.down(1, { x: 0.5, y: 0.5 });
  vi.advanceTimersByTime(600);
  expect(
    send.mock.calls.filter(
      ([cs]) => cs[0].phase === "update",
    ),
  ).toHaveLength(12);
  d.up(1);
  const count = send.mock.calls.length;
  vi.advanceTimersByTime(1000);
  expect(send).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds concurrent contacts and tolerates synchronous channel failure during send", () => {
  const d = new DirectTouch(() => {});
  for (let i = 0; i < 10; i++)
    expect(d.down(i, { x: 0.5, y: 0.5 })).toBe(true);
  expect(d.down(100, { x: 0.5, y: 0.5 })).toBe(false);
  d.cancel();
  const failed = new DirectTouch(() => failed.cancel());
  expect(failed.down(1, { x: 0.5, y: 0.5 })).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("restores old preferences with safe defaults and validates persisted values", () => {
  expect(resolveRemoteTouchOptions(undefined)).toEqual(
    defaultRemoteTouchOptions,
  );
  expect(
    resolveRemoteTouchOptions({ longPressDelay: 1000 }),
  ).not.toHaveProperty("longPressDelay");
  expect(
    resolveRemoteTouchOptions({ threeFingerTap: "none" })
      .threeFingerTap,
  ).toBe("none");
  expect(
    resolveRemoteTouchOptions({
      mode: "direct",
      pointerSpeed: 10,
      scrollSpeed: 0,
      tapToClick: "false",
      longPress: "invalid",
      threeFingerTap: "invalid",
      longPressDelay: -5,
      sampleRate: 500,
      forwardProperties: "false",
      twoFingerZoom: "false",
    }),
  ).toMatchObject({
    mode: "direct",
    pointerSpeed: 3,
    scrollSpeed: 0.25,
    tapToClick: true,
    longPress: "drag",
    threeFingerTap: "keyboard",
    sampleRate: 120,
    forwardProperties: false,
    twoFingerZoom: true,
  });
  expect(
    resolveRemoteTouchOptions({
      sampleRate: 30,
      forwardProperties: true,
      twoFingerZoom: false,
    }),
  ).toMatchObject({
    sampleRate: 30,
    forwardProperties: true,
    twoFingerZoom: false,
  });
});

it.each(TOUCH_SAMPLE_RATES)(
  "samples direct movement at %i Hz and flushes final movement before immediate release",
  (sampleRate) => {
    const send = vi.fn();
    const d = new DirectTouch(send, sampleRate);
    const interval = Math.ceil(1000 / sampleRate);
    d.down(1, { x: 0.1, y: 0.2 });
    d.move(1, { x: 0.2, y: 0.2 });
    d.move(1, { x: 0.3, y: 0.2 });
    vi.advanceTimersByTime(interval - 1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith([
      { id: 1, x: 0.3, y: 0.2, phase: "update" },
    ]);
    d.move(1, { x: 0.4, y: 0.2 });
    d.up(1);
    expect(
      send.mock.calls
        .slice(-2)
        .map(([frame]) => frame[0].phase),
    ).toEqual(["update", "up"]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(TOUCH_SAMPLE_RATES)(
  "samples trackpad scrolling at %i Hz and ends without waiting for the next sample",
  (sampleRate) => {
    const { p, pan } = pad({ sampleRate });
    p.down(1, 40, 40);
    p.down(2, 80, 40);
    p.move(1, 40, 60);
    p.move(2, 80, 60);
    expect(
      pan.mock.calls.map(([event]) => event.phase),
    ).toEqual(["start"]);
    vi.advanceTimersByTime(
      Math.ceil(1000 / sampleRate) - 1,
    );
    expect(pan).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(pan).toHaveBeenLastCalledWith({
      phase: "update",
      x: 0,
      y: 20,
    });
    p.move(1, 40, 70);
    p.move(2, 80, 70);
    p.up(1, 40, 70);
    p.up(2, 80, 70);
    expect(
      pan.mock.calls.slice(-2).map(([event]) => event),
    ).toEqual([
      { phase: "update", x: 0, y: 30 },
      { phase: "end" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("forwards stationary property changes and releases pressure only in the up frame", () => {
  const send = vi.fn();
  const d = new DirectTouch(send, 30);
  d.down(1, {
    x: 0.5,
    y: 0.5,
    pressure: 0.2,
    width: 0.1,
    height: 0.2,
  });
  d.move(1, {
    x: 0.5,
    y: 0.5,
    pressure: 0.8,
    width: 0.15,
    height: 0.25,
  });
  vi.advanceTimersByTime(34);
  expect(send.mock.calls.at(-1)?.[0][0]).toMatchObject({
    phase: "update",
    pressure: 0.8,
    width: 0.15,
    height: 0.25,
  });
  d.up(1, { x: 0.6, y: 0.5 });
  expect(
    send.mock.calls
      .slice(-2)
      .map(([frame]) => [
        frame[0].phase,
        frame[0].x,
        frame[0].pressure,
      ]),
  ).toEqual([
    ["update", 0.6, 0.8],
    ["up", 0.6, 0],
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

it("drops obsolete properties and immediately cancels queued touch movement", () => {
  const send = vi.fn();
  const d = new DirectTouch(send, 30);
  d.down(1, {
    x: 0.5,
    y: 0.5,
    pressure: 0.2,
    width: 0.1,
    height: 0.2,
  });
  d.move(1, { x: 0.5, y: 0.5 });
  vi.advanceTimersByTime(34);
  expect(send).toHaveBeenLastCalledWith([
    { id: 1, x: 0.5, y: 0.5, phase: "update" },
  ]);
  d.move(1, { x: 0.6, y: 0.5 });
  d.cancel();
  expect(send).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenLastCalledWith([
    { id: 1, x: 0.6, y: 0.5, phase: "cancel" },
  ]);
  vi.advanceTimersByTime(100);
  expect(send).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start a new finger after an interrupted movement flush", () => {
  let fail = false;
  const d = new DirectTouch(() => {
    if (fail) d.cancel();
  });
  d.down(1, { x: 0.1, y: 0.1 });
  d.move(1, { x: 0.2, y: 0.2 });
  fail = true;
  expect(d.down(2, { x: 0.4, y: 0.4 })).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("waits for the browser context menu, fires once and suppresses the following tap", () => {
  const { p, input } = pad({ longPress: "right-click" });
  p.down(1, 40, 40);
  vi.advanceTimersByTime(2000);
  expect(input).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  p.contextMenu();
  p.contextMenu();
  p.up(1, 40, 40);
  expect(
    input.mock.calls.map(([event]) => [
      event.button,
      event.down,
    ]),
  ).toEqual([
    [2, true],
    [2, false],
  ]);
  p.down(2, 40, 40);
  // A browser with a shorter threshold must not also emit a left tap on release.
  p.contextMenu();
  p.up(2, 40, 40);
  expect(
    input.mock.calls
      .slice(2)
      .map(([event]) => [event.button, event.down]),
  ).toEqual([
    [2, true],
    [2, false],
  ]);
});

it.each([
  "moved",
  "multiple",
  "cancelled",
  "lifted",
  "disabled",
])("ignores a context menu for a %s gesture", (kind) => {
  const { p, input } = pad({
    longPress: kind === "disabled" ? "none" : "right-click",
  });
  p.down(1, 40, 40);
  vi.advanceTimersByTime(500);
  if (kind === "moved") p.move(1, 60, 40);
  if (kind === "multiple") p.down(2, 80, 40);
  if (kind === "cancelled") p.cancel();
  if (kind === "lifted") p.up(1, 40, 40);
  p.contextMenu();
  expect(input).not.toHaveBeenCalled();
  p.cancel();
});

it("uses native cursor-relative right click when the browser recognizes a touchpad long press", () => {
  const relative = vi.fn(),
    input = vi.fn();
  const p = new Trackpad(
    {
      relative,
      input,
      move: vi.fn(),
      position: () => ({ x: 0.1, y: 0.1 }),
      size: () => ({ width: 200, height: 100 }),
    },
    {
      ...defaultRemoteTouchOptions,
      longPress: "right-click",
    },
  );
  p.down(1, 150, 90);
  p.contextMenu();
  p.up(1, 150, 90);
  expect(
    relative.mock.calls.map(([event]) => event),
  ).toEqual([
    { type: "button", button: 2, down: true },
    { type: "button", button: 2, down: false },
  ]);
  expect(input).not.toHaveBeenCalled();
});
