import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  NativeKeyboardEvent,
  NativeKeyboardSession,
} from "@weblink/platform";
import {
  NativeKeyboardForwarder,
  type NativeKeyboardPort,
} from "@/libs/application/native-keyboard";

function setup(pending?: Promise<NativeKeyboardSession>) {
  let receive!: (event: NativeKeyboardEvent) => void;
  const session = {
    renew: vi.fn(async (_sequence: number) => {}),
    close: vi.fn(async () => {}),
  };
  const port = {
    current: vi.fn(() => true),
    input: vi.fn(() => true),
    reset: vi.fn(),
    cancel: vi.fn(),
    stopped: vi.fn(),
    clipboard: vi.fn((_action: "copy" | "paste") => false),
  } satisfies NativeKeyboardPort;
  const start = vi.fn((_shortcut, listener) => {
    receive = listener;
    return pending ?? Promise.resolve(session);
  });
  const forwarder = new NativeKeyboardForwarder(
    { supported: async () => true, start },
    "ctrl-alt-shift-q",
    port,
  );
  const key = (
    sequence: number,
    down = true,
    scanCode = 0x1e,
    timestamp = Date.now(),
  ) =>
    receive({
      type: "key",
      sequence,
      down,
      scanCode,
      extended: false,
      timestamp,
    });
  return {
    forwarder,
    port,
    session,
    start,
    key,
    receive: (event: NativeKeyboardEvent) => receive(event),
  };
}
describe("native keyboard focus and transport ownership", () => {
  it("consumes clipboard chords once, releases remote modifiers and preserves normal keys when disabled", () => {
    const s = setup();
    s.port.clipboard.mockReturnValue(true);
    s.key(1, true, 0x1d);
    s.key(2, true, 0x2f);
    s.key(3, true, 0x2f);
    s.key(4, false, 0x2f);
    s.key(5, false, 0x1d);
    expect(s.port.clipboard).toHaveBeenCalledOnce();
    expect(s.port.clipboard).toHaveBeenCalledWith("paste");
    expect(s.port.input).not.toHaveBeenCalledWith(
      expect.objectContaining({ scanCode: 0x2f }),
    );
    expect(s.port.input).toHaveBeenCalledWith({
      type: "key",
      scanCode: 0x1d,
      extended: false,
      down: false,
    });
    s.port.clipboard.mockReturnValue(false);
    s.key(6, true, 0x1d);
    s.key(7, true, 0x2e);
    expect(s.port.input).toHaveBeenCalledWith({
      type: "key",
      scanCode: 0x2e,
      extended: false,
      down: true,
    });
    s.forwarder.stop();
  });
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("forwards ordered native keys, acknowledges consumption and releases only owned keys", async () => {
    const s = setup();
    await Promise.resolve();
    s.key(1, true, 0x1d);
    s.key(2);
    s.key(3);
    s.key(4, false);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.session.renew).toHaveBeenCalledWith(4);
    s.forwarder.stop();
    expect(
      s.port.input.mock.calls.map(([event]: any[]) => [
        event.scanCode,
        event.down,
      ]),
    ).toEqual([
      [0x1d, true],
      [0x1e, true],
      [0x1e, true],
      [0x1e, false],
      [0x1d, false],
    ]);
    expect(s.session.close).toHaveBeenCalledOnce();
    s.key(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.port.input).toHaveBeenCalledTimes(5);
    expect(s.session.renew).toHaveBeenCalledTimes(1);
  });
  it.each(["gap", "old", "future"])(
    "rejects %s events and releases the old input epoch",
    async (reason) => {
      const s = setup();
      await Promise.resolve();
      s.key(1);
      s.key(
        reason === "gap" ? 3 : 2,
        true,
        0x30,
        Date.now() +
          (reason === "old"
            ? -101
            : reason === "future"
              ? 101
              : 0),
      );
      expect(s.port.input).toHaveBeenCalledTimes(2); // first down and owned release only
      expect(s.port.reset).toHaveBeenCalledOnce();
      expect(s.port.stopped).toHaveBeenCalledWith(true);
      s.key(4);
      expect(s.port.input).toHaveBeenCalledTimes(2);
    },
  );
  it("does not transfer a late startup to a newly focused surface", async () => {
    let resolve!: (s: NativeKeyboardSession) => void;
    const s = setup(
      new Promise((r) => {
        resolve = r;
      }),
    );
    s.forwarder.stop();
    s.key(1);
    resolve(s.session);
    await Promise.resolve();
    expect(s.port.input).not.toHaveBeenCalled();
    expect(s.session.close).toHaveBeenCalledOnce();
    expect(s.session.renew).not.toHaveBeenCalled();
  });
  it("rejects queued input after focus, grant or source changes", async () => {
    const s = setup();
    await Promise.resolve();
    s.key(1);
    s.port.current.mockReturnValue(false);
    s.key(2, true, 0x30);
    expect(s.port.input.mock.calls.at(-1)).toEqual([
      {
        type: "key",
        scanCode: 0x1e,
        extended: false,
        down: false,
      },
    ]);
    expect(s.port.input).toHaveBeenCalledTimes(2);
    expect(s.port.cancel).not.toHaveBeenCalled();
  });
  it.each(["exit", "emergency"] as const)(
    "ends control for the native %s shortcut",
    async (reason) => {
      const s = setup();
      await Promise.resolve();
      s.key(1, true, 0x1d);
      s.receive({ type: "stopped", reason });
      expect(s.port.cancel).toHaveBeenCalledOnce();
      expect(s.port.stopped).toHaveBeenCalledWith(false);
      expect(s.port.input).toHaveBeenCalledTimes(2);
    },
  );
  it("stops renewing after backpressure or native lease failure, without replay", async () => {
    const s = setup();
    await Promise.resolve();
    s.port.input.mockReturnValue(false);
    s.key(1);
    expect(s.port.reset).toHaveBeenCalledOnce();
    expect(s.session.close).toHaveBeenCalledOnce();
    const other = setup();
    await Promise.resolve();
    other.session.renew.mockRejectedValue(
      new Error("expired"),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(other.port.reset).toHaveBeenCalledOnce();
    expect(other.port.stopped).toHaveBeenCalledWith(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(other.session.renew).toHaveBeenCalledOnce();
  });
  it("reports a failed startup once and ignores late native events", async () => {
    const s = setup(
      Promise.reject(new Error("unavailable")),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(s.port.stopped).toHaveBeenCalledWith(true);
    s.key(1);
    expect(s.port.input).not.toHaveBeenCalled();
  });
});
