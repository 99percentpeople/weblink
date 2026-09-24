import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PeerNegotiationController } from "@/libs/domain/peer-negotiation";
import type {
  ClientSignal,
  SignalingService,
} from "@/libs/domain/signaling";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function peer() {
  const pc = {
    signalingState: "stable" as RTCSignalingState,
    localDescription:
      null as RTCSessionDescriptionInit | null,
    remoteDescription:
      null as RTCSessionDescriptionInit | null,
    createOffer: vi.fn(async () => ({
      type: "offer" as const,
      sdp: "local-offer",
    })),
    setLocalDescription: vi.fn(
      async (description?: RTCSessionDescriptionInit) => {
        pc.localDescription = description ?? {
          type: "answer",
          sdp: "local-answer",
        };
        pc.signalingState =
          pc.localDescription.type === "offer"
            ? "have-local-offer"
            : "stable";
      },
    ),
    setRemoteDescription: vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        pc.remoteDescription = description;
        pc.signalingState =
          description.type === "offer"
            ? "have-remote-offer"
            : "stable";
      },
    ),
    addIceCandidate: vi.fn(async () => {}),
  };
  return pc;
}

function signal(
  type: "offer" | "answer",
  generation: string,
): ClientSignal {
  return {
    clientId: "remote",
    targetClientId: "local",
    type,
    data: { sdp: `remote-${type}`, generation },
  };
}

function harness(polite: boolean) {
  const sendSignal = vi.fn(async () => {});
  const sender = {
    clientId: "local",
    targetClientId: "remote",
    status: "connected" as SignalingService["status"],
    sendSignal,
  };
  let current = peer();
  let sequence = 0;
  const negotiation = new PeerNegotiationController({
    sender: sender as unknown as SignalingService,
    polite,
    getPeerConnection: () =>
      current as unknown as RTCPeerConnection,
    createGeneration: () => `local-${++sequence}`,
  });
  negotiation.startConnection(
    current as unknown as RTCPeerConnection,
  );
  return {
    negotiation,
    sendSignal,
    sender,
    pc: current,
    replace() {
      current = peer();
      negotiation.reset();
      negotiation.startConnection(
        current as unknown as RTCPeerConnection,
      );
      return current;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "RTCSessionDescription",
    class {
      type: RTCSdpType;
      sdp: string;
      constructor(description: RTCSessionDescriptionInit) {
        this.type = description.type;
        this.sdp = description.sdp ?? "";
      }
    },
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("negotiation recovery races", () => {
  it("uses debug for expected collisions and stale signals, not warnings or errors", async () => {
    const { negotiation, pc, replace } = harness(false);
    const generation = negotiation.generation!;
    pc.signalingState = "have-local-offer";
    await negotiation.enqueueSignal(
      signal("offer", generation),
    );
    replace();
    await negotiation.enqueueSignal(
      signal("answer", generation),
    );

    expect(console.debug).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("preserves warnings for malformed SDP and errors for failed negotiation", async () => {
    const { negotiation, pc } = harness(true);
    await negotiation.enqueueSignal({
      ...signal("offer", "remote-generation"),
      data: { generation: "remote-generation" },
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[PeerNegotiation] invalid offer payload",
      { peerId: "remote" },
    );

    const error = new Error("SDP rejected");
    pc.setRemoteDescription.mockRejectedValueOnce(error);
    await negotiation.enqueueSignal(
      signal("offer", "remote-generation"),
    );
    expect(console.error).toHaveBeenCalledWith(
      "[PeerNegotiation] operation failed",
      expect.objectContaining({
        peerId: "remote",
        operation: "apply remote offer",
        signalingState: "stable",
      }),
      error,
    );
  });

  it("uses debug when a retired SDP operation rejects after replacement", async () => {
    const { negotiation, pc, replace } = harness(true);
    const pending = deferred();
    const error = new Error("Peer connection closed");
    pc.setRemoteDescription.mockImplementationOnce(
      async () => {
        await pending.promise;
        throw error;
      },
    );
    const receiving = negotiation.enqueueSignal(
      signal("offer", "retired-remote"),
    );
    await flush();
    replace();
    pending.resolve();
    await receiving;

    expect(console.debug).toHaveBeenCalledWith(
      "[PeerNegotiation] operation interrupted",
      { peerId: "remote", operation: "apply remote offer" },
      error,
    );
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["connected", "disconnected"] as const)(
    "classifies answer send failures while signaling is %s",
    async (status) => {
      const { negotiation, sender, sendSignal } =
        harness(true);
      const error = new Error("Answer send failed");
      sendSignal.mockImplementationOnce(async () => {
        sender.status = status;
        throw error;
      });
      await negotiation.enqueueSignal(
        signal("offer", "remote-generation"),
      );

      if (status === "disconnected") {
        expect(console.debug).toHaveBeenCalledWith(
          "[PeerNegotiation] operation interrupted",
          { peerId: "remote", operation: "send answer" },
          error,
        );
        expect(console.error).not.toHaveBeenCalled();
      } else {
        expect(console.error).toHaveBeenCalledWith(
          "[PeerNegotiation] operation failed",
          expect.objectContaining({
            peerId: "remote",
            operation: "send answer",
          }),
          error,
        );
      }
    },
  );

  it("does not retire the active generation when rejecting a renegotiation collision", async () => {
    const { negotiation, pc } = harness(false);
    const generation = negotiation.generation!;
    pc.signalingState = "have-local-offer";
    await negotiation.enqueueSignal(
      signal("offer", generation),
    );
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    await negotiation.enqueueSignal(
      signal("answer", generation),
    );
    expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
    expect(pc.signalingState).toBe("stable");
  });

  it("finishes local offer creation before performing polite rollback", async () => {
    const { negotiation, pc, sendSignal } = harness(true);
    const pending = deferred();
    pc.createOffer.mockImplementationOnce(async () => {
      await pending.promise;
      return { type: "offer", sdp: "local-offer" };
    });
    const offering = negotiation.sendOffer(
      pc as unknown as RTCPeerConnection,
    );
    // Keep rejections observed even when an assertion fails before releasing it.
    void offering.catch(() => {});
    await flush();
    const receiving = negotiation.enqueueSignal(
      signal("offer", "remote-generation"),
    );
    try {
      await flush();
      expect(
        pc.setRemoteDescription,
      ).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await Promise.allSettled([offering, receiving]);
    }
    await offering;
    expect(negotiation.generation).toBe(
      "remote-generation",
    );
    expect(pc.signalingState).toBe("stable");
    expect(sendSignal).toHaveBeenCalledTimes(2);
  });

  it("does not block a replacement behind a pending retired SDP operation", async () => {
    const { negotiation, pc, replace } = harness(true);
    const pending = deferred();
    pc.setRemoteDescription.mockImplementationOnce(
      () => pending.promise,
    );
    const retired = negotiation.enqueueSignal(
      signal("offer", "retired-remote"),
    );
    await flush();
    const replacement = replace();
    replacement.signalingState = "have-local-offer";
    const receiving = negotiation.enqueueSignal(
      signal("answer", negotiation.generation!),
    );
    try {
      await flush();
      expect(
        replacement.setRemoteDescription,
      ).toHaveBeenCalledOnce();
    } finally {
      pending.resolve();
      await Promise.all([retired, receiving]);
    }
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
  });
});
