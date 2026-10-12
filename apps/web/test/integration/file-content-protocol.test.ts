import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RtcProtocol,
  type WebRtcProtocol,
} from "@/libs/application/rtc/rtc-protocol";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { validateSessionMessage } from "@/libs/domain/protocol/validation";
import {
  FakeRtcTransport,
  makeSession,
} from "../support/rtc-transport";
const fingerprint = {
  version: 1 as const,
  algorithm: "blake3-256" as const,
  digest: "0".repeat(64),
  size: 3,
};
const offer = {
  fid: "file",
  fileName: "test",
  fileSize: 3,
  chunkSize: 1024,
  fingerprint,
};
const instances: WebRtcProtocol[] = [];
const setup = () => {
  const transport = new FakeRtcTransport();
  const protocol = new RtcProtocol(transport);
  instances.push(protocol);
  return { transport, protocol };
};
afterEach(() => {
  instances
    .splice(0)
    .forEach((protocol) => protocol.dispose());
});
describe("content negotiation", () => {
  it("requires a typed file result, ignores ordinary ACKs, and ignores duplicate results", async () => {
    const { protocol, transport } = setup();
    const local = makeSession(),
      remote = makeSession("b", "a");
    let complete = false;
    const pending = protocol
      .call(local, "send-file", offer, { id: "offer" })
      .then((value) => {
        complete = true;
        return value;
      });
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "ack",
        { mode: "receive" },
        { id: "offer" },
      ),
    );
    expect(complete).toBe(false);
    const response = createSessionMessage(
      remote,
      "file-offer-result",
      { fid: "file", disposition: "have" },
      { id: "offer" },
    );
    await transport.emit(local, response);
    await expect(pending).resolves.toMatchObject({
      disposition: "have",
    });
    await transport.emit(local, response);
    expect(
      transport.sendCalls.filter(
        (call) => call.message.type === "ack",
      ),
    ).toHaveLength(0);
  });
  it("rejects mismatched file responses and malformed content identities", async () => {
    const { protocol, transport } = setup();
    const local = makeSession(),
      remote = makeSession("b", "a");
    const result = protocol.call(
      local,
      "send-file",
      offer,
      { id: "offer" },
    );
    const rejected = expect(result).rejects.toMatchObject({
      code: "invalid-message",
    });
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "file-offer-result",
        { fid: "wrong", disposition: "have" },
        { id: "offer" },
      ),
    );
    await rejected;
    const message = createSessionMessage(
      remote,
      "send-file",
      offer,
    );
    expect(() =>
      validateSessionMessage({
        ...message,
        fingerprint: { ...fingerprint, size: 4 },
      }),
    ).toThrow();
    expect(() =>
      validateSessionMessage({
        ...message,
        fingerprint: {
          ...fingerprint,
          digest: "A".repeat(64),
        },
      }),
    ).toThrow();
  });
  it("replays one persisted handler result on network retries", async () => {
    const { protocol, transport } = setup();
    const local = makeSession(),
      remote = makeSession("b", "a");
    const handler = vi.fn(async () => ({
      fid: "file",
      disposition: "deferred" as const,
      reason: "local-job" as const,
    }));
    protocol.handle("send-file", handler);
    const message = createSessionMessage(
      remote,
      "send-file",
      offer,
      { id: "offer", createdAt: 1 },
    );
    await transport.emit(local, message);
    await transport.emit(local, message);
    expect(handler).toHaveBeenCalledOnce();
    expect(
      transport.sendCalls.filter(
        (call) => call.message.type === "file-offer-result",
      ),
    ).toHaveLength(2);
  });
});
