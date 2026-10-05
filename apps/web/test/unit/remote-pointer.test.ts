import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RemotePointer,
  CONTROL_CHANNEL,
  POINTER_CHANNEL,
  videoPosition,
} from "@/libs/domain/remote-control/pointer";
import { TOUCH_SAMPLE_RATES } from "@/libs/domain/remote-control/touch-options";
class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sent: any[] = [];
  maxPacketLifeTime = null;
  readonly protocol: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  constructor(readonly label: string) {
    super();
    this.protocol = label;
    this.ordered = label === CONTROL_CHANNEL;
    this.maxRetransmits = this.ordered ? null : 0;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  receive(value: unknown) {
    const e = new Event("message");
    Object.defineProperty(e, "data", {
      value: JSON.stringify(value),
    });
    this.dispatchEvent(e);
  }
}
const controllers: RemotePointer[] = [];
function setup(
  touchContacts?: number,
  relativePointer?: boolean,
  touchpadPan?: boolean,
  persistentControl?: boolean,
  keyboard?: unknown,
  textInput?: unknown,
  cursorVisibility?: unknown,
  cursorShape?: unknown,
) {
  const c = new RemotePointer("source", "media");
  controllers.push(c);
  const r = new Channel(CONTROL_CHANNEL),
    m = new Channel(POINTER_CHANNEL);
  c.bind(r as unknown as RTCDataChannel);
  c.bind(m as unknown as RTCDataChannel);
  const target = {
    sourceId: "source",
    mediaId: "media",
    geometryRevision: "geometry",
  };
  r.receive({
    type: "ready",
    target,
    generation: "media",
    touchContacts,
    relativePointer,
    touchpadPan,
    persistentControl,
    keyboard,
    textInput,
    cursorVisibility,
    cursorShape,
  });
  const approve = () => {
    c.request();
    r.receive({
      type: "grant",
      requestId: r.sent.at(-1).requestId,
      target,
      grantId: "grant",
      leaseMs: 2000,
    });
  };
  const activate = () => {
    c.activate();
    const packet = r.sent.at(-1);
    r.receive({
      type: "state",
      grantId: "grant",
      inputEpoch: packet.inputEpoch,
      active: true,
    });
    return packet;
  };
  return { c, r, m, target, approve, activate };
}
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
afterEach(() => {
  controllers.splice(0).forEach((c) => c.close());
  vi.useRealTimers();
});
describe("remote pointer transport", () => {
  it("scopes cursor updates to the current watch, grant and input epoch", () => {
    const { c, r, approve, activate } = setup(
      10,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    );
    const listener = vi.fn();
    const stop = c.watchCursor(listener);
    expect(listener).toHaveBeenLastCalledWith(undefined);
    expect(r.sent).toHaveLength(0);
    approve();
    activate();
    const watch = r.sent.at(-1);
    expect(watch.type).toBe("cursor-watch");
    const reply = {
      ...watch,
      type: "cursor-state",
      sequence: 1,
      shape: { type: "system", name: "text" },
    };
    listener.mockClear();
    for (const patch of [
      { watchId: "old" },
      { grantId: "old" },
      { inputEpoch: "old" },
      { sequence: 0 },
      { sequence: 1.5 },
      {
        shape: {
          type: "system",
          name: 'url("https://example.com")',
        },
      },
    ])
      r.receive({ ...reply, ...patch });
    expect(listener).not.toHaveBeenCalled();
    r.receive(reply);
    r.receive(reply);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(reply.shape);
    const second = vi.fn();
    const count = r.sent.length;
    const stopSecond = c.watchCursor(second);
    expect(second).toHaveBeenLastCalledWith(reply.shape);
    stopSecond();
    expect(r.sent).toHaveLength(count);
    c.resetInput();
    expect(listener).toHaveBeenLastCalledWith(undefined);
    activate();
    const resumed = r.sent.at(-1);
    expect(resumed.watchId).not.toBe(watch.watchId);
    expect(resumed.inputEpoch).not.toBe(watch.inputEpoch);
    listener.mockClear();
    r.receive({ ...reply, sequence: 2 });
    expect(listener).not.toHaveBeenCalled();
    r.receive({
      ...resumed,
      type: "cursor-state",
      sequence: 1,
      shape: { type: "unknown" },
    });
    expect(listener).toHaveBeenLastCalledWith({
      type: "unknown",
    });
    stop();
    expect(r.sent.at(-1)).toEqual({
      ...resumed,
      watchId: null,
    });
    listener.mockClear();
    r.receive({
      ...resumed,
      type: "cursor-state",
      sequence: 2,
      shape: reply.shape,
    });
    expect(listener).not.toHaveBeenCalled();
  });
  it("does not subscribe without negotiated cursor support", () => {
    const { c, r, approve, activate } = setup();
    approve();
    activate();
    const count = r.sent.length;
    const stop = c.watchCursor(vi.fn());
    stop();
    expect(r.sent).toHaveLength(count);
  });
  it("streams focus snapshots for the active subscription and rejects stale sequence, watch and epoch", () => {
    const { c, r, approve, activate } = setup(
      10,
      true,
      true,
      true,
      true,
      true,
      true,
    );
    const focus = vi.fn();
    const stop = c.watchTextInput(focus);
    expect(r.sent).toHaveLength(0);
    approve();
    activate();
    const watch = r.sent.at(-1);
    expect(watch.type).toBe("text-input-watch");
    const reply = {
      ...watch,
      type: "text-input-state",
      sequence: 1,
      focus: { type: "editable", id: "field-a" },
    };
    for (const patch of [
      { watchId: "old" },
      { grantId: "old" },
      { inputEpoch: "old" },
      { sequence: 0 },
      { sequence: 1.5 },
      { focus: { type: "editable" } },
    ])
      r.receive({ ...reply, ...patch });
    expect(focus).not.toHaveBeenCalled();
    r.receive(reply);
    r.receive(reply);
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenLastCalledWith({
      type: "editable",
      id: "field-a",
    });
    r.receive({
      ...reply,
      sequence: 3,
      focus: { type: "none" },
    });
    r.receive({ ...reply, sequence: 2 });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(focus).toHaveBeenLastCalledWith({
      type: "none",
    });
    c.refreshTextInput();
    const refreshed = r.sent.at(-1);
    expect(refreshed.watchId).not.toBe(watch.watchId);
    r.receive({ ...reply, sequence: 4 });
    expect(focus).toHaveBeenCalledTimes(2);
    r.receive({ ...reply, watchId: refreshed.watchId });
    expect(focus).toHaveBeenCalledTimes(3);
    c.resetInput();
    activate();
    const resumed = r.sent.at(-1);
    expect(resumed.type).toBe("text-input-watch");
    expect(resumed.inputEpoch).not.toBe(watch.inputEpoch);
    r.receive({
      ...reply,
      watchId: refreshed.watchId,
      sequence: 2,
    });
    expect(focus).toHaveBeenCalledTimes(3);
    r.receive({
      ...resumed,
      type: "text-input-state",
      sequence: 1,
      focus: { type: "unknown" },
    });
    expect(focus).toHaveBeenLastCalledWith({
      type: "unknown",
    });
    stop();
    expect(r.sent.at(-1)).toEqual({
      ...resumed,
      watchId: null,
    });
    r.receive({
      ...resumed,
      type: "text-input-state",
      sequence: 2,
      focus: { type: "none" },
    });
    expect(focus).toHaveBeenCalledTimes(4);
  });
  it("shares one watch across views and stops only after the final subscriber leaves", () => {
    const { c, r, approve, activate } = setup(
      10,
      true,
      true,
      true,
      true,
      true,
    );
    approve();
    activate();
    const a = vi.fn(),
      b = vi.fn();
    const first = c.watchTextInput(a);
    const watch = r.sent.at(-1);
    r.receive({
      ...watch,
      type: "text-input-state",
      sequence: 1,
      focus: { type: "none" },
    });
    const count = r.sent.length;
    const second = c.watchTextInput(b);
    expect(b).toHaveBeenCalledOnce();
    expect(b).toHaveBeenLastCalledWith({ type: "none" });
    first();
    expect(r.sent).toHaveLength(count);
    second();
    expect(r.sent.at(-1).watchId).toBeNull();
  });
  it("sends the newest move if main-thread work delayed its timer past the deadline", () => {
    const { c, m, approve, activate } = setup();
    approve();
    activate();
    const now = vi.spyOn(performance, "now");
    try {
      now.mockReturnValue(100);
      c.move({ x: 0.1, y: 0.2 });
      now.mockReturnValue(101);
      c.move({ x: 0.3, y: 0.4 });
      expect(m.sent).toHaveLength(1);
      // Time passes while the movement timer has not had a chance to run.
      now.mockReturnValue(110);
      c.move({ x: 0.8, y: 0.9 });
      expect(m.sent).toHaveLength(2);
      expect(m.sent[1].event).toMatchObject({
        x: 0.8,
        y: 0.9,
      });
      vi.advanceTimersByTime(20);
      expect(m.sent).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
  });
  it("sends an already-due move immediately and coalesces the next sample", () => {
    const { c, m, approve, activate } = setup();
    approve();
    activate();
    vi.advanceTimersByTime(100);
    c.move({ x: 0.1, y: 0.2 });
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0].event).toMatchObject({
      x: 0.1,
      y: 0.2,
    });
    c.move({ x: 0.3, y: 0.4 });
    c.move({ x: 0.8, y: 0.9 });
    vi.advanceTimersByTime(8);
    expect(m.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(m.sent).toHaveLength(2);
    expect(m.sent[1].event).toMatchObject({
      x: 0.8,
      y: 0.9,
    });
  });
  it("negotiates cursor visibility and binds changes to the active input epoch", () => {
    const { c, r, approve, activate } = setup(
      10,
      true,
      true,
      true,
      true,
      true,
      true,
    );
    c.setCursorVisible(false);
    expect(r.sent).toHaveLength(0);
    approve();
    const activation = activate();
    c.setCursorVisible(false);
    expect(r.sent.at(-1)).toEqual({
      type: "cursor",
      grantId: "grant",
      generation: "media",
      geometryRevision: "geometry",
      inputEpoch: activation.inputEpoch,
      visible: false,
    });
    const count = r.sent.length;
    c.setCursorVisible(false);
    expect(r.sent).toHaveLength(count);
    c.setCursorVisible(true);
    expect(r.sent.at(-1).visible).toBe(true);
    c.setCursorVisible(false);
    c.resetInput();
    const next = activate();
    c.setCursorVisible(false);
    expect(r.sent.at(-1)).toMatchObject({
      type: "cursor",
      inputEpoch: next.inputEpoch,
      visible: false,
    });
    expect(next.inputEpoch).not.toBe(activation.inputEpoch);
  });
  it("leaves older hosts unchanged when cursor visibility is not advertised", () => {
    const { c, r, approve, activate } = setup();
    approve();
    activate();
    const count = r.sent.length;
    c.setCursorVisible(false);
    c.setCursorVisible(true);
    expect(r.sent).toHaveLength(count);
  });
  it.each(TOUCH_SAMPLE_RATES)(
    "samples absolute and relative touchpad movement at %i Hz",
    (sampleRate) => {
      const { c, r, m, approve, activate } = setup(
        10,
        true,
      );
      approve();
      activate();
      const interval = Math.ceil(1000 / sampleRate);
      c.move({ x: 0.1, y: 0.2 }, sampleRate);
      c.move({ x: 0.3, y: 0.4 }, sampleRate);
      vi.advanceTimersByTime(interval - 1);
      expect(m.sent).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(m.sent).toHaveLength(1);
      expect(m.sent[0].event).toEqual({
        type: "move",
        x: 0.3,
        y: 0.4,
      });
      const before = r.sent.length;
      c.trackpad(
        { type: "move", x: 0.1, y: 0.1 },
        sampleRate,
      );
      c.trackpad(
        { type: "move", x: 0.1, y: 0.1 },
        sampleRate,
      );
      vi.advanceTimersByTime(interval - 1);
      expect(r.sent).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(r.sent.at(-1).event).toEqual({
        type: "trackpad",
        action: { type: "move", x: 0.2, y: 0.2 },
      });
      c.trackpad(
        { type: "move", x: 0.1, y: 0.1 },
        sampleRate,
      );
      c.trackpad(
        { type: "button", button: 0, down: true },
        sampleRate,
      );
      expect(
        r.sent
          .slice(-2)
          .map((packet) => packet.event.action.type),
      ).toEqual(["move", "button"]);
      c.resetInput();
      const resetCount = r.sent.length;
      vi.advanceTimersByTime(interval);
      expect(r.sent).toHaveLength(resetCount);
    },
  );
  it("negotiates bounded Unicode text independently and sends only while active", () => {
    const event = { type: "text" as const, text: "中😀" };
    for (const [keyboard, textInput] of [
      [true, undefined],
      [true, "true"],
      [false, true],
    ]) {
      const { c, approve, activate } = setup(
        undefined,
        undefined,
        undefined,
        true,
        keyboard,
        textInput,
      );
      approve();
      activate();
      expect(c.supportsText()).toBe(false);
      expect(c.input(event)).toBe(false);
    }
    const { c, r, m, approve, activate } = setup(
      undefined,
      undefined,
      undefined,
      true,
      true,
      true,
    );
    expect(c.supportsText()).toBe(true);
    expect(c.input(event)).toBe(false);
    approve();
    expect(c.input(event)).toBe(false);
    const activation = activate();
    expect(c.input(event)).toBe(true);
    expect(r.sent.at(-1)).toMatchObject({
      event,
      grantId: "grant",
      inputEpoch: activation.inputEpoch,
      sequence: 2,
    });
    expect(m.sent).toEqual([]);
    const count = r.sent.length;
    for (const text of ["", "\n", "\ud800", "a".repeat(65)])
      expect(c.input({ type: "text", text })).toBe(false);
    expect(r.sent).toHaveLength(count);
    c.resetInput();
    expect(c.input(event)).toBe(false);
    c.cancel();
    expect(c.input(event)).toBe(false);
  });
  it("negotiates keyboard input and orders keys with the grant and input epoch", () => {
    const event = {
      type: "key" as const,
      scanCode: 0x1e,
      extended: false,
      down: true,
    };
    for (const capability of [undefined, false, "true"]) {
      const legacy = setup(
        undefined,
        undefined,
        undefined,
        true,
        capability,
      );
      legacy.approve();
      legacy.activate();
      expect(legacy.c.supportsKeyboard()).toBe(false);
      expect(legacy.c.input(event)).toBe(false);
      expect(
        legacy.r.sent.filter((p) => p.type === "input"),
      ).toHaveLength(1);
    }
    const { c, r, m, approve, activate } = setup(
      undefined,
      undefined,
      undefined,
      true,
      true,
    );
    expect(c.supportsKeyboard()).toBe(true);
    expect(c.input(event)).toBe(false);
    approve();
    expect(c.input(event)).toBe(false);
    const activation = activate();
    expect(c.input(event)).toBe(true);
    expect(c.input({ ...event, down: false })).toBe(true);
    expect(m.sent).toHaveLength(0);
    expect(r.sent.slice(-2)).toEqual([
      expect.objectContaining({
        type: "input",
        sequence: 2,
        inputEpoch: activation.inputEpoch,
        grantId: "grant",
        event,
      }),
      expect.objectContaining({
        type: "input",
        sequence: 3,
        inputEpoch: activation.inputEpoch,
        grantId: "grant",
        event: { ...event, down: false },
      }),
    ]);
    c.resetInput();
    expect(c.state()).toBe("activating");
    expect(c.input(event)).toBe(false);
    c.cancel();
    expect(c.input(event)).toBe(false);
    c.close();
    expect(c.input(event)).toBe(false);
  });
  it("drops keyboard input at backpressure and recovers through a fresh release epoch", () => {
    const { c, r, approve, activate } = setup(
      undefined,
      undefined,
      undefined,
      true,
      true,
    );
    approve();
    const previous = activate();
    r.bufferedAmount = 16 * 1024;
    expect(
      c.input({
        type: "key",
        scanCode: 0x1d,
        extended: false,
        down: true,
      }),
    ).toBe(false);
    expect(c.state()).toBe("activating");
    r.bufferedAmount = 0;
    r.dispatchEvent(new Event("bufferedamountlow"));
    r.receive({ type: "heartbeat", grantId: "grant" });
    const next = r.sent.at(-1);
    expect(next.event.type).toBe("activate");
    expect(next.inputEpoch).not.toBe(previous.inputEpoch);
    expect(
      r.sent.some((p) => p.event?.type === "key"),
    ).toBe(false);
  });
  it("coalesces relative displacement on the reliable channel before a click and clears it when resetting a gesture", () => {
    const { c, r, m, approve, activate } = setup(
      undefined,
      true,
    );
    approve();
    activate();
    c.trackpad({ type: "move", x: 0.1, y: 0.2 });
    c.trackpad({ type: "move", x: 0.2, y: -0.1 });
    c.trackpad({ type: "button", button: 0, down: true });
    const events = r.sent.filter((p) => p.type === "input");
    expect(
      events.map((p) => [p.sequence, p.event.type]),
    ).toEqual([
      [1, "activate"],
      [2, "trackpad"],
      [3, "trackpad"],
    ]);
    expect(events[1].event.action.x).toBeCloseTo(0.3);
    expect(events[1].event.action.y).toBeCloseTo(0.1);
    expect(events[2].event.action).toEqual({
      type: "button",
      button: 0,
      down: true,
    });
    expect(m.sent).toHaveLength(0);
    c.trackpad({ type: "move", x: 0.3, y: 0.1 });
    c.resetInput();
    const count = r.sent.length;
    vi.advanceTimersByTime(20);
    expect(r.sent).toHaveLength(count);
  });
  it("does not send relative input to hosts without capability and drops deltas at reliable backpressure", () => {
    const legacy = setup();
    legacy.approve();
    legacy.activate();
    legacy.c.trackpad({
      type: "button",
      button: 0,
      down: true,
    });
    expect(legacy.r.sent.at(-1).event.type).toBe(
      "activate",
    );
    const { c, r, approve, activate } = setup(
      undefined,
      true,
    );
    approve();
    activate();
    r.bufferedAmount = 16 * 1024;
    c.trackpad({ type: "move", x: 0.1, y: 0.1 });
    vi.advanceTimersByTime(10);
    expect(c.state()).toBe("activating");
    expect(r.readyState).toBe("open");
  });
  it("automatically activates after approval and uses independent sequence barriers", () => {
    const { c, r, m, approve, activate } = setup();
    c.move({ x: 0.5, y: 0.5 });
    c.input({
      type: "button",
      x: 0.5,
      y: 0.5,
      button: 0,
      down: true,
    });
    expect(r.sent).toEqual([]);
    approve();
    expect(c.state()).toBe("activating");
    const start = activate();
    expect(start.sequence).toBe(1);
    expect(c.state()).toBe("active");
    c.input({
      type: "button",
      x: 0.1,
      y: 0.2,
      button: 0,
      down: true,
    });
    c.move({ x: 0.2, y: 0.3 });
    c.move({ x: 0.8, y: 0.9 });
    vi.advanceTimersByTime(10);
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]).toMatchObject({
      sequence: 1,
      after: 2,
      inputEpoch: start.inputEpoch,
      event: { type: "move", x: 0.8, y: 0.9 },
    });
    c.resetInput();
    expect(r.sent.at(-2)).toMatchObject({
      sequence: 3,
      event: { type: "pause" },
    });
    expect(c.state()).toBe("activating");
    const next = activate();
    expect(next.inputEpoch).not.toBe(start.inputEpoch);
    expect(next.sequence).toBe(1);
    r.receive({
      type: "state",
      grantId: "grant",
      inputEpoch: start.inputEpoch,
      active: false,
    });
    expect(c.state()).toBe("active");
  });
  it("does not resume on a delayed activation ACK after a gesture reset", () => {
    const { c, r, approve } = setup();
    approve();
    c.activate();
    const p = r.sent.at(-1);
    c.resetInput();
    r.receive({
      type: "state",
      grantId: "grant",
      inputEpoch: p.inputEpoch,
      active: true,
    });
    expect(c.state()).toBe("activating");
  });
  it("loses the grant on missing heartbeat ACK and rejects late ACK or grant replay", () => {
    const { c, r, approve, activate } = setup();
    approve();
    activate();
    vi.advanceTimersByTime(1900);
    r.receive({ type: "heartbeat", grantId: "different" });
    vi.advanceTimersByTime(100);
    expect(c.state()).toBe("viewing");
    r.receive({ type: "heartbeat", grantId: "grant" });
    expect(c.state()).toBe("viewing");
    expect(r.sent.at(-1)).toMatchObject({
      type: "revoke",
      grantId: "grant",
    });
  });
  it("ends an activation that was not acknowledged even if heartbeats arrive", () => {
    const { c, r, approve } = setup();
    approve();
    c.activate();
    const packet = r.sent.at(-1);
    vi.advanceTimersByTime(900);
    r.receive({ type: "heartbeat", grantId: "grant" });
    expect(c.state()).toBe("activating");
    vi.advanceTimersByTime(100);
    expect(c.state()).toBe("viewing");
    r.receive({
      type: "state",
      grantId: "grant",
      inputEpoch: packet.inputEpoch,
      active: true,
    });
    expect(c.state()).toBe("viewing");
  });
  it("keeps a legacy grant only while native heartbeats are acknowledged", () => {
    const { c, r, approve, activate } = setup();
    approve();
    activate();
    vi.advanceTimersByTime(1500);
    r.receive({ type: "heartbeat", grantId: "grant" });
    vi.advanceTimersByTime(1500);
    expect(c.state()).toBe("active");
    vi.advanceTimersByTime(500);
    expect(c.state()).toBe("viewing");
  });
  it("keeps channels on congestion but reports terminal channel loss once", () => {
    const { c, r, m, approve, activate } = setup();
    approve();
    activate();
    r.bufferedAmount = 16384;
    c.resetInput();
    expect(c.state()).toBe("activating");
    expect(m.readyState).toBe("open");
    const other = setup();
    other.approve();
    other.m.close();
    expect(other.c.state()).toBe("unavailable");
  });
  it("will not bind another source or replace channels", () => {
    const c = new RemotePointer("source", "media");
    controllers.push(c);
    const r = new Channel(CONTROL_CHANNEL),
      m = new Channel(POINTER_CHANNEL);
    c.bind(r as unknown as RTCDataChannel);
    c.bind(m as unknown as RTCDataChannel);
    r.receive({
      type: "ready",
      target: {
        sourceId: "other",
        mediaId: "media",
        geometryRevision: "r",
      },
      generation: "media",
    });
    expect(c.state()).toBe("unavailable");
    const duplicate = new Channel(CONTROL_CHANNEL);
    c.bind(duplicate as unknown as RTCDataChannel);
    expect(duplicate.readyState).toBe("closed");
    expect(r.readyState).toBe("open");
  });
});
it("maps only video content, with no DPI multiplier or letterbox clicks", () => {
  const rect = {
    left: 100,
    top: 200,
    width: 1000,
    height: 1000,
  };
  expect(videoPosition(rect, 1920, 1080, 600, 700)).toEqual(
    { x: 0.5, y: 0.5 },
  );
  expect(
    videoPosition(rect, 1920, 1080, 600, 250),
  ).toBeUndefined();
  expect(
    videoPosition(rect, 0, 0, 600, 700),
  ).toBeUndefined();
  expect(
    videoPosition(rect, 1080, 1920, 101, 700),
  ).toBeUndefined();
  expect(
    videoPosition(rect, 1920, 1080, -100, 1400, true),
  ).toEqual({ x: 0, y: 1 });
  expect(
    videoPosition(rect, 1920, 1080, 600, 250, true),
  ).toEqual({ x: 0.5, y: 0 });
  expect(
    videoPosition(rect, 0, 0, 600, 700, true),
  ).toBeUndefined();
});

