import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { PeerSession } from "@/libs/domain/session";
import type {
  ClientService,
  TransferClient,
} from "@/libs/domain/client";
import type { SignalingService } from "@/libs/domain/signaling";
import { SessionService } from "@/libs/application/session-service";
import { setAppState } from "@/libs/state/app-state";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type {
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "@/libs/domain/signaling";

if (typeof window === "undefined") {
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  };
}

if (typeof document === "undefined") {
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const makeSender = (
  clientId: string,
  targetClientId: string,
): SignalingService =>
  ({
    clientId,
    targetClientId,
    get status() {
      return "connected";
    },
    sendSignal: async () => {},
    addEventListener: ((..._args: any[]) => {}) as any,
    removeEventListener: ((..._args: any[]) => {}) as any,
    close: () => {},
  }) as SignalingService;

// The callback models the browser's implicit offer generation inside SLD,
// not an application createOffer()/setLocalDescription() pair.
const makePeerConnection = (
  makeLocalDescription: () => Promise<RTCSessionDescriptionInit>,
) => {
  const pc = {
    signalingState: "stable" as RTCSignalingState,
    connectionState: "new",
    localDescription:
      null as RTCSessionDescriptionInit | null,
    setLocalDescription: vi.fn(async () => {
      pc.localDescription = await makeLocalDescription();
      pc.signalingState = "have-local-offer";
    }),
    addEventListener: vi.fn(),
    addTransceiver: vi.fn(),
    close: vi.fn(),
    getSenders: () => [],
  };
  return pc as unknown as RTCPeerConnection;
};

const sendOffer = (session: PeerSession): Promise<void> =>
  (session as any).negotiation.sendOffer(
    session.peerConnection,
  );

const attachPeerConnection = (
  session: PeerSession,
  pc: RTCPeerConnection,
) => {
  (session as any).peerConnection = pc;
  return (session as any).negotiation.startConnection(
    pc,
  ) as string;
};

const isMakingOffer = (session: PeerSession) =>
  (session as any).negotiation.isMakingOffer as boolean;

beforeEach(() => {
  setAppState("session", "sessions", reconcile({}));
  setAppState("session", "clientViewData", reconcile({}));
  setAppState(
    "session",
    "clientServiceStatus",
    "disconnected",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PeerSession lifecycle", () => {
  it("waits for an incoming negotiation instead of treating connecting as connected", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const pc = Object.assign(new EventTarget(), {
      connectionState:
        "connecting" as RTCPeerConnectionState,
      signalingState: "stable" as RTCSignalingState,
      getSenders: () => [],
      close: vi.fn(),
    });
    attachPeerConnection(
      session,
      pc as unknown as RTCPeerConnection,
    );
    (session as any).controller = new AbortController();
    (session as any).listenController =
      new AbortController();
    let settled = false;
    const connecting = session.connect().then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      pc.connectionState = "connected";
      pc.dispatchEvent(new Event("connectionstatechange"));
      await connecting;
      expect(settled).toBe(true);
    } finally {
      session.close();
      await connecting.catch(() => {});
    }
  });

  it("does not let a retired offer unlock negotiation on the new connection", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    let rejectOld!: (error: Error) => void;
    let rejectNew!: (error: Error) => void;
    const old = makePeerConnection(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    attachPeerConnection(session, old);
    const oldOffer = sendOffer(session);
    const oldFailure = expect(oldOffer).rejects.toThrow(
      "old offer failed",
    );
    await Promise.resolve();
    const current = makePeerConnection(
      () =>
        new Promise((_resolve, reject) => {
          rejectNew = reject;
        }),
    );
    attachPeerConnection(session, current);
    const newOffer = sendOffer(session);
    const newFailure = expect(newOffer).rejects.toThrow(
      "new offer failed",
    );
    await Promise.resolve();
    rejectOld(new Error("old offer failed"));
    await oldFailure;
    expect(isMakingOffer(session)).toBe(true);
    rejectNew(new Error("new offer failed"));
    await newFailure;
    expect(isMakingOffer(session)).toBe(false);
    session.close();
  });

  it("recovers the first interrupted negotiation when signaling returns", async () => {
    const events =
      new MultiEventEmitter<SignalingServiceEventMap>();
    let status: SignalingServiceStatus = "connected";
    const sender: SignalingService = {
      ...makeSender("local", "remote"),
      get status() {
        return status;
      },
      addEventListener:
        events.addEventListener.bind(events),
      removeEventListener:
        events.removeEventListener.bind(events),
    };
    const pc = Object.assign(new EventTarget(), {
      connectionState: "new",
      signalingState: "stable",
      getSenders: () => [],
      addTransceiver: vi.fn(),
      close: vi.fn(),
    }) as unknown as RTCPeerConnection;
    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(() => pc),
    );
    const session = new PeerSession(sender, {
      polite: false,
    });
    await session.listen();
    const offer = new Promise<RTCSessionDescriptionInit>(
      () => {},
    );
    Object.assign(pc, { setLocalDescription: () => offer });
    vi.spyOn(session, "createChannel").mockImplementation(
      () => new Promise(() => {}),
    );
    const connecting = session.connect();
    const failed = expect(connecting).rejects.toThrow(
      "signaling service is disconnected",
    );
    status = "disconnected";
    events.dispatchEvent("statuschange", status);
    await failed;
    const reconnect = vi
      .spyOn(session, "reconnect")
      .mockImplementation(async () => {
        session.peerConnection = {
          connectionState: "connected",
          close: vi.fn(),
        } as unknown as RTCPeerConnection;
      });
    status = "connected";
    events.dispatchEvent("statuschange", status);
    await vi.waitFor(() =>
      expect(reconnect).toHaveBeenCalledOnce(),
    );
    session.close();
  });

  it("does not let an old failed offer tear down a replacement connection", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    let rejectOffer!: (error: Error) => void;
    const pc = makePeerConnection(
      () =>
        new Promise((_resolve, reject) => {
          rejectOffer = reject;
        }),
    );
    attachPeerConnection(session, pc);
    (session as any).controller = new AbortController();
    (session as any).listenController =
      new AbortController();
    vi.spyOn(session, "createChannel").mockImplementation(
      () => new Promise(() => {}),
    );
    const pending = session.connect();
    await Promise.resolve();
    const replacement = {
      connectionState: "connected",
      close: vi.fn(),
    } as unknown as RTCPeerConnection;
    session.peerConnection = replacement;
    rejectOffer(new Error("retired offer"));
    await expect(pending).rejects.toThrow("retired offer");
    expect(session.peerConnection).toBe(replacement);
    expect(replacement.close).not.toHaveBeenCalled();
    session.close();
  });

  it("resets makingOffer after renegotiation fails", async () => {
    const sender = makeSender("local", "remote");
    const session = new PeerSession(sender, {
      polite: false,
    });
    const createOffer = vi
      .fn<() => Promise<RTCSessionDescriptionInit>>()
      .mockRejectedValueOnce(new Error("offer failed"))
      .mockResolvedValueOnce({
        type: "offer",
        sdp: "offer-sdp",
      });
    const pc = makePeerConnection(createOffer);
    attachPeerConnection(session, pc);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sendOffer(session)).rejects.toThrow(
      "offer failed",
    );

    expect(isMakingOffer(session)).toBe(false);

    await sendOffer(session);

    expect(createOffer).toHaveBeenCalledTimes(2);
    expect(isMakingOffer(session)).toBe(false);
    session.close();
  });

  it("propagates an asynchronous listen failure on reconnect", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const replacement = makePeerConnection(async () => ({
      type: "offer",
      sdp: "offer",
    }));
    vi.stubGlobal(
      "RTCPeerConnection",
      vi.fn(() => replacement),
    );
    const listenError = new Error("listen failed");
    vi.spyOn(session, "listen").mockRejectedValueOnce(
      listenError,
    );
    const connect = vi.spyOn(session, "connect");

    await expect(session.reconnect()).rejects.toBe(
      listenError,
    );

    expect(connect).not.toHaveBeenCalled();
    session.close();
  });

  it.each([false, true])(
    "connects after the offer and peer connection are ready (local channel interrupted=%s)",
    async (interrupted) => {
      const session = new PeerSession(
        makeSender("local", "remote"),
        { polite: false },
      );
      let connectionState: RTCPeerConnectionState = "new";
      let onConnectionStateChange: (() => void) | undefined;
      const close = vi.fn();
      const pc = {
        signalingState: "stable",
        get connectionState() {
          return connectionState;
        },
        createOffer: vi.fn(async () => ({
          type: "offer" as const,
          sdp: "offer-sdp",
        })),
        setLocalDescription: vi.fn(async () => {
          Object.assign(pc, {
            localDescription: {
              type: "offer",
              sdp: "offer-sdp",
            },
          });
          connectionState = "connected";
          onConnectionStateChange?.();
        }),
        addEventListener: vi.fn(
          (type: string, listener: EventListener) => {
            if (type === "connectionstatechange") {
              onConnectionStateChange =
                listener as () => void;
            }
          },
        ),
        close,
        getSenders: () => [],
      } as unknown as RTCPeerConnection;
      attachPeerConnection(session, pc);
      (session as any).controller = new AbortController();
      (session as any).listenController =
        new AbortController();
      vi.spyOn(session, "createChannel").mockImplementation(
        () =>
          interrupted
            ? Promise.reject(
                new Error(
                  "Channel retired during rollback",
                ),
              )
            : Promise.resolve({} as RTCDataChannel),
      );

      await session.connect();

      expect((session as any).status).toBe("connected");
      expect(isMakingOffer(session)).toBe(false);
      session.close();
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("aborts connect while offer creation is pending", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const pc = makePeerConnection(
      () =>
        new Promise<RTCSessionDescriptionInit>(() => {}),
    );
    const controller = new AbortController();
    attachPeerConnection(session, pc);
    (session as any).controller = controller;
    (session as any).listenController =
      new AbortController();
    vi.spyOn(session, "createChannel").mockImplementation(
      () => new Promise<RTCDataChannel>(() => {}),
    );

    const connectPromise = session.connect();
    controller.abort();

    await expect(connectPromise).rejects.toThrow(
      "connect aborted",
    );
    expect(isMakingOffer(session)).toBe(false);
    expect(pc.close).toHaveBeenCalledTimes(1);
    session.close();
  });

  it("restarts recovery when a frozen page resumes without a peer connection", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const close = vi.fn();
    (session as any).peerConnection = {
      connectionState: "connected",
      close,
    } as unknown as RTCPeerConnection;
    (session as any).controller = new AbortController();
    const lifecycle = (session as any).lifecycle;
    lifecycle.markConnectable();
    (session as any).status = "connected";
    const handleDisconnection = vi
      .spyOn(lifecycle, "handleDisconnection")
      .mockResolvedValue(undefined);

    document.dispatchEvent(new Event("freeze"));

    expect(close).toHaveBeenCalledTimes(1);
    expect((session as any).peerConnection).toBeNull();
    expect(lifecycle.isSuspended).toBe(true);

    document.dispatchEvent(new Event("resume"));

    expect(lifecycle.isSuspended).toBe(false);
    expect(handleDisconnection).toHaveBeenCalledWith(
      "resume:resume:missing-peerconnection",
    );
    session.close();
  });

  it("includes the current generation in local offers", async () => {
    const sender = makeSender("local", "remote");
    const sendSignal = vi.spyOn(sender, "sendSignal");
    const session = new PeerSession(sender, {
      polite: false,
    });
    const pc = makePeerConnection(async () => ({
      type: "offer",
      sdp: "offer-sdp",
    }));
    const generation = attachPeerConnection(session, pc);

    await sendOffer(session);

    expect(sendSignal).toHaveBeenCalledTimes(1);
    const sent = sendSignal.mock.calls[0][0];
    expect(JSON.parse(sent.data)).toEqual({
      sdp: "offer-sdp",
      generation,
    });
    session.close();
  });

  it("ignores answers from a retired connection generation", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const setRemoteDescription = vi.fn(async () => {});
    const pc = {
      signalingState: "have-local-offer",
      setRemoteDescription,
      close: vi.fn(),
    } as unknown as RTCPeerConnection;
    const retiredGeneration = attachPeerConnection(
      session,
      pc,
    );
    (session as any).negotiation.startConnection(pc);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await (session as any).negotiation.enqueueSignal({
      type: "answer",
      data: {
        sdp: "stale-answer",
        generation: retiredGeneration,
      },
      clientId: "remote",
      targetClientId: "local",
    });

    expect(setRemoteDescription).not.toHaveBeenCalled();
    session.close();
  });

  it("adopts an offer generation and replays only its candidates", async () => {
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
    vi.stubGlobal(
      "RTCIceCandidate",
      class {
        constructor(readonly init: RTCIceCandidateInit) {}
      },
    );

    const sender = makeSender("local", "remote");
    const sendSignal = vi.spyOn(sender, "sendSignal");
    const session = new PeerSession(sender, {
      polite: true,
    });
    let signalingState: RTCSignalingState = "stable";
    let remoteDescription: RTCSessionDescription | null =
      null;
    let localDescription: RTCSessionDescription | null =
      null;
    const addIceCandidate = vi.fn(async () => {});
    const pc = {
      get signalingState() {
        return signalingState;
      },
      get remoteDescription() {
        return remoteDescription;
      },
      get localDescription() {
        return localDescription;
      },
      setRemoteDescription: vi.fn(
        async (description: RTCSessionDescription) => {
          remoteDescription = description;
          signalingState = "have-remote-offer";
        },
      ),
      setLocalDescription: vi.fn(async () => {
        localDescription = {
          type: "answer",
          sdp: "answer-sdp",
        } as RTCSessionDescription;
        signalingState = "stable";
      }),
      addIceCandidate,
      close: vi.fn(),
    } as unknown as RTCPeerConnection;
    attachPeerConnection(session, pc);

    await (session as any).negotiation.enqueueSignal({
      type: "candidate",
      data: {
        candidate: { candidate: "candidate-a" },
        generation: "remote-generation",
      },
      clientId: "remote",
      targetClientId: "local",
    });
    expect(addIceCandidate).not.toHaveBeenCalled();

    await (session as any).negotiation.enqueueSignal({
      type: "offer",
      data: {
        sdp: "remote-offer",
        generation: "remote-generation",
      },
      clientId: "remote",
      targetClientId: "local",
    });

    expect((session as any).negotiation.generation).toBe(
      "remote-generation",
    );
    expect(addIceCandidate).toHaveBeenCalledTimes(1);
    const answer = sendSignal.mock.calls.find(
      ([signal]) => signal.type === "answer",
    )?.[0];
    expect(JSON.parse(answer?.data)).toEqual({
      sdp: "answer-sdp",
      generation: "remote-generation",
    });

    await (session as any).negotiation.enqueueSignal({
      type: "offer",
      data: { sdp: "legacy-offer" },
      clientId: "remote",
      targetClientId: "local",
    });
    expect((session as any).negotiation.generation).toBe(
      "remote-generation",
    );
    session.close();
  });

  it("cleans up connect state when offer creation fails", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
    );
    const pc = makePeerConnection(() =>
      Promise.reject(new Error("offer failed")),
    );
    attachPeerConnection(session, pc);
    (session as any).controller = new AbortController();
    (session as any).listenController =
      new AbortController();
    vi.spyOn(session, "createChannel").mockImplementation(
      () => new Promise<RTCDataChannel>(() => {}),
    );

    await expect(session.connect()).rejects.toThrow(
      "offer failed",
    );

    expect(isMakingOffer(session)).toBe(false);
    expect(pc.close).toHaveBeenCalledTimes(1);
    session.close();
  });
});

