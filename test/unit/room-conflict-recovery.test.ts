import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RoomConflictRecovery } from "@/libs/application/room-conflict-recovery";

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups.splice(0).forEach((stop) => stop()),
);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function setup() {
  const available = deferred<boolean>();
  const joined = deferred<void>();
  const options = {
    waitUntilAvailable: vi.fn(
      (_signal: AbortSignal) => available.promise,
    ),
    join: vi.fn(() => joined.promise),
    cancelJoin: vi.fn(),
    onRestored: vi.fn(),
    onError: vi.fn(),
  };
  const recovery = new RoomConflictRecovery(options);
  cleanups.push(() => recovery.stop());
  return { ...options, recovery, available, joined };
}
describe("automatic local room recovery", () => {
  it("waits for the owner to leave, makes one ordinary join, and restores only after connection succeeds", async () => {
    const f = setup();
    f.recovery.start();
    f.recovery.start();
    expect(f.waitUntilAvailable).toHaveBeenCalledOnce();
    expect(f.join).not.toHaveBeenCalled();
    f.available.resolve(true);
    await flush();
    expect(f.join).toHaveBeenCalledOnce();
    expect(f.onRestored).not.toHaveBeenCalled();
    f.joined.resolve();
    await flush();
    expect(f.onRestored).toHaveBeenCalledOnce();
    f.recovery.stop();
    expect(f.cancelJoin).not.toHaveBeenCalled();
  });
  it("aborts availability checks and ignores a late snapshot after manual takeover or leaving", async () => {
    const f = setup();
    f.recovery.start();
    const signal = f.waitUntilAvailable.mock.calls[0][0];
    f.recovery.stop();
    expect(signal.aborted).toBe(true);
    f.available.resolve(true);
    await flush();
    expect(f.join).not.toHaveBeenCalled();
    expect(f.onRestored).not.toHaveBeenCalled();
  });
  it("cancels its own pending join and ignores stale completion", async () => {
    const f = setup();
    f.recovery.start();
    f.available.resolve(true);
    await flush();
    f.recovery.stop();
    f.recovery.stop();
    expect(f.cancelJoin).toHaveBeenCalledOnce();
    f.joined.resolve();
    await flush();
    expect(f.onRestored).not.toHaveBeenCalled();
  });
  it("does not let an old join failure cancel a restarted recovery", async () => {
    const f = setup();
    const restarted = deferred<void>();
    f.join
      .mockImplementationOnce(() => f.joined.promise)
      .mockImplementationOnce(() => restarted.promise);
    f.recovery.start();
    f.available.resolve(true);
    await flush();
    f.recovery.stop();
    f.recovery.start();
    await flush();
    expect(f.join).toHaveBeenCalledTimes(2);
    f.joined.reject(
      new DOMException("Cancelled", "AbortError"),
    );
    await flush();
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onRestored).not.toHaveBeenCalled();
    f.recovery.stop();
    expect(f.cancelJoin).toHaveBeenCalledTimes(2);
    restarted.resolve();
    await flush();
    expect(f.onRestored).not.toHaveBeenCalled();
  });
  it("keeps waiting when another blocked page acquires the lock first", async () => {
    const f = setup();
    const next = deferred<boolean>();
    f.waitUntilAvailable
      .mockImplementationOnce(() => f.available.promise)
      .mockImplementationOnce(() => next.promise);
    f.join.mockRejectedValueOnce(
      new Error("Room is already open in another tab"),
    );
    f.recovery.start();
    f.available.resolve(true);
    await flush();
    expect(f.waitUntilAvailable).toHaveBeenCalledTimes(2);
    expect(f.onError).not.toHaveBeenCalled();
    expect(f.onRestored).not.toHaveBeenCalled();
    next.resolve(true);
    f.joined.resolve();
    await flush();
    expect(f.join).toHaveBeenCalledTimes(2);
    expect(f.onRestored).toHaveBeenCalledOnce();
  });
  it("reports a failed reconnect once and leaves explicit retry available", async () => {
    const f = setup();
    f.recovery.start();
    f.available.resolve(true);
    await flush();
    const error = new Error("network unavailable");
    f.joined.reject(error);
    await flush();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledWith(error);
    expect(f.waitUntilAvailable).toHaveBeenCalledOnce();
    expect(f.onRestored).not.toHaveBeenCalled();
  });
  it("does not reconnect when local availability cannot be verified", async () => {
    const f = setup();
    f.recovery.start();
    f.available.resolve(false);
    await flush();
    expect(f.join).not.toHaveBeenCalled();
    expect(f.onRestored).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
  });
});