it("negotiates native touch support and sends contacts only on ordered input", () => {
  const legacy = setup();
  legacy.approve();
  legacy.activate();
  expect(legacy.c.supportsTouch()).toBe(false);
  const event = {
    type: "touch" as const,
    contacts: [
      { id: 1, x: 0.2, y: 0.3, phase: "down" as const },
    ],
  };
  const before = legacy.r.sent.length;
  legacy.c.input(event);
  expect(legacy.r.sent).toHaveLength(before);
  const { c, r, m, approve, activate } = setup(10);
  approve();
  activate();
  expect(c.supportsTouch()).toBe(true);
  c.move({ x: 0.9, y: 0.9 });
  c.input(event);
  vi.advanceTimersByTime(10);
  c.input({
    ...event,
    contacts: [{ ...event.contacts[0], phase: "up" }],
  });
  expect(r.sent.slice(-2).map((p) => p.sequence)).toEqual([
    2, 3,
  ]);
  expect(r.sent.at(-2).event).toEqual(event);
  expect(m.sent).toEqual([]);
  c.resetInput();
  const paused = r.sent.length;
  c.input(event);
  expect(r.sent).toHaveLength(paused);
});

it("negotiates native pan explicitly and preserves ordered start/motion/end without wheel fallback", () => {
  for (const supported of [false, true]) {
    const { c, r, m, approve, activate } = setup(
      undefined,
      true,
      supported,
    );
    approve();
    activate();
    expect(c.supportsTouchpadPan()).toBe(supported);
    const before = r.sent.length;
    c.trackpad({ type: "pan", phase: "start" });
    c.trackpad({
      type: "pan",
      phase: "update",
      x: 0,
      y: 32,
    });
    c.trackpad({ type: "pan", phase: "end" });
    expect(
      r.sent.slice(before).map((p) => p.event.action.phase),
    ).toEqual(supported ? ["start", "update", "end"] : []);
    expect(m.sent).toHaveLength(0);
  }
});

