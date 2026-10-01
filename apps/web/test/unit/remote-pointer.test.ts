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
function setup() {
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
  r.receive({ type: "ready", target, generation: "media" });
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
  it("requires approval then explicit activation and uses independent sequence barriers", () => {
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
    expect(c.state()).toBe("paused");
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
    c.pause();
    expect(r.sent.at(-1)).toMatchObject({
      sequence: 3,
      event: { type: "pause" },
    });
    expect(c.state()).toBe("paused");
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
  it("does not resume on a delayed activation ACK after blur/pause", () => {
    const { c, r, approve } = setup();
    approve();
    c.activate();
    const p = r.sent.at(-1);
    c.pause();
    r.receive({
      type: "state",
      grantId: "grant",
      inputEpoch: p.inputEpoch,
      active: true,
    });
    expect(c.state()).toBe("paused");
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
  it("keeps a paused grant only while native heartbeats are acknowledged", () => {
    const { c, r, approve } = setup();
    approve();
    vi.advanceTimersByTime(1500);
    r.receive({ type: "heartbeat", grantId: "grant" });
    vi.advanceTimersByTime(1500);
    expect(c.state()).toBe("paused");
    vi.advanceTimersByTime(500);
    expect(c.state()).toBe("viewing");
  });
  it("closes on reliable overflow and channel loss without recursive close", () => {
    const { c, r, m, approve, activate } = setup();
    approve();
    activate();
    r.bufferedAmount = 16384;
    c.pause();
    expect(c.state()).toBe("unavailable");
    expect(m.readyState).toBe("closed");
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
});
