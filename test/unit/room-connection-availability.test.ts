// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  roomConnectionLockName,
  waitForRoomConnectionAvailability,
} from "@/libs/infrastructure/signaling/client/room-connection-lock";
const name = roomConnectionLockName(
  "wss://example.test/socket",
  " room ",
  "me",
);
const item = (name: string): LockInfo => ({
  name,
  clientId: "other-tab",
  mode: "exclusive",
});
let snapshot: LockManagerSnapshot;
let query: ReturnType<
  typeof vi.fn<() => Promise<LockManagerSnapshot>>
>;
let request: ReturnType<typeof vi.fn>;
const controllers: AbortController[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  snapshot = { held: [item(name)], pending: [] };
  query = vi.fn(async () => snapshot);
  request = vi.fn();
  vi.stubGlobal("navigator", { locks: { query, request } });
});
afterEach(() => {
  controllers.splice(0).forEach((c) => c.abort());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function wait() {
  const controller = new AbortController();
  controllers.push(controller);
  return {
    controller,
    promise: waitForRoomConnectionAvailability(
      name,
      controller.signal,
    ),
  };
}
describe("local room lock availability", () => {
  it("waits through held and pending locks without queuing or taking ownership", async () => {
    const f = wait();
    const done = vi.fn();
    void f.promise.then(done);
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).not.toHaveBeenCalled();
    snapshot = { held: [], pending: [item(name)] };
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).not.toHaveBeenCalled();
    snapshot = {
      held: [item("another-room")],
      pending: [],
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(await f.promise).toBe(true);
    expect(request).not.toHaveBeenCalled();
    query.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    window.dispatchEvent(new Event("focus"));
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["focus", "pageshow", "visibilitychange"])(
    "checks immediately on %s after a suspended page returns",
    async (event) => {
      const f = wait();
      await vi.advanceTimersByTimeAsync(0);
      snapshot = { held: [], pending: [] };
      (event === "visibilitychange"
        ? document
        : window
      ).dispatchEvent(new Event(event));
      expect(await f.promise).toBe(true);
    },
  );
  it("cleans up timers and wake listeners when canceled", async () => {
    const f = wait();
    await vi.advanceTimersByTimeAsync(0);
    const rejected = expect(
      f.promise,
    ).rejects.toMatchObject({ name: "AbortError" });
    f.controller.abort();
    await rejected;
    query.mockClear();
    snapshot = { held: [], pending: [] };
    await vi.advanceTimersByTimeAsync(3000);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(query).not.toHaveBeenCalled();
  });
  it("ignores a query response that arrives after cancellation", async () => {
    let resolve!: (snapshot: LockManagerSnapshot) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const f = wait();
    const rejected = expect(
      f.promise,
    ).rejects.toMatchObject({ name: "AbortError" });
    f.controller.abort();
    resolve({ held: [], pending: [] });
    await rejected;
    await vi.advanceTimersByTimeAsync(3000);
    expect(query).toHaveBeenCalledOnce();
  });
  it("retains manual recovery when the browser cannot query local ownership", async () => {
    query.mockRejectedValueOnce(
      new DOMException("Unavailable", "SecurityError"),
    );
    expect(await wait().promise).toBe(false);
    vi.stubGlobal("navigator", { locks: { request } });
    expect(await wait().promise).toBe(false);
  });
});
