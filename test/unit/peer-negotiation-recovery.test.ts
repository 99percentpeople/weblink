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
    currentRemoteDescription:
      null as RTCSessionDescriptionInit | null,
    createOffer: vi.fn(async () => ({
      type: "offer" as const,
      sdp: "local-offer",
    })),
    setLocalDescription: vi.fn(
      async (description?: RTCSessionDescriptionInit) => {
        const answering =
          pc.signalingState === "have-remote-offer";
        pc.localDescription = description ?? {
          type: answering ? "answer" : "offer",
          sdp: answering ? "local-answer" : "local-offer",
        };
        pc.signalingState =
          pc.localDescription.type === "offer"
            ? "have-local-offer"
            : "stable";
        if (pc.localDescription.type === "answer")
          pc.currentRemoteDescription =
            pc.remoteDescription;
      },
    ),
    setRemoteDescription: vi.fn(
      async (description: RTCSessionDescriptionInit) => {
        pc.remoteDescription = description;
        if (description.type === "answer")
          pc.currentRemoteDescription = description;
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
    replacePeerConnection: () =>
      replace() as unknown as RTCPeerConnection,
  });
  negotiation.startConnection(
    current as unknown as RTCPeerConnection,
  );
  const replace = vi.fn(() => {
    current = peer();
    negotiation.reset();
    negotiation.startConnection(
      current as unknown as RTCPeerConnection,
    );
    return current;
  });
  return {
    negotiation,
    sendSignal,
    sender,
    pc: current,
    replace,
    get current() {
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
  vi.stubGlobal(
    "RTCIceCandidate",
    class {
      constructor(readonly init: RTCIceCandidateInit) {}
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
  it.each([false, true])(
    "accepts an earlier remote offer ahead of a queued local intent (polite=%s)",
    async (polite) => {
      const h = harness(polite);
      const incoming = h.negotiation.enqueueSignal(
        signal("offer", "remote-first"),
      );
      const local = h.negotiation.sendOffer(
        h.pc as unknown as RTCPeerConnection,
      );
      await Promise.all([incoming, local]);
      expect(h.negotiation.generation).toBe("remote-first");
      expect(
        h.pc.setRemoteDescription,
      ).toHaveBeenCalledOnce();
      expect(h.sendSignal).toHaveBeenCalledOnce();
      expect(h.sendSignal).toHaveBeenCalledWith(
        expect.objectContaining({ type: "answer" }),
      );
      expect(h.replace).not.toHaveBeenCalled();
    },
  );

  it("does not replace an established connection for malformed or retired offers", async () => {
    const h = harness(true);
    await h.negotiation.enqueueSignal(
      signal("offer", "first"),
    );
    await h.negotiation.enqueueSignal({
      ...signal("offer", "invalid"),
      data: { generation: "invalid", sdp: null },
    });
    expect(h.replace).not.toHaveBeenCalled();
    await h.negotiation.enqueueSignal(
      signal("offer", "second"),
    );
    await h.negotiation.enqueueSignal(
      signal("offer", "first"),
    );
    expect(h.replace).toHaveBeenCalledOnce();
    expect(h.negotiation.generation).toBe("second");
  });

  it.each([false, true])(
    "replaces an established PC for a remote restart and migrates only its ICE (polite=%s)",
    async (polite) => {
      const h = harness(polite);
      await h.negotiation.enqueueSignal(
        signal("offer", "established"),
      );
      const candidate = (
        generation: string,
        value: string,
      ): ClientSignal => ({
        clientId: "remote",
        targetClientId: "local",
        type: "candidate",
        data: {
          generation,
          candidate: { candidate: value },
        },
      });
      await h.negotiation.enqueueSignal(
        candidate("replacement", "early"),
      );
      await h.negotiation.enqueueSignal(
        candidate("unrelated", "unrelated"),
      );
      // Remote restart must also win over a local renegotiation, including on
      // the impolite side. The new offer is not a same-session collision.
      await h.negotiation.sendOffer(
        h.pc as unknown as RTCPeerConnection,
      );
      const restarting = h.negotiation.enqueueSignal(
        signal("offer", "replacement"),
      );
      const late = h.negotiation.enqueueSignal(
        candidate("replacement", "queued"),
      );
      const stale = h.negotiation.enqueueSignal(
        candidate("established", "stale"),
      );
      await Promise.all([restarting, late, stale]);
      await flush();
      expect(h.replace).toHaveBeenCalledOnce();
      expect(h.negotiation.generation).toBe("replacement");
      expect(
        h.pc.setRemoteDescription,
      ).toHaveBeenCalledOnce();
      expect(
        h.current.setRemoteDescription,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "offer",
          sdp: "remote-offer",
        }),
      );
      expect(h.current.addIceCandidate.mock.calls).toEqual([
        [
          expect.objectContaining({
            init: { candidate: "early" },
          }),
        ],
        [
          expect.objectContaining({
            init: { candidate: "queued" },
          }),
        ],
      ]);
      await h.negotiation.enqueueSignal(
        signal("offer", "established"),
      );
      expect(h.replace).toHaveBeenCalledOnce();
      expect(console.error).not.toHaveBeenCalled();
    },
  );

  it("keeps the same PC for same-generation media renegotiation", async () => {
    const h = harness(true);
    await h.negotiation.enqueueSignal(
      signal("offer", "established"),
    );
    await h.negotiation.enqueueSignal(
      signal("offer", "established"),
    );
    expect(h.pc.setRemoteDescription).toHaveBeenCalledTimes(
      2,
    );
    expect(h.replace).not.toHaveBeenCalled();
  });

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
    const applyLocal =
      pc.setLocalDescription.getMockImplementation()!;
    pc.setLocalDescription.mockImplementationOnce(
      async () => {
        await pending.promise;
        await applyLocal();
      },
    );
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
