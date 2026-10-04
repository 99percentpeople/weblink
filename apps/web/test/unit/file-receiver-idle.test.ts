// @vitest-environment jsdom
import {
  beforeEach,
  afterEach,
  it,
  expect,
  vi,
} from "vitest";
import { FileReceiver } from "@/libs/domain/transfer/file-receiver";
import {
  fakeCache,
  fakeChannel,
} from "../support/file-transfer";
import { deferred } from "../support/rtc-transport";
vi.mock(
  "@/libs/domain/transfer/uncompress-worker?worker",
  () => ({
    default: class {
      terminate() {}
    },
  }),
);
let receiver: FileReceiver;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  receiver?.close();
  vi.useRealTimers();
});
async function setup() {
  const cache = fakeCache();
  receiver = new FileReceiver({ cache });
  await receiver.initialize();
  const channel = fakeChannel();
  Object.defineProperty(channel, "bufferedAmount", {
    value: 0,
  });
  receiver.setChannel(channel);
  const activity = (type = "complete") =>
    channel.onmessage?.call(
      channel,
      new MessageEvent("message", {
        data: JSON.stringify({ type }),
      }),
    );
  return { cache, channel, activity };
}
it("retries only after ten seconds without activity and cancels the deadline on pause", async () => {
  const { cache, channel, activity } = await setup();
  activity();
  await vi.advanceTimersByTimeAsync(9_000);
  activity();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(cache.isTransferComplete).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(channel.send).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  activity("pause");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(channel.send).toHaveBeenCalledOnce();
});
it("does not overlap slow checks or send stale ranges after fresh activity or close", async () => {
  const { cache, channel, activity } = await setup();
  const ranges = deferred<[[number, number]]>();
  cache.getReqRanges.mockReturnValueOnce(ranges.promise);
  activity();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(cache.getReqRanges).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  activity();
  ranges.resolve([[0, 1]]);
  await vi.advanceTimersByTimeAsync(0);
  expect(channel.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  receiver.close();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(channel.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
