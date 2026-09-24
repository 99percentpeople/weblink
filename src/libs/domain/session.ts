import type {
  ClientSignal,
  SignalingService,
} from "./signaling";
import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import type { MessageSendOptions } from "./protocol/errors";
import { PeerNegotiationController } from "./peer-negotiation";
export { handleOffer } from "./peer-negotiation";
import {
  PeerSessionLifecycleController,
  type PeerSessionStatus,
} from "./session-lifecycle";
import { PeerSessionMediaController } from "./session-media";
import { PeerSessionChannelController } from "./session-channels";
import { catchError, catchErrorSync } from "@/libs/catch";
import {
  PEER_SESSION_CONNECTION_TIMEOUT_MS,
  SIGNALING_CONNECTION_TIMEOUT_MS,
} from "@/constants";

export interface PeerSessionRuntimeOptions {
  ordered: boolean;
  preferredVideoCodec: string | null;
  preferredAudioCodec: string | null;
}

const DEFAULT_PEER_SESSION_RUNTIME_OPTIONS: PeerSessionRuntimeOptions =
  {
    ordered: false,
    preferredVideoCodec: null,
    preferredAudioCodec: null,
  };

export interface PeerSessionOptions {
  polite?: boolean;
  iceServers?: RTCIceServer[];
  relayOnly?: boolean;
  getRuntimeOptions?: () => PeerSessionRuntimeOptions;
}

export type PeerSessionEventMap = {
  channel: RTCDataChannel;
  message: SessionMessage;
  error: Error;
  messagechannelchange: "ready" | "closed";
  remotestreamchange: MediaStream | null;
  statuschange: Exclude<PeerSessionStatus, "init">;
  peerconnectioninit: RTCPeerConnection;
};

export class PeerSession {
  private eventEmitter: MultiEventEmitter<PeerSessionEventMap> =
    new MultiEventEmitter();
  peerConnection: RTCPeerConnection | null = null;
  private negotiation: PeerNegotiationController;
  private readonly lifecycle: PeerSessionLifecycleController;
  private readonly media: PeerSessionMediaController;
  private readonly dataChannels: PeerSessionChannelController;
  private sender: SignalingService;
  private controller: AbortController | null = null;
  private iceServers: RTCIceServer[] = [];
  private relayOnly: boolean;
  private signalCache: Array<ClientSignal> = [];
  readonly polite: boolean;
  private status: PeerSessionStatus = "init";
  private listenController: AbortController | null = null;
  private readonly getRuntimeOptions: () => PeerSessionRuntimeOptions;

  constructor(
    sender: SignalingService,
    {
      polite = true,
      iceServers,
      relayOnly = false,
      getRuntimeOptions = () =>
        DEFAULT_PEER_SESSION_RUNTIME_OPTIONS,
    }: PeerSessionOptions = {},
  ) {
    this.sender = sender;
    this.polite = polite;
    this.iceServers = iceServers ?? [];
    this.relayOnly = relayOnly;
    this.getRuntimeOptions = getRuntimeOptions;
    this.negotiation = new PeerNegotiationController({
      sender,
      polite,
      getPeerConnection: () => this.peerConnection,
    });
    this.dataChannels = new PeerSessionChannelController({
      polite,
      getStatus: () => this.status,
      getPeerConnection: () => this.peerConnection,
      getSessionSignal: () => this.controller?.signal,
      ordered: () => this.getRuntimeOptions().ordered,
      createChannel: (label, protocol) =>
        this.createChannel(label, protocol),
      onChannel: (channel) =>
        this.dispatchEvent("channel", channel),
      onMessage: (message) =>
        this.dispatchEvent("message", message),
      onMessageChannelChange: (state) =>
        this.dispatchEvent("messagechannelchange", state),
    });
    this.media = new PeerSessionMediaController({
      targetClientId: () => this.targetClientId,
      getPeerConnection: () => this.peerConnection,
      getCodecOptions: () => {
        const { preferredVideoCodec, preferredAudioCodec } =
          this.getRuntimeOptions();
        return {
          preferredVideoCodec,
          preferredAudioCodec,
        };
      },
      notifyStreamState: () => {
        const message = createSessionMessage(
          this,
          "stream-state",
          { mode: "media" },
        );
        void this.sendMessage(message).catch((error) => {
          console.warn(
            "[PeerSession] stream notification failed",
            error,
          );
        });
      },
      renegotiate: () => this.renegotiate(),
      onRemoteStreamChange: (stream) =>
        this.dispatchEvent("remotestreamchange", stream),
    });
    this.lifecycle = new PeerSessionLifecycleController({
      sender,
      polite,
      clientId: () => this.clientId,
      getStatus: () => this.status,
      setStatus: (status) => this.setStatus(status),
      getPeerConnection: () => this.peerConnection,
      resetSession: () => this.resetSession(),
      disconnect: () => this.disconnect(),
      close: () => this.close(),
      reconnect: (options) => this.reconnect(options),
      updateMessageChannelOpenState: () =>
        this.dataChannels.updateMessageChannelOpenState(),
      isMessageChannelReady: () =>
        this.dataChannels.isMessageChannelReady,
      ensureMessageChannelReady: (reason) =>
        this.dataChannels.ensureMessageChannelReady(reason),
    });
  }

