import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { monitorScreenDecode } from "@/libs/domain/native-screen/decode-monitor";

const disposers: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  expect(vi.getTimerCount()).toBe(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const page = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  vi.stubGlobal("document", page);
  let frames = 100,
    bytes = 1000,
    id = "video";
  const report = () =>
    new Map([
      [
        id,
        {
          type: "inbound-rtp",
          kind: "video",
          framesDecoded: frames,
          bytesReceived: (bytes += 1000),
        },
      ],
    ]) as unknown as RTCStatsReport;
  const pc = Object.assign(new EventTarget(), {
    connectionState: "connected",
    getStats: vi.fn(async () => report()),
  });
  const healthy = vi.fn(),
    stalled = vi.fn();
  const stop = monitorScreenDecode(
    pc as unknown as RTCPeerConnection,
    healthy,
    stalled,
  );
  disposers.push(stop);
  return {
    page,
    pc,
    healthy,
    stalled,
    stop,
    report,
    progress: () => frames++,
    replace: () => {
      id = "replacement";
      frames = 0;
      bytes = 0;
    },
    resetCounters: () => {
      frames = 0;
      bytes = 0;
    },
  };
}

it("does not charge an unobserved suspension against the foreground stall deadline", async () => {
  const f = setup();
  await vi.advanceTimersByTimeAsync(10000);
  vi.setSystemTime(Date.now() + 60000);
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.stalled).not.toHaveBeenCalled();
  f.progress();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.stalled).not.toHaveBeenCalled();
});

it.each(["freeze", "visibilitychange"])(
  "discards statistics spanning %s and resumes with fresh observations",
  async (event) => {
    const f = setup();
    await vi.advanceTimersByTimeAsync(10000);
    let resolve!: (report: RTCStatsReport) => void;
    f.pc.getStats.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await vi.advanceTimersByTimeAsync(1000);
    f.page.visibilityState = "hidden";
    f.page.dispatchEvent(new Event(event));
    await vi.advanceTimersByTimeAsync(60000);
    f.page.visibilityState = "visible";
    f.page.dispatchEvent(
      new Event(event === "freeze" ? "resume" : event),
    );
    resolve(f.report());
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.stalled).not.toHaveBeenCalled();
    f.progress();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.stalled).not.toHaveBeenCalled();
  },
);

it.each([
  "missing",
  "error",
  "replacement",
  "counter-reset",
  "disconnect",
])(
  "requires a new continuous window after %s statistics",
  async (reason) => {
    const f = setup();
    await vi.advanceTimersByTimeAsync(10000);
    if (reason === "missing")
      f.pc.getStats.mockResolvedValueOnce(
        new Map() as RTCStatsReport,
      );
    if (reason === "error")
      f.pc.getStats.mockRejectedValueOnce(
        new Error("unavailable"),
      );
    if (reason === "replacement") f.replace();
    if (reason === "counter-reset") f.resetCounters();
    if (reason === "disconnect") {
      f.pc.connectionState = "disconnected";
      f.pc.dispatchEvent(
        new Event("connectionstatechange"),
      );
      f.pc.connectionState = "connected";
      f.pc.dispatchEvent(
        new Event("connectionstatechange"),
      );
    }
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.stalled).not.toHaveBeenCalled();
    // A real continuing stall still terminates; resets do not disable monitoring.
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.stalled).toHaveBeenCalledOnce();
  },
);

it("does not declare healthy decoding from progress separated by a suspension", async () => {
  const f = setup();
  for (let i = 0; i < 8; i++) {
    f.progress();
    await vi.advanceTimersByTimeAsync(1000);
  }
  vi.setSystemTime(Date.now() + 60000);
  f.progress();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.healthy).not.toHaveBeenCalled();
  for (let i = 0; i < 12; i++) {
    f.progress();
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(f.healthy).toHaveBeenCalledOnce();
  expect(f.stalled).not.toHaveBeenCalled();
});

it("ignores late statistics and page events after disposal", async () => {
  const f = setup();
  await vi.advanceTimersByTimeAsync(10000);
  let resolve!: (report: RTCStatsReport) => void;
  f.pc.getStats.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  f.stop();
  resolve(f.report());
  f.page.dispatchEvent(new Event("resume"));
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.stalled).not.toHaveBeenCalled();
  expect(f.healthy).not.toHaveBeenCalled();
});
