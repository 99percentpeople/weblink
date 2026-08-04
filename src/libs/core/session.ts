import {
  ClientSignal,
  SignalingService,
} from "./services/type";
import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import {
  type SessionMessage,
  type StreamStateMessage,
} from "@/libs/services/rtc-protocol";
import { waitChannel } from "./utils/channel";
import { catchError, catchErrorSync } from "../catch";
import { appState } from "@/libs/state/app-state";
import {
  PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS,
  PEER_SESSION_AUTO_RECONNECT_MAX_DELAY_MS,
  PEER_SESSION_CONNECTION_TIMEOUT_MS,
  PEER_SESSION_DISCONNECTED_GRACE_MS,
  SIGNALING_CONNECTION_TIMEOUT_MS,
} from "@/constants";

export interface PeerSessionOptions {
  polite?: boolean;
  iceServers?: RTCIceServer[];
  relayOnly?: boolean;
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

type PeerSessionStatus =
  | "created"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "closed"
  | "init";

export class PeerSession {
  private eventEmitter: MultiEventEmitter<PeerSessionEventMap> =
    new MultiEventEmitter();
  peerConnection: RTCPeerConnection | null = null;
  private makingOffer: boolean = false;
  private ignoreOffer: boolean = false;
  private connectable: boolean = false;
  private sender: SignalingService;
  private controller: AbortController | null = null;
  private lifecycleController: AbortController;
  private channels: RTCDataChannel[] = [];
  private messageChannel: RTCDataChannel | null = null;
  private messageChannelOpen = false;
  private messageChannelSetups =
    new WeakSet<RTCDataChannel>();
  private outgoingQueue: SessionMessage[] = [];
  private outgoingQueueKeys = new Set<string>();
  private ensureMessageChannelPromise: Promise<void> | null =
    null;
  private iceServers: RTCIceServer[] = [];
  private relayOnly: boolean;
  private signalCache: Array<ClientSignal> = [];
  readonly polite: boolean;
  private localStream: MediaStream | null = null;
  private lastLocalStreamState:
    | StreamStateMessage["mode"]
    | null = null;
  private remoteStream: MediaStream | null = null;
  private status: PeerSessionStatus = "init";
  private listenController: AbortController | null = null;
  private autoReconnectController: AbortController | null =
    null;
  private disconnectionTimer: number | null = null;

  private applyPreferredCodecPreferences(
    pc: RTCPeerConnection,
  ) {
    if (typeof RTCRtpSender === "undefined") return;
    if (!("getCapabilities" in RTCRtpSender)) return;

    const orderCodecs = (
      codecs: any[],
      preferredMimeType: string,
    ) => {
      if (!preferredMimeType) return codecs;

      const normalizedPreferred = preferredMimeType
        .trim()
        .toLowerCase();
      const preferred = codecs.filter(
        (c) =>
          c.mimeType.trim().toLowerCase() ===
          normalizedPreferred,
      );
      if (preferred.length === 0) return codecs;

      const preferredPayloadTypes = new Set<number>();
      preferred.forEach((c) => {
        const pt = c.preferredPayloadType;
        if (typeof pt === "number")
          preferredPayloadTypes.add(pt);
      });
      const rtxForPreferred = codecs.filter((c) => {
        if (c.mimeType.trim().toLowerCase() !== "video/rtx")
          return false;
        const fmtp = c.sdpFmtpLine;
        if (!fmtp) return false;
        const match = fmtp.match(/\bapt=(\d+)\b/);
        if (!match) return false;
        const apt = Number(match[1]);
        if (Number.isNaN(apt)) return false;
        return preferredPayloadTypes.has(apt);
      });

      const preferredSet = new Set(preferred);
      const rtxSet = new Set(rtxForPreferred);
      const rest = codecs.filter(
        (c) => !preferredSet.has(c) && !rtxSet.has(c),
      );
      return [...preferred, ...rtxForPreferred, ...rest];
    };

    const applyForKind = (
      kind: "audio" | "video",
      preferredMimeType: string,
    ) => {
      if (!preferredMimeType) return;
      const capabilities =
        RTCRtpSender.getCapabilities(kind);
      const codecs = capabilities?.codecs;
      if (!codecs || codecs.length === 0) return;

      const ordered = orderCodecs(
        codecs,
        preferredMimeType,
      );
      pc.getTransceivers().forEach((transceiver) => {
        const transceiverKind =
          transceiver.sender.track?.kind ??
          transceiver.receiver.track?.kind;
        if (transceiverKind !== kind) return;
        if (!("setCodecPreferences" in transceiver)) return;
        try {
          transceiver.setCodecPreferences(ordered);
        } catch (e) {
          console.warn(
            `[PeerSession] setCodecPreferences failed for ${kind}:`,
            e,
          );
        }
      });
    };

    applyForKind(
      "video",
      appState.options.preferredVideoCodec ?? "",
    );
    applyForKind(
      "audio",
      appState.options.preferredAudioCodec ?? "",
    );
  }
  constructor(
    sender: SignalingService,
    {
      polite = true,
      iceServers,
      relayOnly = false,
    }: PeerSessionOptions = {},
  ) {
    this.sender = sender;
    this.polite = polite;
    this.iceServers = iceServers ?? [];
    this.relayOnly = relayOnly;

    this.lifecycleController = new AbortController();
    const { signal } = this.lifecycleController;

    window.addEventListener(
      "beforeunload",
      () => {
        this.close();
      },
      { signal },
    );

    document.addEventListener(
      "resume",
      () => {
        this.onLifecycleResume("resume");
      },
      { signal },
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible") return;
        this.onLifecycleResume("visibilitychange");
      },
      { signal },
    );

