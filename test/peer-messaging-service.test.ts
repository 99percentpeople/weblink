import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PeerMessagingService } from "@/libs/application/messaging/peer-messaging-service";
import { RtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import { createSessionMessage } from "@/libs/core/protocol/messages";
import {
  FakeRtcTransport,
  makeSession,
  flushRtc,
} from "./helpers/rtc-transport";

const protocols: RtcProtocol[] = [];
const local = makeSession();
const remote = makeSession("b", "a");
const watch = <T>(promise: Promise<T>) => {
  void promise.catch(() => {});
  return promise;
};
function setup() {
  const transport = new FakeRtcTransport();
  const protocol = new RtcProtocol(transport);
  protocols.push(protocol);
  const store = {
    setSendMessage: vi.fn(),
    retrySendMessage: vi.fn(),
    setReceiveMessage: vi.fn(),
  };
  return {
    transport,
    store,
    service: new PeerMessagingService(protocol, store),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  protocols
    .splice(0)
    .forEach((protocol) => protocol.dispose());
  vi.useRealTimers();
});

describe("peer messaging state bridge", () => {
  it("tracks local send and receipt without a second timeout owner", async () => {
    const { service, transport, store } = setup();
    const pending = service.send(local, "send-text", {
      data: "hello",
    });
    const message = transport.sendCalls[0]!.message;
    expect(store.setSendMessage).toHaveBeenCalledWith(
      message,
      { timeoutMs: null },
    );
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "ack",
        { mode: "receive" },
        { id: message.id },
      ),
    );
    const result = await pending;
    expect(result?.message).toBe(message);
    expect(store.setReceiveMessage).toHaveBeenCalledTimes(
      1,
    );
    expect(store.setReceiveMessage).toHaveBeenCalledWith(
      result!.ackMessage,
    );
  });

  it("preserves a retry identity without adding another history entry", async () => {
    const { service, transport, store } = setup();
    const pending = service.send(
      local,
      "send-text",
      { data: "hello" },
      { id: "m1", createdAt: 42, retry: true },
    );
    expect(store.setSendMessage).not.toHaveBeenCalled();
    expect(store.retrySendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m1", createdAt: 42 }),
      { timeoutMs: null },
    );
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "ack",
        { mode: "receive" },
        { id: "m1" },
      ),
    );
    await pending;
  });

  it("maps remote errors into the existing message error state", async () => {
    const { service, transport, store } = setup();
    const pending = service.send(
      local,
      "send-text",
      { data: "hello" },
      { id: "m1" },
    );
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "error",
        { error: "denied" },
        { id: "m1" },
      ),
    );
    await expect(pending).resolves.toBeNull();
    expect(store.setReceiveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        id: "m1",
        client: "a",
        target: "b",
        error: "denied",
      }),
    );
  });

  it("maps request timeout into a single local failure", async () => {
    const { service, store } = setup();
    const pending = service.send(
      local,
      "send-text",
      { data: "hello" },
      { id: "m1", timeoutMs: 10 },
    );
    await flushRtc();
    vi.advanceTimersByTime(10);
    await expect(pending).resolves.toBeNull();
    expect(store.setReceiveMessage).toHaveBeenCalledTimes(
      1,
    );
    expect(store.setReceiveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", id: "m1" }),
    );
  });

  it("does not reset message state on a duplicate pending send", async () => {
    const { service, transport, store } = setup();
    const pending = service.send(
      local,
      "send-text",
      { data: "hello" },
      { id: "m1" },
    );
    await expect(
      service.send(
        local,
        "send-text",
        { data: "hello" },
        { id: "m1", retry: true },
      ),
    ).resolves.toBeNull();
    expect(store.retrySendMessage).not.toHaveBeenCalled();
    expect(store.setReceiveMessage).not.toHaveBeenCalled();
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "ack",
        { mode: "receive" },
        { id: "m1" },
      ),
    );
    await pending;
  });

  it("propagates nested remote-command failure after recording it", async () => {
    const { service, transport, store } = setup();
    const pending = watch(
      service.send(
        local,
        "request-file",
        {
          fid: "f",
          fileName: "a.txt",
          fileSize: 10,
          chunkSize: 4,
          resume: true,
        },
        { id: "m1", throwOnError: true },
      ),
    );
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "error",
        { error: "file unavailable" },
        { id: "m1" },
      ),
    );
    await expect(pending).rejects.toMatchObject({
      code: "remote-error",
    });
    expect(store.setReceiveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", id: "m1" }),
    );
  });
});
