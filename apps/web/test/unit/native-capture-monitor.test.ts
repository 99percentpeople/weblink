import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type {
  CaptureStatus,
  NativeCapture,
} from "@weblink/platform";
import { monitorNativeCapture } from "@/libs/application/native-capture-monitor";

const running = {
  sessionId: "capture",
  state: "running",
} as CaptureStatus;
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  let receive!: (status: CaptureStatus) => void;
  const unwatch = vi.fn();
  const api = {
    watch: vi.fn(
      async (
        _id: string,
        callback: typeof receive,
      ): Promise<() => void> => {
        receive = callback;
        callback(running);
        return unwatch;
      },
    ),
    renew: vi.fn(async () => {}),
    status: vi.fn(),
  };
  const changed = vi.fn();
  const error = vi.fn();
  const start = () =>
    monitorNativeCapture(
      api as unknown as NativeCapture,
      "capture",
      changed,
      error,
    );
  return {
    api,
    changed,
    error,
    unwatch,
    start,
    emit: (status: CaptureStatus) => receive(status),
  };
}
it("renews independently of visibility without polling state and stops on a pushed terminal event", async () => {
  const { api, changed, unwatch, start, emit } = setup();
  const close = start();
  await vi.advanceTimersByTimeAsync(35_000);
  expect(api.renew).toHaveBeenCalledTimes(4);
  expect(api.watch).toHaveBeenCalledOnce();
  expect(api.status).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
  emit({
    ...running,
    sessionId: "another",
    state: "closed",
  });
  expect(changed).toHaveBeenCalledOnce();
  emit({ ...running, state: "closed" });
  expect(changed).toHaveBeenCalledTimes(2);
  expect(unwatch).toHaveBeenCalledOnce();
  close();
  emit(running);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.renew).toHaveBeenCalledTimes(4);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("retries failed observation and renewal without stopping the capture", async () => {
  const { api, start, error } = setup();
  api.watch.mockRejectedValueOnce(
    new Error("watch unavailable"),
  );
  api.renew.mockRejectedValueOnce(
    new Error("renew unavailable"),
  );
  const close = start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.watch).toHaveBeenCalledTimes(2);
  expect(api.renew).toHaveBeenCalledTimes(2);
  expect(error).toHaveBeenCalledTimes(2);
  close();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(api.renew).toHaveBeenCalledTimes(2);
});
it("releases late subscription completion and does not rearm a renewal after close", async () => {
  const { api, start, changed, unwatch } = setup();
  let finishWatch!: (dispose: () => void) => void;
  let finishRenew!: () => void;
  let receive!: (status: CaptureStatus) => void;
  api.watch.mockImplementationOnce((_id, callback) => {
    receive = callback;
    return new Promise((resolve) => {
      finishWatch = resolve;
    });
  });
  api.renew.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRenew = resolve;
      }),
  );
  const close = start();
  close();
  receive(running);
  finishWatch(unwatch);
  finishRenew();
  await tick();
  expect(unwatch).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
