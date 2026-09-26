import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PeerNegotiationController } from "@/libs/domain/peer-negotiation";
import type { SignalingService } from "@/libs/domain/signaling";

function peer() {
  const pc = {
    signalingState: "stable" as RTCSignalingState,
    currentRemoteDescription:
      null as RTCSessionDescription | null,
    remoteDescription:
      null as RTCSessionDescriptionInit | null,
    localDescription:
      null as RTCSessionDescriptionInit | null,
    setLocalDescription: vi.fn(async () => {
      pc.localDescription = {
        type: pc.remoteDescription ? "answer" : "offer",
        sdp: "local-sdp",
      };
    }),
    setRemoteDescription: vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        pc.remoteDescription = description;
      },
    ),
  };
  return pc as unknown as RTCPeerConnection;
}
function setup(
  prepareConnection: (
    pc: RTCPeerConnection,
  ) => Promise<void>,
) {
  let current = peer();
  const sender = {
    clientId: "local",
    targetClientId: "remote",
    status: "connected",
    sendSignal: vi.fn(async () => {}),
  } as unknown as SignalingService;
  const negotiation = new PeerNegotiationController({
    sender,
    polite: true,
    getPeerConnection: () => current,
    prepareConnection,
    replacePeerConnection: () => {
      current = peer();
      negotiation.startConnection(current);
      return current;
    },
  });
  negotiation.startConnection(current);
  return {
    sender,
    negotiation,
    current: () => current,
    replace: () => {
      current = peer();
      negotiation.startConnection(current);
    },
  };
}
function offer(generation = "remote-generation") {
  return {
    type: "offer" as const,
    data: { sdp: "remote-sdp", generation },
    clientId: "remote",
    targetClientId: "local",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ICE preparation within negotiation", () => {
  it("waits for fresh credentials before applying a local offer", async () => {
    let resolve!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    );
    const { current, negotiation } = setup(prepare);
    const pending = negotiation.sendOffer(current());
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledWith(current());
    expect(
      current().setLocalDescription,
    ).not.toHaveBeenCalled();
    resolve();
    await pending;
    expect(
      current().setLocalDescription,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not apply a delayed credential completion to a retired connection", async () => {
    let resolve!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    );
    const { current, negotiation, replace, sender } =
      setup(prepare);
    const old = current();
    const pending = negotiation.sendOffer(old);
    await Promise.resolve();
    replace();
    resolve();
    await pending;
    expect(old.setLocalDescription).not.toHaveBeenCalled();
    expect(
      current().setLocalDescription,
    ).not.toHaveBeenCalled();
    expect(sender.sendSignal).not.toHaveBeenCalled();
  });

  it("prepares the replacement PC before answering a remote restart", async () => {
    vi.stubGlobal(
      "RTCSessionDescription",
      class {
        type: RTCSdpType;
        sdp: string;
        constructor(init: RTCSessionDescriptionInit) {
          this.type = init.type;
          this.sdp = init.sdp ?? "";
        }
      },
    );
    const prepare = vi.fn(async (pc: RTCPeerConnection) => {
      expect(
        pc.setRemoteDescription,
      ).not.toHaveBeenCalled();
      expect(pc.setLocalDescription).not.toHaveBeenCalled();
    });
    const { current, negotiation, sender } = setup(prepare);
    const old = current();
    Object.defineProperty(old, "currentRemoteDescription", {
      value: { type: "offer", sdp: "old" },
    });
    await negotiation.enqueueSignal(offer());
    expect(current()).not.toBe(old);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(current());
    expect(
      current().setRemoteDescription,
    ).toHaveBeenCalledTimes(1);
    expect(
      current().setLocalDescription,
    ).toHaveBeenCalledTimes(1);
    expect(old.setRemoteDescription).not.toHaveBeenCalled();
    expect(sender.sendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ type: "answer" }),
    );
  });

  it("does not apply a remote offer after its pending preparation was superseded", async () => {
    let resolve!: () => void;
    const prepare = vi.fn(
      () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    );
    const { current, negotiation, replace } =
      setup(prepare);
    const old = current();
    const handling = negotiation.enqueueSignal(offer());
    await Promise.resolve();
    replace();
    resolve();
    await handling;
    expect(old.setRemoteDescription).not.toHaveBeenCalled();
    expect(
      current().setRemoteDescription,
    ).not.toHaveBeenCalled();
  });
});