describe("SessionService lifecycle", () => {
  it("assigns opposite negotiation roles even when both clients joined in the same millisecond", async () => {
    const create = async (
      local: string,
      remote: string,
    ) => {
      const service = new SessionService({
        loadIceServers: async () => [],
      });
      service.setClientService({
        info: { clientId: local, createdAt: 1 },
        addEventListener: vi.fn(),
        close: vi.fn(),
        removeSender: vi.fn(),
        createSender: () => makeSender(local, remote),
      } as unknown as ClientService);
      const session = await service.addClient({
        clientId: remote,
        createdAt: 1,
        name: remote,
        avatar: null,
      });
      const role = session.polite;
      session.close();
      service.removeService();
      return role;
    };
    expect(await create("a", "b")).toBe(true);
    expect(await create("b", "a")).toBe(false);
  });

  it("does not resurrect a departed peer while ICE configuration is still loading", async () => {
    let resolveIce!: (value: RTCIceServer[]) => void;
    const service = new SessionService({
      loadIceServers: () =>
        new Promise((resolve) => {
          resolveIce = resolve;
        }),
    });
    const oldSender = makeSender("local", "remote");
    const newSender = makeSender("local", "remote");
    const clientService = {
      info: { clientId: "local", createdAt: 1 },
      addEventListener: vi.fn(),
      close: vi.fn(),
      removeSender: vi.fn(),
      createSender: vi
        .fn()
        .mockReturnValueOnce(oldSender)
        .mockReturnValueOnce(newSender),
    } as unknown as ClientService;
    service.setClientService(clientService);
    const client = {
      clientId: "remote",
      createdAt: 2,
      name: "Remote",
      avatar: null,
    };
    const oldJoin = service.addClient(client);
    const rejected = expect(oldJoin).rejects.toMatchObject({
      name: "AbortError",
    });
    service.removeSession("remote");
    const newJoin = service.addClient({
      ...client,
      createdAt: 3,
    });
    resolveIce([]);
    await rejected;
    const session = await newJoin;
    expect(service.sessions.remote).toBe(session);
    expect(service.clientViewData.remote.createdAt).toBe(3);
    session.close();
    service.removeService();
  });

  it("removes a remotely keyed session when it closes itself", async () => {
    const removeSender = vi.fn();
    const localClient: TransferClient = {
      clientId: "local",
      name: "Local",
      avatar: null,
      createdAt: 1,
    };
    const remoteClient: TransferClient = {
      clientId: "remote",
      name: "Remote",
      avatar: null,
      createdAt: 2,
    };
    const clientService = {
      info: localClient,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createSender: vi.fn(() =>
        makeSender("local", "remote"),
      ),
      removeSender,
      listenForJoin: vi.fn(),
      listenForLeave: vi.fn(),
      createClient: async () => {},
      updateClient: async () => {},
      close: vi.fn(),
    } satisfies ClientService;
    const service = new SessionService({
      loadIceServers: async () => [],
    });
    service.setClientService(clientService);
    const session = await service.addClient(remoteClient);

    expect(service.sessions.remote).toBe(session);

    expect(
      service.updateClientProfile({
        clientId: "remote",
        name: "Updated remote",
        avatar: "data:image/png;base64,avatar",
      }),
    ).toBe(true);
    expect(service.clientViewData.remote).toMatchObject({
      name: "Updated remote",
      avatar: "data:image/png;base64,avatar",
    });

    session.close();

    expect(service.sessions.remote).toBeUndefined();
    expect(service.clientViewData.remote).toBeUndefined();
    expect(removeSender).toHaveBeenCalledTimes(1);
    expect(removeSender).toHaveBeenCalledWith("remote");
    expect(removeSender).not.toHaveBeenCalledWith("local");
    service.removeService();
  });

  it("rejects a session created after its client service was replaced", async () => {
    let resolveIceServers!: (
      servers: RTCIceServer[],
    ) => void;
    const iceServers = new Promise<RTCIceServer[]>(
      (resolve) => {
        resolveIceServers = resolve;
      },
    );
    const sender = makeSender("local", "remote");
    const closeSender = vi
      .spyOn(sender, "close")
      .mockImplementation(() => {});
    const clientService = {
      info: {
        clientId: "local",
        name: "Local",
        avatar: null,
        createdAt: 1,
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createSender: vi.fn(() => sender),
      removeSender: vi.fn(),
      listenForJoin: vi.fn(),
      listenForLeave: vi.fn(),
      createClient: async () => {},
      updateClient: async () => {},
      close: vi.fn(),
    } satisfies ClientService;
    const service = new SessionService({
      loadIceServers: () => iceServers,
    });
    service.setClientService(clientService);

    const pending = service.addClient({
      clientId: "remote",
      name: "Remote",
      avatar: null,
      createdAt: 2,
    });

    service.removeService();
    resolveIceServers([]);

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(closeSender).toHaveBeenCalledTimes(1);
    expect(service.sessions.remote).toBeUndefined();
    expect(service.clientViewData.remote).toBeUndefined();
  });
});
