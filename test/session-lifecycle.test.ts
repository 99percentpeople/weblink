import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { PeerSession } from "@/libs/core/session";
import type {
  ClientService,
  SignalingService,
  TransferClient,
} from "@/libs/core/services/type";
import { SessionService } from "@/libs/services/session-service";
import { setAppState } from "@/libs/state/app-state";

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

const makePeerConnection = (
  createOffer: () => Promise<RTCSessionDescriptionInit>,
) =>
  ({
    signalingState: "stable",
    connectionState: "new",
    createOffer,
    setLocalDescription: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    close: vi.fn(),
    getSenders: () => [],
  }) as unknown as RTCPeerConnection;

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

    await session.renegotiate();

    expect(isMakingOffer(session)).toBe(false);

    await session.renegotiate();

    expect(createOffer).toHaveBeenCalledTimes(2);
    expect(isMakingOffer(session)).toBe(false);
    session.close();
  });

  it("propagates an asynchronous listen failure on reconnect", async () => {
    const session = new PeerSession(
      makeSender("local", "remote"),
      { polite: false },
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

  it("connects after the offer and peer connection are ready", async () => {
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
    vi.spyOn(session, "createChannel").mockResolvedValue(
      {} as RTCDataChannel,
    );

    await session.connect();

    expect((session as any).status).toBe("connected");
    expect(isMakingOffer(session)).toBe(false);
    session.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

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
    (session as any).connectable = true;
    (session as any).status = "connected";
    const handleDisconnection = vi
      .spyOn(session as any, "handleDisconnection")
      .mockResolvedValue(undefined);

    document.dispatchEvent(new Event("freeze"));

    expect(close).toHaveBeenCalledTimes(1);
    expect((session as any).peerConnection).toBeNull();
    expect((session as any).suspended).toBe(true);

    document.dispatchEvent(new Event("resume"));

    expect((session as any).suspended).toBe(false);
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

    await session.renegotiate();

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

    await (session as any).handleSignal({
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

    await (session as any).handleSignal({
      type: "candidate",
      data: {
        candidate: { candidate: "candidate-a" },
        generation: "remote-generation",
      },
      clientId: "remote",
      targetClientId: "local",
    });
    expect(addIceCandidate).not.toHaveBeenCalled();

    await (session as any).handleSignal({
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

    await (session as any).handleSignal({
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
      "Failed to create and send offer: offer failed",
    );

    expect(isMakingOffer(session)).toBe(false);
    expect(pc.close).toHaveBeenCalledTimes(1);
    session.close();
  });
});

describe("SessionService lifecycle", () => {
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
});
