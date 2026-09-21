import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MessageSendQueue } from "@/libs/core/protocol/send-queue";
import { createSessionMessage } from "@/libs/core/protocol/messages";
import { RtcProtocol } from "@/libs/services/rtc-protocol";
import {
  FakeRtcTransport,
  makeSession,
  flushRtc,
} from "./helpers/rtc-transport";

const queues: MessageSendQueue[] = [];
const protocols: RtcProtocol[] = [];
const watch = <T>(promise: Promise<T>) => {
  void promise.catch(() => {});
  return promise;
};
const session = makeSession();
const message = createSessionMessage(
  session,
  "send-text",
  { data: "hello" },
  { id: "m1", createdAt: 1 },
);
function setup() {
  const channel = {
    readyState: "connecting",
    send: vi.fn(),
  };
  const queue = new MessageSendQueue(
    () => channel as unknown as RTCDataChannel,
  );
  queues.push(queue);
  return { queue, channel };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  protocols
    .splice(0)
    .forEach((protocol) => protocol.dispose());
  queues.splice(0).forEach((queue) => queue.close());
  vi.useRealTimers();
});

describe("cancel-safe message queue", () => {
  it("only resolves once the actual send succeeds", async () => {
    const { queue, channel } = setup();
    const promise = queue.send(message);
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await flushRtc();
    expect(done).toBe(false);
    expect(queue.size).toBe(1);
    channel.readyState = "open";
    queue.flush();
    await promise;
    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify(message),
    );
    expect(queue.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires unsent messages and never replays them after recovery", async () => {
    const { queue, channel } = setup();
    const promise = watch(
      queue.send(message, { sendTimeoutMs: 100 }),
    );
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toMatchObject({
      code: "send-timeout",
    });
    expect(queue.size).toBe(0);
    channel.readyState = "open";
    queue.flush();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("removes an aborted message before the channel can send it", async () => {
    const { queue, channel } = setup();
    const controller = new AbortController();
    const promise = watch(
      queue.send(message, { signal: controller.signal }),
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      code: "aborted",
    });
    channel.readyState = "open";
    queue.flush();
    expect(channel.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not queue a pre-aborted send", async () => {
    const { queue, channel } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      queue.send(message, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(queue.size).toBe(0);
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("shares duplicate queued sends without sharing caller cancellation", async () => {
    const { queue, channel } = setup();
    const controller = new AbortController();
    const first = watch(
      queue.send(message, { signal: controller.signal }),
    );
    const second = queue.send(message);
    expect(queue.size).toBe(1);
    controller.abort();
    await expect(first).rejects.toMatchObject({
      code: "aborted",
    });
    expect(queue.size).toBe(1);
    channel.readyState = "open";
    queue.flush();
    await second;
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it("fails actual send errors instead of silently retaining the message", async () => {
    const { queue, channel } = setup();
    channel.readyState = "open";
    channel.send.mockImplementation(() => {
      throw new Error("too large");
    });
    await expect(queue.send(message)).rejects.toMatchObject(
      { code: "send-failed", message: "too large" },
    );
    expect(queue.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes all pending sends and rejects future ones", async () => {
    const { queue, channel } = setup();
    const first = watch(queue.send(message));
    const second = watch(
      queue.send({ ...message, id: "m2" }),
    );
    queue.close();
    await expect(first).rejects.toMatchObject({
      code: "closed",
    });
    await expect(second).rejects.toMatchObject({
      code: "closed",
    });
    await expect(queue.send(message)).rejects.toMatchObject(
      { code: "closed" },
    );
    expect(channel.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps distinct messages in FIFO order", async () => {
    const { queue, channel } = setup();
    const first = queue.send(message);
    const second = queue.send({ ...message, id: "m2" });
    channel.readyState = "open";
    queue.flush();
    await Promise.all([first, second]);
    expect(
      channel.send.mock.calls.map(
        ([raw]) => JSON.parse(raw).id,
      ),
    ).toEqual(["m1", "m2"]);
  });

  it("propagates queue expiry through call() without a late send", async () => {
    const { queue, channel } = setup();
    const transport = new FakeRtcTransport();
    transport.sendImpl = (_session, data, options) =>
      queue.send(data, options);
    const protocol = new RtcProtocol(transport);
    protocols.push(protocol);
    const pending = watch(
      protocol.call(
        session,
        "send-text",
        { data: "hello" },
        { sendTimeoutMs: 100, timeoutMs: 10 },
      ),
    );
    vi.advanceTimersByTime(99);
    await flushRtc();
    expect(queue.size).toBe(1); // The shorter ACK timer has not started.
    vi.advanceTimersByTime(1);
    await expect(pending).rejects.toMatchObject({
      code: "send-timeout",
    });
    channel.readyState = "open";
    queue.flush();
    expect(channel.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unbinds a session by cancelling its unsent transport requests", async () => {
    const { queue, channel } = setup();
    const transport = new FakeRtcTransport();
    transport.sendImpl = (_session, data, options) =>
      queue.send(data, options);
    const protocol = new RtcProtocol(transport);
    protocols.push(protocol);
    const pending = watch(
      protocol.call(session, "send-text", {
        data: "hello",
      }),
    );
    transport.close(session);
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
    expect(queue.size).toBe(0);
    channel.readyState = "open";
    queue.flush();
    expect(channel.send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
