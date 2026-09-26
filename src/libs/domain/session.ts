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
import {
  PeerSessionLifecycleController,
  type PeerSessionStatus,
} from "./session-lifecycle";
import {
  PeerSessionMediaController,
  type RemoteVideoTrackBinding,
} from "./session-media";
import { PeerSessionChannelController } from "./session-channels";
import { catchError } from "@/libs/catch";
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
  loadIceServers?: () => Promise<RTCIceServer[]>;
  relayOnly?: boolean;
  getRuntimeOptions?: () => PeerSessionRuntimeOptions;
  getVideoSourceKind?: (
    track: MediaStreamTrack,
  ) => "camera" | "screen" | undefined;
}

export type PeerSessionEventMap = {
  channel: RTCDataChannel;
  message: SessionMessage;
  error: Error;
  messagechannelchange: "ready" | "closed";
  remotestreamchange: MediaStream | null;
  remotevideotrackschange: readonly RemoteVideoTrackBinding[];
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
      loadIceServers,
      relayOnly = false,
      getRuntimeOptions = () =>
        DEFAULT_PEER_SESSION_RUNTIME_OPTIONS,
      getVideoSourceKind,
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
      replacePeerConnection: () =>
        this.replaceConnection("remote-restart"),
      prepareConnection: loadIceServers
        ? async (pc) => {
            const servers = await loadIceServers();
            // Credential completion cannot update a replaced/closed connection.
            if (
              pc !== this.peerConnection ||
              this.status === "closed"
            )
              return;
            this.iceServers = servers;
            pc.setConfiguration({
              ...pc.getConfiguration(),
              iceServers: servers,
              iceTransportPolicy: this.relayOnly
                ? "relay"
                : "all",
            });
          }
        : undefined,
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
      getVideoSourceKind,
      notifyStreamState: (videoSources) => {
        const message = createSessionMessage(
          this,
          "stream-state",
          {
            mode: "media",
            videoSources: [...videoSources],
          },
        );
        void this.sendMessage(message).catch((error) => {
          console.warn(
            "[PeerSession] stream notification failed",
            error,
          );
        });
      },
      onRemoteStreamChange: (stream) =>
        this.dispatchEvent("remotestreamchange", stream),
      onRemoteVideoTracksChange: (bindings) =>
        this.dispatchEvent(
          "remotevideotrackschange",
          bindings,
        ),
    });
    this.lifecycle = new PeerSessionLifecycleController({
      sender,
      polite,
      getStatus: () => this.status,
      setStatus: (status) => this.setStatus(status),
      getPeerConnection: () => this.peerConnection,
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
    if (status === "connected") {
      console.info("[PeerSession] connected", {
        clientId: this.clientId,
        peerId: this.targetClientId,
      });
    } else {
      console.debug("[PeerSession] status changed", {
        clientId: this.clientId,
        peerId: this.targetClientId,
        status,
      });
    }
    if (status !== "init") {
      this.dispatchEvent("statuschange", status);
    }
  }

  // The only constructor/replacement entry. Signaling listeners and capture
  // belong to the session; SDP, remote tracks and channels belong to this PC.
  private replaceConnection(
    reason: "initial" | "local-recovery" | "remote-restart",
  ): RTCPeerConnection {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] can not replace connection, session ${this.clientId} is closed`,
      );
    }
    // A valid incoming restart supersedes our single recovery attempt, not
    // its signaling subscription or the other peer sessions.
    if (reason === "remote-restart")
      this.lifecycle.stopRecovery();
    this.resetSession();
    if (reason !== "initial")
      this.setStatus("reconnecting");
    console.debug("[PeerSession] initialize connection", {
      clientId: this.clientId,
      peerId: this.targetClientId,
      reason,
    });

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
          if (
            this.peerConnection !== pc ||
            this.sender.status !== "connected"
          ) {
            console.debug(
              "[PeerSession] ICE send interrupted",
              err,
            );
          } else {
            console.warn(
              "[PeerSession] failed to send ICE candidate",
              { peerId: this.targetClientId },
              err,
            );
          }
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
      () => this.negotiation.handleNegotiationNeeded(pc),
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

  private async waitForPeerConnectionConnected(
    pc: RTCPeerConnection,
    timeoutMs: number,
    attemptSignal: AbortSignal,
  ): Promise<void> {
    const lifetime = this.controller?.signal;
    if (
      pc !== this.peerConnection ||
      lifetime?.aborted ||
      attemptSignal.aborted
    )
      throw new DOMException(
        "[PeerSession] connect aborted",
        "AbortError",
      );
    if (pc.connectionState === "connected") return;
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "closed"
    )
      throw new Error(
        `[PeerSession] Connection failed with state: ${pc.connectionState}`,
      );

    return new Promise<void>((resolve, reject) => {
      const listeners = new AbortController();
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        listeners.abort();
        if (error) reject(error);
        else resolve();
      };
      const timer = window.setTimeout(
        () =>
          finish(
            new Error(
              `[PeerSession] connect timeout: after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      const aborted = () =>
        finish(
          new DOMException(
            "[PeerSession] connect aborted",
            "AbortError",
          ),
        );
      for (const signal of [lifetime, attemptSignal])
        signal?.addEventListener("abort", aborted, {
          once: true,
          signal: listeners.signal,
        });
      this.sender.addEventListener(
        "statuschange",
        ({ detail }) => {
          if (
            detail === "closed" ||
            detail === "disconnected"
          )
            finish(
              new Error(
                `[PeerSession] connection failed, signaling service is ${detail}`,
              ),
            );
        },
        { signal: listeners.signal },
      );
      pc.addEventListener(
        "connectionstatechange",
        () => {
          if (pc.connectionState === "connected") finish();
          else if (
            ["failed", "closed", "disconnected"].includes(
              pc.connectionState,
            )
          )
            finish(
              new Error(
                `[PeerSession] Connection failed with state: ${pc.connectionState}`,
              ),
            );
        },
        { signal: listeners.signal },
      );
    });
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
    if (!this.peerConnection)
      this.replaceConnection("initial");
    // A transport restart must not unsubscribe/re-subscribe the room sender:
    // it can deliver replayed SDP/ICE during this interval.
    const listenController =
      this.listenController ?? this.bindSignaling();
    const connectionSignal = this.controller!.signal;
    await this.lifecycle.waitForSignalingConnected(
      connectionSignal,
      SIGNALING_CONNECTION_TIMEOUT_MS,
    );
    if (
      connectionSignal.aborted ||
      listenController.signal.aborted ||
      this.listenController !== listenController
    ) {
      throw new DOMException(
        "Session listen aborted",
        "AbortError",
      );
    }
    this.lifecycle.markListening();
    if (this.status === "init") this.setStatus("created");
  }

  private bindSignaling(): AbortController {
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
          listenController.abort();
          return;
        }
        console.debug("[PeerSession] received signal", {
          peerId: this.targetClientId,
          type: ev.detail.type,
        });
        const pc = this.peerConnection;
        if (!pc) {
          console.debug(
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
        console.debug(
          "[PeerSession] signaling status changed",
          {
            peerId: this.targetClientId,
            status: ev.detail,
          },
        );
        if (ev.detail === "closed") {
          listenController.abort();
        }
      },
      { signal: listenController.signal },
    );

    return listenController;
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

  async reconnect(options: { initiate?: boolean } = {}) {
    const pc = this.replaceConnection("local-recovery");
    try {
      await this.listen();
      await this.establishConnection(
        pc,
        options.initiate ?? true,
      );
    } catch (error) {
      if (this.peerConnection === pc) this.disconnect();
      throw error;
    }
  }

  async connect() {
    if (
      this.status === "closed" ||
      !this.listenController
    ) {
      throw new Error(
        "[PeerSession] signaling service is not initialized or session is closed",
      );
    }
    const pc = this.peerConnection;
    if (!pc)
      throw new Error(
        "[PeerSession] peer connection is unavailable",
      );
    await this.establishConnection(pc, true);
  }

  private async establishConnection(
    pc: RTCPeerConnection,
    initiate: boolean,
  ): Promise<void> {
    if (pc !== this.peerConnection)
      throw new DOMException(
        "Peer connection replaced",
        "AbortError",
      );
    if (pc.connectionState === "connected") return;

    const attempt = new AbortController();
    try {
      const connected = this.waitForPeerConnectionConnected(
        pc,
        PEER_SESSION_CONNECTION_TIMEOUT_MS,
        attempt.signal,
      );
      let offering: Promise<void> = Promise.resolve();
      // Initial connect/recovery explicitly bootstraps the same offer driver
      // used by negotiationneeded. An incoming negotiation already connecting
      // must be awaited, not mistaken for a successful connection.
      if (initiate && pc.connectionState !== "connecting") {
        // Only the impolite peer initially creates SCTP. Keep this existing
        // constraint: simultaneous offers with different m-line layouts can
        // otherwise reject a polite peer's data channel on rollback.
        if (!this.polite)
          void this.createChannel(
            "message",
            "message",
          ).catch((error: unknown) => {
            if (this.peerConnection !== pc) return;
            console.debug(
              "[PeerSession] initial message channel interrupted",
              error,
            );
            void this.dataChannels.ensureMessageChannelReady(
              "connect:channel-interrupted",
            );
          });
        offering = this.negotiation.sendOffer(pc);
      }
      await Promise.all([offering, connected]);
      if (pc !== this.peerConnection)
        throw new DOMException(
          "Peer connection replaced",
          "AbortError",
        );
      this.lifecycle.markConnectable();
      this.setStatus("connected");
    } catch (error) {
      // A retired operation can fail after its replacement has already started.
      if (this.peerConnection === pc) this.disconnect();
      throw error;
    } finally {
      attempt.abort();
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