it("keeps the same approval across heartbeat gaps, drops interrupted input, and resumes on a fresh acknowledged epoch", () => {
  const { c, r, approve, activate } = setup(
    10,
    true,
    true,
    true,
  );
  approve();
  const first = activate();
  c.move({ x: 0.1, y: 0.1 });
  vi.advanceTimersByTime(10_000);
  expect(c.state()).toBe("activating");
  expect(
    r.sent.filter((p) => p.type === "request"),
  ).toHaveLength(1);
  expect(r.sent.some((p) => p.type === "revoke")).toBe(
    false,
  );
  const before = r.sent.length;
  c.trackpad({ type: "button", button: 0, down: true });
  expect(r.sent).toHaveLength(before);
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: first.inputEpoch,
    active: true,
  });
  expect(c.state()).toBe("activating");
  r.receive({ type: "heartbeat", grantId: "grant" });
  const resume = r.sent.at(-1);
  expect(resume.event.type).toBe("activate");
  expect(resume.inputEpoch).not.toBe(first.inputEpoch);
  expect(resume.grantId).toBe(first.grantId);
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: resume.inputEpoch,
    active: true,
  });
  expect(c.state()).toBe("active");
  c.trackpad({ type: "button", button: 0, down: true });
  expect(r.sent.at(-1).event.action.down).toBe(true);
  c.cancel();
  r.receive({ type: "heartbeat", grantId: "grant" });
  expect(c.state()).toBe("viewing");
});
it("recovers native input interruption without reapproval but never resumes ended control", () => {
  const { c, r, approve, activate } = setup(
    undefined,
    true,
    false,
    true,
  );
  approve();
  const first = activate();
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: first.inputEpoch,
    active: false,
  });
  expect(c.state()).toBe("activating");
  r.receive({ type: "heartbeat", grantId: "grant" });
  const resume = r.sent.at(-1);
  expect(resume.event.type).toBe("activate");
  expect(resume.inputEpoch).not.toBe(first.inputEpoch);
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: resume.inputEpoch,
    active: true,
  });
  expect(c.state()).toBe("active");
  c.cancel();
  vi.advanceTimersByTime(10_000);
  r.receive({ type: "heartbeat", grantId: "grant" });
  expect(c.state()).toBe("viewing");
  expect(r.sent.at(-1).event?.type).not.toBe("activate");
});
it("numbers repeated input recoveries monotonically within the same approval", () => {
  const { c, r, m, approve, activate } = setup(
    undefined,
    true,
    false,
    true,
  );
  approve();
  let current = activate();
  expect(current.activationSequence).toBe(1);
  for (let n = 2; n <= 1024; n++) {
    c.resetInput();
    const next = r.sent.at(-1);
    expect(next.activationSequence).toBe(n);
    expect(next.inputEpoch).not.toBe(current.inputEpoch);
    r.receive({
      type: "state",
      grantId: "grant",
      inputEpoch: next.inputEpoch,
      active: true,
    });
    expect(c.state()).toBe("active");
    c.input({
      type: "button",
      button: 0,
      down: false,
      x: 0.5,
      y: 0.5,
    });
    expect(r.sent.at(-1).activationSequence).toBe(n);
    c.input({ type: "move", x: 0.5, y: 0.5 });
    expect(m.sent.at(-1).activationSequence).toBe(n);
    current = next;
  }
  expect(
    r.sent.filter((p) => p.type === "request"),
  ).toHaveLength(1);
});
it("retries an unacknowledged activation using a fresh epoch without ending persistent consent", () => {
  const { c, r, approve } = setup(
    undefined,
    true,
    false,
    true,
  );
  approve();
  c.activate();
  const old = r.sent.at(-1);
  vi.advanceTimersByTime(1000);
  expect(c.state()).toBe("activating");
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: old.inputEpoch,
    active: true,
  });
  expect(c.state()).toBe("activating");
  r.receive({ type: "heartbeat", grantId: "grant" });
  expect(r.sent.at(-1).inputEpoch).not.toBe(old.inputEpoch);
  expect(
    r.sent.filter((p) => p.type === "request"),
  ).toHaveLength(1);
});

