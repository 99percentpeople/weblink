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
import { buildTransferPacket } from "@/libs/domain/transfer/packet";
const unzip = vi.hoisted(() => ({
  post: vi.fn(),
  receive: undefined as
    | ((event: { data: unknown }) => void)
    | undefined,
}));
vi.mock(
  "@/libs/domain/transfer/uncompress-worker?worker",
  () => ({
    default: class {
      set onmessage(receive: typeof unzip.receive) {
        unzip.receive = receive;
      }
      postMessage = unzip.post;
      terminate() {}
    },
  }),
);
let receiver: FileReceiver;
beforeEach(() => {
  vi.useFakeTimers();
  unzip.post.mockClear();
  unzip.receive = undefined;
});
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
const block = (
  channel: RTCDataChannel,
  index: number,
  last = false,
) =>
  channel.onmessage?.call(
    channel,
    new MessageEvent("message", {
      data: buildTransferPacket(
        0,
        index,
        last,
        new Uint8Array([index + 1]),
      ),
    }),
  );

it("assembles a partially received chunk when a timeout retransmits earlier blocks", async () => {
  const { channel } = await setup();
  block(channel, 0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(channel.send).toHaveBeenCalledOnce();
  block(channel, 0);
  block(channel, 1, true);
  expect(unzip.post).toHaveBeenCalledOnce();
  expect([...unzip.post.mock.calls[0][0].data]).toEqual([
    1, 2,
  ]);
});

it("allows retry after decompression fails and ignores duplicates while storing or after success", async () => {
  const { channel, cache } = await setup();
  block(channel, 0, true);
  unzip.receive?.({
    data: {
      error: "bad compression",
      context: { chunkIndex: 0 },
    },
  });
  await vi.advanceTimersByTimeAsync(10_000);
  block(channel, 0, true);
  expect(unzip.post).toHaveBeenCalledTimes(2);
  const stored = deferred<void>();
  cache.storeChunk.mockReturnValueOnce(stored.promise);
  unzip.receive?.({
    data: {
      data: new Uint8Array([1]),
      context: { chunkIndex: 0 },
    },
  });
  block(channel, 0, true);
  expect(unzip.post).toHaveBeenCalledTimes(2);
  stored.resolve();
  await vi.advanceTimersByTimeAsync(0);
  block(channel, 0, true);
  expect(unzip.post).toHaveBeenCalledTimes(2);
  expect(cache.storeChunk).toHaveBeenCalledOnce();
});
it("ignores a worker result delivered after the receiver has paused", async () => {
  const { channel, cache } = await setup();
  block(channel, 0, true);
  await receiver.pause();
  unzip.receive?.({
    data: {
      data: new Uint8Array([1]),
      context: { chunkIndex: 0 },
    },
  });
  expect(cache.storeChunk).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

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