  get clientId() {
    return this.sender.clientId;
  }

  get targetClientId() {
    return this.sender.targetClientId;
  }

  get isMessageChannelReady() {
    return this.dataChannels.isMessageChannelReady;
  }

  addEventListener<K extends keyof PeerSessionEventMap>(
    eventName: K,
    handler: EventHandler<PeerSessionEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      eventName,
      handler.bind(this),
      options,
    );
  }
  removeEventListener<K extends keyof PeerSessionEventMap>(
    eventName: K,
    handler: EventHandler<PeerSessionEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      eventName,
      handler,
      options,
    );
  }

  private dispatchEvent<
    K extends keyof PeerSessionEventMap,
  >(eventName: K, event: PeerSessionEventMap[K]) {
    return this.eventEmitter.dispatchEvent(
      eventName,
      event,
    );
  }

  private setStatus(status: PeerSessionStatus) {
    if (this.status === status) return;
    this.status = status;
    if (status !== "init") {
      this.dispatchEvent("statuschange", status);
    }
  }

  private initializeConnection() {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] can not initialize connection, session ${this.clientId} is closed`,
      );
    }
    if (this.peerConnection) {
      if (
        this.peerConnection.connectionState === "connected"
      ) {
        throw new Error(
          `[PeerSession] can not initialize connection, session ${this.clientId} already connected`,
        );
      }
      this.disconnect();
    }

    console.log(
      `[PeerSession] initialize connection, session ${this.clientId}`,
    );
    if (this.controller) {
      throw new Error(
        `[PeerSession] can not initialize connection, controller already exists`,
      );
    }

    const controller = new AbortController();
    this.controller = controller;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceTransportPolicy: this.relayOnly ? "relay" : "all",
    });
    this.peerConnection = pc;
    this.negotiation.startConnection(pc);

    pc.addEventListener(
      "icecandidate",
      async (ev: RTCPeerConnectionIceEvent) => {
        if (!ev.candidate) return;

        const [err] = await catchError(
          this.negotiation.sendCandidate(
            pc,
            ev.candidate.toJSON(),
          ),
        );
        if (err) {
          console.error(err);
        }
      },
      {
        signal: controller.signal,
      },
    );

    pc.addEventListener(
      "datachannel",
      (event) =>
        this.dataChannels.acceptIncomingChannel(
          event.channel,
        ),
      {
        signal: controller.signal,
      },
    );

    pc.addEventListener(
      "connectionstatechange",
      () => this.lifecycle.handleConnectionStateChange(pc),
      { signal: controller.signal },
    );

    pc.addEventListener(
      "negotiationneeded",
      () => {
        // Room/session recovery drives the first offer. Once an SDP exchange
        // exists, extra local tracks and recovered data channels can require an
        // offer even while ICE/DTLS is still connecting.
        if (pc.localDescription && pc.remoteDescription)
          void this.renegotiate();
      },
      { signal: controller.signal },
    );

    this.media.bindConnection(pc, controller.signal);

    this.dispatchEvent("peerconnectioninit", pc);

    this.popSignalCache();

    return pc;
  }

  private popSignalCache() {
    const cached = this.signalCache.splice(0);
    cached.forEach((signal) => {
      void this.negotiation.enqueueSignal(signal);
    });
  }

  private setupAfterConnectedListeners() {
    const pc = this.peerConnection;
    if (!pc) {
      throw new Error(
        `[PeerSession] peer connection is null, can not set listeners`,
      );
    }
    const controller = this.controller;
    if (!controller) {
      throw new Error(
        `[PeerSession] controller is null, can not set listeners`,
      );
    }

    pc.addEventListener(
      "iceconnectionstatechange",
      async () => {
        const state = pc.iceConnectionState;
        switch (state) {
          case "connected":
          case "completed":
            break;
          case "disconnected":
          case "failed":
            break;
          default:
            break;
        }
      },
      {
        signal: controller.signal,
      },
    );

    pc.addEventListener(
      "signalingstatechange",
      () => {
        console.log(
          `[PeerSession] signalingstatechange, signalingState: ${pc.signalingState}`,
        );
      },
      {
        signal: controller.signal,
      },
    );
  }

  private async waitForPeerConnectionConnected(
    pc: RTCPeerConnection,
    timeoutMs: number,
  ) {
    if (pc.connectionState === "connected") return;
    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `[PeerSession] connect timeout: after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        controller.abort();
      };

      this.controller?.signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(
            new Error(`[PeerSession] connect aborted`),
          );
        },
        { once: true },
      );

      pc.addEventListener(
        "connectionstatechange",
        () => {
          switch (pc.connectionState) {
            case "connected":
              cleanup();
              resolve();
              break;
            case "failed":
            case "closed":
              cleanup();
              reject(
                new Error(
                  `[PeerSession] Connection failed with state: ${pc.connectionState}`,
                ),
              );
              break;
            default:
              break;
          }
        },
        { signal: controller.signal },
      );
    });
  }

  private handleSignal(signal: ClientSignal) {
    return this.negotiation.handleSignal(signal);
  }

  async listen() {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] session ${this.clientId} is closed, can not listen`,
      );
    }
    if (this.sender.status === "closed") {
      throw new Error(
        `[PeerSession] signaling service is closed, can not listen`,
      );
    }
    const [err] = catchErrorSync(() =>
      this.initializeConnection(),
    );
    if (err) {
      throw err;
    }

    const listenController = new AbortController();
    this.listenController = listenController;

    listenController.signal.addEventListener(
      "abort",
      () => {
        if (this.listenController === listenController)
          this.listenController = null;
      },
    );

    this.sender.addEventListener(
      "signal",
      async (ev) => {
        if (this.status === "closed") {
          console.log(
            `[PeerSession] session ${this.clientId} is closed, skip handle signal`,
          );
          listenController.abort();
          return;
        }
        console.log(
          `[PeerSession] client received signal ${ev.detail.type}`,
          ev.detail,
        );
        const pc = this.peerConnection;
        if (!pc) {
          console.log(
            `[PeerSession] peer connection is null, cache signal`,
          );
          this.signalCache.push(ev.detail);
          if (ev.detail.type === "offer") {
            this.lifecycle.handleDisconnection(
              "signal:offer-without-pc",
            );
          }
        } else {
          await this.negotiation.enqueueSignal(ev.detail);
        }
      },
      { signal: listenController.signal },
    );

    this.sender.addEventListener(
      "statuschange",
      (ev) => {
        console.log(
          `[PeerSession] signaling service status change: ${ev.detail}`,
        );
        if (ev.detail === "closed") {
          console.log(
            `[PeerSession] signaling service is closed, abort listen`,
          );
          listenController.abort();
        }
      },
      { signal: listenController.signal },
    );

    const [waitErr] = await catchError(
      this.lifecycle.waitForSignalingConnected(
        listenController.signal,
        SIGNALING_CONNECTION_TIMEOUT_MS,
      ),
    );
    if (waitErr) {
      listenController.abort();
      throw waitErr;
    }
    if (
      listenController.signal.aborted ||
      this.listenController !== listenController
    ) {
      throw new DOMException(
        "Session listen aborted",
        "AbortError",
      );
    }
    this.lifecycle.markListening();
    this.setStatus("created");
  }

  setStream(stream: MediaStream | null) {
    this.media.setStream(stream);
  }

  createChannel(label: string, protocol: string) {
    return this.dataChannels.createChannel(label, protocol);
  }

  sendMessage(
    message: SessionMessage,
    options: MessageSendOptions = {},
  ): Promise<void> {
    return this.dataChannels.sendMessage(message, options);
  }

  async renegotiate() {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] session ${this.clientId} is closed, can not renegotiate`,
      );
    }
    if (!this.peerConnection) {
      console.warn(
        `[PeerSession] renegotiate failed, peer connection is not created`,
      );
      return;
    }

    if (this.peerConnection.signalingState !== "stable") {
      console.warn(
        `[PeerSession] renegotiate failed, signalingState is ${this.peerConnection.signalingState}`,
      );
      return;
    }
    if (this.negotiation.isMakingOffer) {
      console.warn(
        `[PeerSession] session ${this.clientId} already making offer`,
      );
      return;
    }

    const [err] = await catchError(
      this.negotiation.sendOffer(this.peerConnection),
    );
    if (err) {
      console.error(
        `[PeerSession] Error during renegotiation:`,
        err,
      );
    }
  }

  async reconnect(options: { initiate?: boolean } = {}) {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] session ${this.clientId} is closed, can not reconnect`,
      );
    }

    const initiate = options.initiate ?? true;

    console.log(
      `[PeerSession] peer connection ${this.targetClientId} is null, new connection`,
    );
    this.resetSession();
    this.listenController?.abort();
    const [listenError] = await catchError(this.listen());
    if (listenError) throw listenError;

    this.setStatus("reconnecting");
    let err: Error | undefined;
    const pc = this.peerConnection;
    if (!pc) {
      throw new Error(
        `[PeerSession] peer connection is null after listen`,
      );
    }

    if (initiate) {
      [err] = await catchError(this.connect());
      if (err) throw err;
      return;
    }

    [err] = await catchError(
      this.waitForPeerConnectionConnected(
        pc,
        PEER_SESSION_CONNECTION_TIMEOUT_MS,
      ),
    );
    if (err) throw err;

    if (this.peerConnection !== pc) {
      throw new DOMException(
        "Peer connection replaced",
        "AbortError",
      );
    }
    this.setupAfterConnectedListeners();
    this.setStatus("connected");
  }

  async connect() {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] session ${this.clientId} is closed, can not connect`,
      );
    }
    if (!this.listenController) {
      throw new Error(
        `[PeerSession] signaling service is not initialized, can not connect`,
      );
    }
    const pc = this.peerConnection;
    if (!pc) {
      console.warn(
        `[PeerSession] connect failed, peer connection is null`,
      );
      return;
    }

    if (
      ["connected", "connecting"].includes(
        pc.connectionState,
      )
    ) {
      console.warn(
        `[PeerSession] session ${this.clientId} already ${pc.connectionState}`,
      );
      return;
    }

    if (this.negotiation.isMakingOffer) {
      throw new Error(
        `[PeerSession] session ${this.clientId} already making offer`,
      );
    }

    const connectAbortController = new AbortController();

    try {
      const connectionPromise = new Promise<void>(
        (resolve, reject) => {
          const timer = window.setTimeout(() => {
            reject(
              new Error(
                `[PeerSession] connect timeout: after ${PEER_SESSION_CONNECTION_TIMEOUT_MS}ms`,
              ),
            );
          }, PEER_SESSION_CONNECTION_TIMEOUT_MS);

          connectAbortController.signal.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timer);
            },
            { once: true },
          );

          const sessionSignal = this.controller?.signal;
          if (sessionSignal?.aborted) {
            reject(
              new Error(`[PeerSession] connect aborted`),
            );
            return;
          }
          sessionSignal?.addEventListener(
            "abort",
            () => {
              reject(
                new Error(`[PeerSession] connect aborted`),
              );
            },
            {
              once: true,
              signal: connectAbortController.signal,
            },
          );

          this.sender.addEventListener(
            "statuschange",
            (ev) => {
              if (
                ["closed", "disconnected"].includes(
                  ev.detail,
                )
              ) {
                reject(
                  new Error(
                    `[PeerSession] connection failed, signaling service is ${ev.detail}`,
                  ),
                );
              }
            },
            { signal: connectAbortController.signal },
          );

          pc.addEventListener(
            "connectionstatechange",
            () => {
              switch (pc.connectionState) {
                case "connected":
                  console.log(
                    `connection established, session ${this.clientId}, connectable: ${this.lifecycle.isConnectable}`,
                  );
                  this.lifecycle.markConnectable();
                  resolve();
                  break;
                case "failed":
                case "closed":
                case "disconnected":
                  reject(
                    new Error(
                      `[PeerSession] Connection failed with state: ${pc.connectionState}`,
                    ),
                  );
                  break;
                default:
                  break;
              }
            },
            { signal: connectAbortController.signal },
          );
        },
      );

      // Only the impolite peer offers the initial SCTP transport. On a polite
      // rollback, browsers can reject that transport when the two offers use
      // different media-section indices (e.g. screen + camera vs receive-only).
      // The answering side accepts it; a polite-only initiation recovers the
      // channel after connection through ensureMessageChannelReady.
      if (!this.polite)
        void this.createChannel("message", "message").catch(
          (error: unknown) => {
            if (this.peerConnection !== pc) return;
            // Recover a closed channel independently; a data-channel failure
            // must not tear down an otherwise healthy media connection.
            console.warn(
              "[PeerSession] initial message channel interrupted",
              error,
            );
            void this.dataChannels.ensureMessageChannelReady(
              "connect:channel-interrupted",
            );
          },
        );
      const offerPromise = this.negotiation
        .sendOffer(pc)
        .catch((err: unknown) => {
          const message =
            err instanceof Error
              ? err.message
              : String(err);
          throw new Error(
            `[PeerSession] Failed to create and send offer: ${message}`,
          );
        });

      await Promise.all([offerPromise, connectionPromise]);

      if (this.peerConnection !== pc) {
        throw new DOMException(
          "Peer connection replaced",
          "AbortError",
        );
      }
      this.setupAfterConnectedListeners();
      this.setStatus("connected");
    } catch (err) {
      // A resumed signaling channel may already have started a new connection.
      // The retired attempt must not tear down its replacement (or reopen a
      // session that was explicitly closed).
      if (this.peerConnection === pc) this.disconnect();
      throw err;
    } finally {
      connectAbortController.abort();
    }
  }

  private resetSession() {
    this.negotiation.reset();
    this.lifecycle.clearDisconnectionTimer();
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.dataChannels.reset();
    this.media.resetConnection();
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.setStatus("init");
  }

  private disconnect() {
    this.resetSession();
    this.setStatus("disconnected");
  }

  close() {
    this.lifecycle.dispose();
    this.listenController?.abort();
    this.resetSession();
    this.media.dispose();
    this.dataChannels.close();
    this.setStatus("closed");
  }
}