it("recovers a congested reliable channel using the same grant and a new input epoch without replaying missed presses", () => {
  const { c, r, m, approve, activate } = setup(
    undefined,
    true,
    false,
    true,
  );
  const failure = vi.fn();
  c.addEventListener("transporterror", failure);
  approve();
  const first = activate();
  c.trackpad({ type: "button", button: 0, down: true });
  r.bufferedAmount = 16 * 1024;
  c.trackpad({ type: "button", button: 0, down: false });
  const count = r.sent.length;
  c.trackpad({ type: "button", button: 2, down: true });
  vi.advanceTimersByTime(3500);
  expect(r.sent).toHaveLength(count);
  expect(c.state()).toBe("activating");
  expect(r.readyState).toBe("open");
  expect(m.readyState).toBe("open");
  r.bufferedAmount = 0;
  r.dispatchEvent(new Event("bufferedamountlow"));
  r.receive({ type: "heartbeat", grantId: "grant" });
  const recovered = r.sent.at(-1);
  expect(recovered.event.type).toBe("activate");
  expect(recovered.inputEpoch).not.toBe(first.inputEpoch);
  expect(recovered.grantId).toBe(first.grantId);
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: recovered.inputEpoch,
    active: true,
  });
  expect(c.state()).toBe("active");
  expect(
    r.sent
      .slice(count)
      .some((p) => p.event?.type === "trackpad"),
  ).toBe(false);
  expect(failure).not.toHaveBeenCalled();
  c.cancel();
  expect(c.state()).toBe("viewing");
  c.request();
  expect(c.state()).toBe("requesting");
});
it("delivers end-control after congestion without reopening input on a late heartbeat", () => {
  const { c, r, approve, activate } = setup(
    undefined,
    false,
    false,
    true,
  );
  approve();
  activate();
  r.bufferedAmount = 16 * 1024;
  c.cancel();
  expect(c.state()).toBe("viewing");
  r.bufferedAmount = 0;
  r.dispatchEvent(new Event("bufferedamountlow"));
  expect(r.sent.at(-1)).toMatchObject({
    type: "revoke",
    grantId: "grant",
  });
  r.receive({ type: "heartbeat", grantId: "grant" });
  expect(c.state()).toBe("viewing");
});
it("a gesture reset releases current input and reactivates without a user pause or another approval", () => {
  const { c, r, approve, activate } = setup();
  approve();
  const first = activate();
  c.resetInput();
  const next = r.sent.at(-1);
  expect(r.sent.at(-2).event.type).toBe("pause");
  expect(next.event.type).toBe("activate");
  expect(next.inputEpoch).not.toBe(first.inputEpoch);
  r.receive({
    type: "state",
    grantId: "grant",
    inputEpoch: next.inputEpoch,
    active: true,
  });
  expect(c.state()).toBe("active");
  expect(
    r.sent.filter((p) => p.type === "request"),
  ).toHaveLength(1);
});
it("preserves revoke-before-request order when ending and requesting again during congestion", () => {
  const { c, r, approve, activate } = setup(
    undefined,
    false,
    false,
    true,
  );
  approve();
  activate();
  const before = r.sent.length;
  r.bufferedAmount = 16384;
  c.cancel();
  c.request();
  r.bufferedAmount = 0;
  r.dispatchEvent(new Event("bufferedamountlow"));
  expect(r.sent.slice(before).map((p) => p.type)).toEqual([
    "revoke",
    "request",
  ]);
  expect(c.state()).toBe("requesting");
});