    window.addEventListener(
      "pageshow",
      () => {
        this.onLifecycleResume("pageshow");
      },
      { signal },
    );

    window.addEventListener(
      "focus",
      () => {
        this.onLifecycleResume("focus");
      },
      { signal },
    );

    window.addEventListener(
      "online",
      () => {
        this.onLifecycleResume("online");
      },
      { signal },
    );

    document.addEventListener(
      "freeze",
      () => {
        this.stopAutoReconnect();
        this.disconnect();
      },
      { signal },
    );
  }

  get clientId() {
    return this.sender.clientId;
  }

  get targetClientId() {
    return this.sender.targetClientId;
  }

  get isMessageChannelReady() {
    return this.messageChannelOpen;
  }

  private onLifecycleResume(reason: string) {
    if (this.status === "closed") return;
    if (!this.connectable) return;

    const pc = this.peerConnection;
    if (!pc) return;

    this.updateMessageChannelOpenState();

    if (pc.connectionState !== "connected") {
      this.handleDisconnection(`resume:${reason}`);
      return;
    }
    if (
      pc.iceConnectionState === "disconnected" ||
      pc.iceConnectionState === "failed"
    ) {
      this.handleDisconnection(
        `resume:${reason}:ice-${pc.iceConnectionState}`,
      );
      return;
    }

    if (this.messageChannelOpen) return;
    void this.ensureMessageChannelReady(
      `resume:${reason}`,
    ).then(() => {
      if (this.status === "closed") return;
      if (
        this.peerConnection?.connectionState !== "connected"
      ) {
        return;
      }
      if (this.messageChannelOpen) return;
      this.handleDisconnection(
        `resume:${reason}:messagechannel-not-ready`,
      );
    });
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

  private createMessageId() {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private notifyLocalStreamState(
    stream: MediaStream | null,
  ) {
    if (!stream) {
      this.lastLocalStreamState = null;
      return;
    }
    const mode: StreamStateMessage["mode"] = "media";
    if (this.lastLocalStreamState === mode) return;
    this.lastLocalStreamState = mode;

    const message = {
      type: "stream-state",
      mode,
      id: this.createMessageId(),
      createdAt: Date.now(),
      client: this.clientId,
      target: this.targetClientId,
    } satisfies StreamStateMessage;

    this.sendMessage(message);
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

    pc.addEventListener(
      "icecandidate",
      async (ev: RTCPeerConnectionIceEvent) => {
        if (!ev.candidate) return;

        const [err] = await catchError(
          this.sender.sendSignal({
            type: "candidate",
            data: JSON.stringify({
              candidate: ev.candidate.toJSON(),
            }),
          }),
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
      (ev) => {
        this.channels.push(ev.channel);

        ev.channel.addEventListener(
          "close",
          () => {
            const index = this.channels.findIndex(
              (c) => c.id === ev.channel.id,
            );
            if (index !== -1) {
              this.channels.splice(index, 1);
            }
          },
          { once: true },
        );

        if (ev.channel.protocol === "message") {
          this.setupMessageChannel(ev.channel);
        }

        this.dispatchEvent("channel", ev.channel);
      },
      {
        signal: controller.signal,
      },
    );

    pc.addEventListener(
      "connectionstatechange",
      () => {
        switch (pc.connectionState) {
          case "new":
            break;
          case "connecting":
            this.setStatus("connecting");
            break;
          case "connected":
            if (this.disconnectionTimer !== null) {
              window.clearTimeout(this.disconnectionTimer);
              this.disconnectionTimer = null;
            }
            this.connectable = true;
            this.setStatus("connected");
            void this.ensureMessageChannelReady(
              "connectionstatechange:connected",
            );
            break;
          case "disconnected": {
            if (this.disconnectionTimer !== null) return;
            this.disconnectionTimer = window.setTimeout(
              () => {
                this.disconnectionTimer = null;
                if (pc.connectionState !== "disconnected")
                  return;
                this.handleDisconnection(
                  "connectionstatechange:disconnected",
                );
              },
              PEER_SESSION_DISCONNECTED_GRACE_MS,
            );
            break;
          }
          case "failed":
          case "closed":
            this.handleDisconnection(
              `connectionstatechange:${pc.connectionState}`,
            );
            break;
          default:
            break;
        }
      },
      { signal: controller.signal },
    );

    pc.addEventListener(
      "track",
      (ev) => {
        const stream = ev.streams.at(0);
        if (!stream) {
          console.warn(
            `[PeerSession] client ${this.targetClientId} add track ${ev.track.id} stream is null`,
          );
          return;
        }

        console.log(
          `[PeerSession] client ${this.targetClientId} add track ${ev.track.id} stream ${stream.id}`,
        );

        const receiver = ev.receiver;

        if ("jitterBufferTarget" in receiver)
          receiver.jitterBufferTarget = 0;
        if ("playoutDelayHint" in receiver)
          receiver.playoutDelayHint = 0;

        const track = ev.track;
        track.addEventListener(
          "ended",
          () => {
            if (this.remoteStream) {
              this.remoteStream.removeTrack(track);
              this.dispatchEvent(
                "remotestreamchange",
                this.remoteStream,
              );
            }
          },
          { once: true },
        );

        if (this.remoteStream) {
          // if the stream is the same, add the track to the remote stream
          if (stream.id === this.remoteStream.id) {
            this.remoteStream.addTrack(track);
            this.dispatchEvent(
              "remotestreamchange",
              this.remoteStream,
            );
            return;
          }
          // if the stream is different, remove the old stream
          const remoteStream = this.remoteStream;
          remoteStream.getTracks().forEach((t) => {
            remoteStream.removeTrack(t);
            t.stop();
          });

          this.remoteStream = null;
        }
        stream.addEventListener(
          "removetrack",
          (ev) => {
            console.log(
              `[PeerSession] client ${this.targetClientId} removetrack`,
              ev.track.id,
            );
            if (stream.getTracks().length === 0) {
              this.remoteStream = null;
            }
            this.dispatchEvent(
              "remotestreamchange",
              this.remoteStream,
            );
          },
          { signal: controller.signal },
        );

        // set the new stream
        this.remoteStream = stream;
        this.dispatchEvent("remotestreamchange", stream);
      },
      { signal: controller.signal },
    );

    if (this.localStream) {
      const stream = this.localStream;
      this.notifyLocalStreamState(stream);
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });
    } else {
      pc.addTransceiver("video", {
        direction: "recvonly",
      });
      pc.addTransceiver("audio", {
        direction: "recvonly",
      });
    }

    this.applyPreferredCodecPreferences(pc);
    this.dispatchEvent("peerconnectioninit", pc);

    this.popSignalCache();

    return pc;
  }

  private popSignalCache() {
    let queue = Promise.resolve();
    function enqueueTask(task: () => Promise<void>) {
      queue = queue.then(() => task());
    }
    for (const signal of this.signalCache) {
      enqueueTask(() => this.handleSignal(signal));
    }
    this.signalCache.length = 0;
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

    pc.addEventListener(
      "negotiationneeded",
      async () => {
        console.log(
          `[PeerSession] client ${this.clientId} onNegotiationneeded`,
        );

        await this.renegotiate();
      },
      { signal: controller.signal },
    );
  }

  private updateMessageChannelOpenState() {
    const isOpen = this.channels.some(
      (channel) =>
        channel.protocol === "message" &&
        channel.readyState === "open",
    );
    if (this.messageChannelOpen === isOpen) return;
    this.messageChannelOpen = isOpen;
    this.dispatchEvent(
      "messagechannelchange",
      isOpen ? "ready" : "closed",
    );
  }

  private getOpenMessageChannel(): RTCDataChannel | null {
    if (this.messageChannel?.readyState === "open") {
      return this.messageChannel;
    }
    const open = this.channels.find(
      (channel) =>
        channel.protocol === "message" &&
        channel.readyState === "open",
    );
    if (open) this.messageChannel = open;
    return open ?? null;
  }

  private hasConnectingMessageChannel() {
    return this.channels.some(
      (channel) =>
        channel.protocol === "message" &&
        channel.readyState === "connecting",
    );
  }

  private makeOutgoingKey(message: SessionMessage) {
    return `${message.type}:${message.id}`;
  }

  private queueOutgoingMessage(message: SessionMessage) {
    const key = this.makeOutgoingKey(message);
    if (this.outgoingQueueKeys.has(key)) return;
    this.outgoingQueueKeys.add(key);
    this.outgoingQueue.push(message);
  }

  private flushOutgoingQueue() {
    const channel = this.getOpenMessageChannel();
    if (!channel) return;
    while (this.outgoingQueue.length > 0) {
      const message = this.outgoingQueue[0];
      if (!message) break;

      const key = this.makeOutgoingKey(message);
      try {
        channel.send(JSON.stringify(message));
        this.outgoingQueue.shift();
        this.outgoingQueueKeys.delete(key);
      } catch (err) {
        console.error(
          `[PeerSession] failed to flush outgoing queue`,
          err,
        );
        break;
      }
    }
  }

  private waitForMessageChannelReady(
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    if (this.getOpenMessageChannel())
      return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `[PeerSession] wait message channel timeout: after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        controller.abort();
      };

      if (signal.aborted) {
        cleanup();
        reject(new Error(`[PeerSession] aborted`));
        return;
      }

      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(new Error(`[PeerSession] aborted`));
        },
        { once: true },
      );

      this.addEventListener(
        "messagechannelchange",
        (ev) => {
          if (ev.detail !== "ready") return;
          cleanup();
          resolve();
        },
        { signal: controller.signal },
      );
    });
  }

  private ensureMessageChannelReady(reason: string) {
    if (this.ensureMessageChannelPromise) {
      return this.ensureMessageChannelPromise;
    }

    const pc = this.peerConnection;
    const controller = this.controller;
    if (!pc || !controller) return Promise.resolve();

    this.ensureMessageChannelPromise = (async () => {
      try {
        if (this.status === "closed") return;
        if (pc.connectionState !== "connected") return;

        if (this.getOpenMessageChannel()) {
          this.flushOutgoingQueue();
          return;
        }

        if (
          this.hasConnectingMessageChannel() ||
          this.messageChannel
        ) {
          const [waitErr] = await catchError(
            this.waitForMessageChannelReady(
              controller.signal,
              3500,
            ),
          );
          if (!waitErr) {
            this.flushOutgoingQueue();
            return;
          }
        } else if (this.polite) {
          const [waitErr] = await catchError(
            this.waitForMessageChannelReady(
              controller.signal,
              5000,
            ),
          );
          if (!waitErr) {
            this.flushOutgoingQueue();
            return;
          }
        }

        const [createErr] = await catchError(
          this.createChannel("message", "message"),
        );
        if (createErr) {
          console.warn(
            `[PeerSession] ensure message channel failed (${reason})`,
            createErr,
          );
          return;
        }
        this.flushOutgoingQueue();
      } finally {
        this.ensureMessageChannelPromise = null;
      }
    })();

    return this.ensureMessageChannelPromise;
  }

  private async waitForSignalingConnected(
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    if (this.sender.status === "connected") return;
    if (this.sender.status === "closed") {
      throw new Error(
        `[PeerSession] signaling service is closed`,
      );
    }
    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `[PeerSession] wait signaling connected timeout: after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        controller.abort();
      };

      signal.addEventListener(
        "abort",
        () => {
          cleanup();
          reject(new Error(`[PeerSession] aborted`));
        },
        { once: true },
      );

      this.sender.addEventListener(
        "statuschange",
        (ev) => {
          if (ev.detail === "connected") {
            cleanup();
            resolve();
            return;
          }
          if (ev.detail === "closed") {
            cleanup();
            reject(
              new Error(
                `[PeerSession] signaling service is closed`,
              ),
            );
          }
        },
        { signal: controller.signal },
      );
    });
  }

  private async delay(ms: number, signal: AbortSignal) {
    if (ms <= 0) return;
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
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

  private getAutoReconnectDelayMs(attempt: number) {
    const base = 500;
    const exp = Math.round(base * Math.pow(1.7, attempt));
    const capped = Math.min(
      PEER_SESSION_AUTO_RECONNECT_MAX_DELAY_MS,
      exp,
    );
    const jitter = Math.round(Math.random() * 250);
    return capped + jitter;
  }

  private stopAutoReconnect() {
    this.autoReconnectController?.abort();
    this.autoReconnectController = null;
  }

  private async handleDisconnection(
    reason: string = "unknown",
  ) {
    if (this.status === "closed") {
      console.warn(
        `[PeerSession] session ${this.clientId} is closed, skip handle disconnection`,
      );
      return;
    }
    if (this.autoReconnectController) {
      console.log(
        `[PeerSession] auto reconnect already running, skip: ${reason}`,
      );
      return;
    }
    if (!this.connectable) {
      console.warn(
        `[PeerSession] session ${this.clientId} is not connectable, disconnect`,
      );
      this.disconnect();
      return;
    }

    const controller = new AbortController();
    this.autoReconnectController = controller;

    if (this.disconnectionTimer !== null) {
      window.clearTimeout(this.disconnectionTimer);
      this.disconnectionTimer = null;
    }

    this.resetSession();
    this.setStatus("reconnecting");

    let attempts = 0;

    while (
      !controller.signal.aborted &&
      attempts < PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS
    ) {
      if (this.sender.status === "closed") {
        console.warn(
          `[PeerSession] signaling service is closed, stop reconnect`,
        );
        this.close();
        return;
      }
      const initiate = !this.polite || attempts > 0;
      console.log(
        `[PeerSession] auto reconnect attempt ${attempts + 1}/${PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS} (initiate=${initiate})`,
      );

      if (this.sender.status !== "connected") {
        const [signalError] = await catchError(
          this.waitForSignalingConnected(
            controller.signal,
            SIGNALING_CONNECTION_TIMEOUT_MS,
          ),
        );
        if (signalError) {
          console.warn(
            `[PeerSession] wait signaling connected failed: ${signalError.message}`,
          );
        }
      }

      const [err] = await catchError(
        this.reconnect({ initiate }),
      );
      if (!err) {
        console.log(
          `[PeerSession] auto reconnect success, session ${this.clientId}`,
        );
        break;
      }
      attempts++;
      console.error(
        `[PeerSession] auto reconnect attempt ${attempts} failed:`,
        err,
      );
      if (
        attempts >= PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS
      )
        break;
      await this.delay(
        this.getAutoReconnectDelayMs(attempts),
        controller.signal,
      );
    }

    this.autoReconnectController = null;

    if (
      this.peerConnection?.connectionState !== "connected"
    ) {
      console.error(
        `[PeerSession] auto reconnect failed, reach max attempts`,
      );
      this.disconnect();
    }
  }

  private pendingRemoteCandidates: RTCIceCandidateInit[] =
    [];

  private async flushPendingRemoteCandidates(
    pc: RTCPeerConnection,
  ) {
    if (!pc.remoteDescription) return;
    if (this.pendingRemoteCandidates.length === 0) return;

    const pending = this.pendingRemoteCandidates;
    this.pendingRemoteCandidates = [];

    for (const candidateInit of pending) {
      const candidate = new RTCIceCandidate(candidateInit);
      const [err] = await catchError(
        pc.addIceCandidate(candidate),
      );
      if (err && !this.ignoreOffer) {
        console.error(
          `[PeerSession] addIceCandidate error: `,
          err,
        );
      }
    }
  }

  private async handleSignal(signal: ClientSignal) {
    const pc = this.peerConnection;
    if (!pc) {
      console.log(
        `[PeerSession] peer connection is null, skip handle signal`,
      );
      return;
    }
    let err: Error | undefined;
    if (signal.type === "offer") {
      const offerCollision =
        this.makingOffer || pc.signalingState !== "stable";
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        console.warn(
          `[PeerSession] Offer ignored due to collision, signalingState: ${pc.signalingState}`,
        );
        return;
      }
      if (offerCollision) {
        const [rollbackError] = await catchError(
          pc.setLocalDescription({ type: "rollback" }),
        );
        if (rollbackError) {
          console.warn(
            `[PeerSession] rollback failed, signalingState: ${pc.signalingState}`,
            rollbackError,
          );
        }
      }

      [err] = await catchError(
        pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "offer",
            sdp: signal.data.sdp,
          }),
        ),
      );

      if (err) {
        console.error(
          `[PeerSession] setRemoteDescription error: `,
          err,
        );
        return;
      }

      await this.flushPendingRemoteCandidates(pc);

      [err] = await catchError(pc.setLocalDescription());

      if (err) {
        console.error(
          `[PeerSession] setLocalDescription error: `,
          err,
        );
        return;
      }

      if (!pc.localDescription) {
        console.warn(
          `[PeerSession] localDescription is null, signalingState: ${pc.signalingState}`,
        );
        return;
      }

      [err] = await catchError(
        this.sender.sendSignal({
          type: pc.localDescription.type,
          data: JSON.stringify({
            sdp: pc.localDescription.sdp,
          }),
        }),
      );

      if (err) {
        console.error(
          `[PeerSession] sendSignal error: `,
          err,
        );
        return;
      }
    } else if (signal.type === "answer") {
      if (pc.signalingState !== "have-local-offer") {
        console.warn(
          `[PeerSession] answer ignored due to signalingState is ${pc.signalingState}`,
        );
        return;
      }

      [err] = await catchError(
        pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "answer",
            sdp: signal.data.sdp,
          }),
        ),
      );

      if (err) {
        console.error(
          `[PeerSession] setRemoteDescription error: `,
          err,
        );
        return;
      }

      await this.flushPendingRemoteCandidates(pc);
    } else if (signal.type === "candidate") {
      // Candidates may arrive before remote description,
      // buffer and replay after setRemoteDescription.
      if (!pc.remoteDescription) {
        this.pendingRemoteCandidates.push(
          signal.data.candidate as RTCIceCandidateInit,
        );
        return;
      }

      const candidate = new RTCIceCandidate(
        signal.data.candidate as RTCIceCandidateInit,
      );
      [err] = await catchError(
        pc.addIceCandidate(candidate),
      );

      if (err) {
        if (!this.ignoreOffer) {
          console.error(
            `[PeerSession] addIceCandidate error: `,
            err,
          );
        }
      }
    }
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
            this.handleDisconnection(
              "signal:offer-without-pc",
            );
          }
        } else {
          await this.handleSignal(ev.detail);
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
      this.waitForSignalingConnected(
        listenController.signal,
        SIGNALING_CONNECTION_TIMEOUT_MS,
      ),
    );
    if (waitErr) {
      listenController.abort();
      throw waitErr;
    }
    this.setStatus("created");
  }

  private removeStream() {
    console.log(
      `[PeerSession] client ${this.targetClientId} removeStream`,
    );
    const localStream = this.localStream;
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        localStream.removeTrack(track);
        track.stop();
      });
      this.localStream = null;
    }
    const pc = this.peerConnection;
    if (!pc) {
      console.log(
        `[PeerSession] client ${this.targetClientId} peer connection is null, skip remove stream`,
      );
      return;
    }
    pc.getSenders().forEach((sender) => {
      if (sender.track) {
        pc.removeTrack(sender);
      }
    });
    this.renegotiate();
  }

  setStream(stream: MediaStream | null) {
    console.log(
      `[PeerSession] client ${this.targetClientId} setStream`,
      stream,
    );
    if (!stream) {
      this.removeStream();
      this.notifyLocalStreamState(null);
      return;
    }

    if (this.localStream) {
      if (this.localStream.id === stream.id) {
        console.log(
          `[PeerSession] client ${this.targetClientId} stream is same, skip setStream`,
        );
        return;
      }

      this.removeStream();
    }

    this.localStream = stream;
    this.notifyLocalStreamState(stream);

    let senders: RTCRtpSender[] = [];

    stream.addEventListener("addtrack", (ev) => {
      const sender = this.peerConnection?.addTrack(
        ev.track,
        stream,
      );
      if (sender) {
        senders.push(sender);
      }
    });

    stream.addEventListener("removetrack", (ev) => {
      const index = senders.findIndex(
        (sender) => sender.track?.id === ev.track.id,
      );
      if (index === -1) return;
      const [sender] = senders.splice(index, 1);
      if (!sender || !this.peerConnection) return;
      this.peerConnection.removeTrack(sender);
    });

    const pc = this.peerConnection;
    if (!pc) {
      console.log(
        `[PeerSession] client ${this.targetClientId} peer connection is null, skip add track`,
      );
      return;
    }

    senders.push(
      ...stream.getTracks().map((track) => {
        track.addEventListener("ended", () => {
          console.log(
            `[PeerSession] track ended, remove track from peer connection`,
            track.id,
          );
          const index = senders.findIndex(
            (sender) => sender.track?.id === track.id,
          );
          if (index !== -1) {
            pc.removeTrack(senders[index]);
            senders.splice(index, 1);
          }
        });
        console.log(
          `[PeerSession] client ${this.targetClientId} add track`,
          track.id,
        );
        return pc.addTrack(track, stream);
      }),
    );

    this.applyPreferredCodecPreferences(pc);

    this.renegotiate();
  }

  async createChannel(label: string, protocol: string) {
    if (!this.peerConnection) {
      throw new Error(
        `[PeerSession] failed to create channel, peer connection is null`,
      );
    }

    const matches = this.channels.filter(
      (channel) =>
        channel.label === label &&
        channel.protocol === protocol,
    );

    const preferred =
      protocol === "message" &&
      this.messageChannel &&
      this.messageChannel.label === label &&
      this.messageChannel.protocol === protocol &&
      !["closing", "closed"].includes(
        this.messageChannel.readyState,
      )
        ? this.messageChannel
        : null;

    if (preferred?.readyState === "open") {
      return preferred;
    }

    if (preferred?.readyState === "connecting") {
      const [waitErr] = await catchError(
        waitChannel(preferred),
      );
      if (!waitErr) return preferred;
    }

    const openChannel = matches.find(
      (channel) => channel.readyState === "open",
    );
    if (openChannel) {
      if (
        protocol === "message" &&
        this.messageChannel !== openChannel
      ) {
        this.setupMessageChannel(openChannel);
      }
      return openChannel;
    }

    const connectingChannel = matches.find(
      (channel) => channel.readyState === "connecting",
    );
    if (connectingChannel) {
      if (
        protocol === "message" &&
        this.messageChannel !== connectingChannel
      ) {
        this.setupMessageChannel(connectingChannel);
      }
      const [waitErr] = await catchError(
        waitChannel(connectingChannel),
      );
      if (!waitErr) return connectingChannel;
    }

    const channel = this.peerConnection.createDataChannel(
      label,
      {
        ordered: appState.options.ordered,
        protocol,
      },
    );

    this.channels.push(channel);

    channel.addEventListener(
      "close",
      () => {
        const index = this.channels.findIndex(
          (c) => c.id === channel.id,
        );
        if (index !== -1) {
          this.channels.splice(index, 1);
        }
      },
      { signal: this.controller?.signal },
    );

    if (channel.protocol === "message") {
      this.setupMessageChannel(channel);
    }

    await waitChannel(channel);
    return channel;
  }

  private setupMessageChannel(channel: RTCDataChannel) {
    if (channel.protocol !== "message") return;

    if (!this.messageChannel) {
      this.messageChannel = channel;
    }

    if (this.messageChannelSetups.has(channel)) {
      if (channel.readyState === "open") {
        this.messageChannel = channel;
        this.updateMessageChannelOpenState();
        this.flushOutgoingQueue();
      }
      return;
    }
    this.messageChannelSetups.add(channel);

    channel.addEventListener(
      "message",
      (ev) => {
        const [error, message] = catchErrorSync(
          () => JSON.parse(ev.data) as SessionMessage,
        );
        if (error) {
          console.error(error);
          return;
        }

        this.dispatchEvent("message", message);
      },
      { signal: this.controller?.signal },
    );
    channel.addEventListener(
      "open",
      () => {
        this.messageChannel = channel;
        this.updateMessageChannelOpenState();
        this.flushOutgoingQueue();
      },
      { signal: this.controller?.signal },
    );
    channel.addEventListener(
      "error",
      (ev) => {
        console.error(ev);
      },
      { signal: this.controller?.signal },
    );
    channel.addEventListener(
      "close",
      () => {
        if (this.messageChannel === channel) {
          this.messageChannel = null;
          this.messageChannel =
            this.getOpenMessageChannel();
        }
        this.updateMessageChannelOpenState();

        if (!this.messageChannelOpen) {
          void this.ensureMessageChannelReady(
            "messagechannelchange:closed",
          );
        }
      },
      { signal: this.controller?.signal },
    );

    if (channel.readyState === "open") {
      this.messageChannel = channel;
      this.updateMessageChannelOpenState();
      this.flushOutgoingQueue();
    }
  }

  sendMessage(message: SessionMessage) {
    if (this.status === "closed") {
      throw new Error(
        `[PeerSession] session ${this.clientId} is closed, can not send message`,
      );
    }
    if (!this.getOpenMessageChannel()) {
      this.queueOutgoingMessage(message);
      void this.ensureMessageChannelReady(
        `sendMessage:${message.type}`,
      );
      return;
    }

    try {
      this.getOpenMessageChannel()?.send(
        JSON.stringify(message),
      );
    } catch (err) {
      console.error(err);
      this.queueOutgoingMessage(message);
      void this.ensureMessageChannelReady(
        `sendMessage:${message.type}:error`,
      );
    }
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
    if (this.makingOffer) {
      console.warn(
        `[PeerSession] session ${this.clientId} already making offer`,
      );
      return;
    }

    this.makingOffer = true;
    try {
      const [err] = await catchError(
        handleOffer(this.peerConnection, this.sender),
      );
      if (err) {
        console.error(
          `[PeerSession] Error during renegotiation:`,
          err,
        );
      }
    } finally {
      this.makingOffer = false;
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

    if (this.makingOffer) {
      throw new Error(
        `[PeerSession] session ${this.clientId} already making offer`,
      );
    }

    this.makingOffer = true;
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
                    `connection established, session ${this.clientId}, connectable: ${this.connectable}`,
                  );
                  this.connectable = true;
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

      const channelGuard = this.createChannel(
        "message",
        "message",
      ).then(() => connectionPromise);
      const offerPromise = handleOffer(
        pc,
        this.sender,
      ).catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : String(err);
        throw new Error(
          `[PeerSession] Failed to create and send offer: ${message}`,
        );
      });

      await Promise.all([
        offerPromise,
        Promise.race([connectionPromise, channelGuard]),
      ]);

      this.setupAfterConnectedListeners();
      this.setStatus("connected");
    } catch (err) {
      this.disconnect();
      throw err;
    } finally {
      this.makingOffer = false;
      connectAbortController.abort();
    }
  }

  private resetSession() {
    this.makingOffer = false;
    this.lastLocalStreamState = null;
    if (this.disconnectionTimer !== null) {
      window.clearTimeout(this.disconnectionTimer);
      this.disconnectionTimer = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.channels.forEach((channel) => channel.close());
    this.channels.length = 0;
    if (this.messageChannel) {
      this.messageChannel.close();
      this.messageChannel = null;
    }
    this.updateMessageChannelOpenState();
    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.remoteStream = null;
    }
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
    this.lifecycleController.abort();
    this.stopAutoReconnect();
    this.resetSession();
    this.outgoingQueue.length = 0;
    this.outgoingQueueKeys.clear();
    this.setStatus("closed");
  }
}

// this function is used to modify the offer
export async function handleOffer(
  pc: RTCPeerConnection,
  sender: SignalingService,
  options?: RTCOfferOptions,
) {
  const offer = await pc.createOffer(options);

  await pc.setLocalDescription(offer);
  await sender.sendSignal({
    type: offer.type,
    data: JSON.stringify({
      sdp: offer.sdp,
    }),
  });
}
