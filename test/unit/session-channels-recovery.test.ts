// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PeerSessionChannelController } from "@/libs/domain/session-channels";

function channel(id: number): RTCDataChannel {
  const value = Object.assign(new EventTarget(), {
    id,
    label: "message",
    protocol: "message",
    readyState: "open",
    close: vi.fn(() => {
      value.readyState = "closing";
    }),
  });
  return value as unknown as RTCDataChannel;
}
function harness() {
  let lifetime = new AbortController();
  let pc = { connectionState: "new" } as RTCPeerConnection;
  const createChannel = vi.fn(async () => channel(0));
  const controller = new PeerSessionChannelController({
    polite: false,
    getStatus: () => "connected",
    getPeerConnection: () => pc,
    getSessionSignal: () => lifetime.signal,
    ordered: () => false,
    createChannel,
    onChannel: vi.fn(),
    onMessage: vi.fn(),
    onMessageChannelChange: vi.fn(),
  });
  return {
    controller,
    createChannel,
    connected: () => {
      Object.assign(pc, { connectionState: "connected" });
    },
    reset: () => {
      lifetime.abort();
      controller.reset();
      lifetime = new AbortController();
      pc = { connectionState: "new" } as RTCPeerConnection;
    },
    dispose: () => {
      lifetime.abort();
      controller.close();
    },
  };
}
describe("message channels across peer recovery", () => {
  it("keeps a replacement channel when an old channel with the same SCTP ID closes late", () => {
    const h = harness();
    const old = channel(0);
    h.controller.acceptIncomingChannel(old);
    h.reset();
    h.controller.acceptIncomingChannel(channel(0));
    old.dispatchEvent(new Event("close"));
    h.controller.updateMessageChannelOpenState();
    expect(h.controller.isMessageChannelReady).toBe(true);
    h.dispose();
  });

  it("can create the message channel after an earlier check ran before WebRTC connected", async () => {
    const h = harness();
    await h.controller.ensureMessageChannelReady("initial");
    h.connected();
    await h.controller.ensureMessageChannelReady(
      "connected",
    );
    expect(h.createChannel).toHaveBeenCalledOnce();
    h.dispose();
  });

  it("does not let an aborted old channel wait create a channel on the new connection", async () => {
    const h = harness();
    h.connected();
    const connecting = channel(0);
    Object.assign(connecting, { readyState: "connecting" });
    h.controller.acceptIncomingChannel(connecting);
    const pending =
      h.controller.ensureMessageChannelReady("old");
    h.reset();
    h.connected();
    await pending;
    expect(h.createChannel).not.toHaveBeenCalled();
    await h.controller.ensureMessageChannelReady("new");
    expect(h.createChannel).toHaveBeenCalledOnce();
    h.dispose();
  });
});
