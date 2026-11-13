// signaling/websocket-signaling-service.ts
import type {
  RawSignal,
  ClientSignal,
  SignalingService,
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "@/libs/domain/signaling";
import {
  createPasswordCipher,
  type PasswordCipher,
} from "@/libs/domain/utils/encrypt/e2e";
import { EventBus } from "@weblink/platform/events";
import { encodeSignalingEnvelope } from "@/libs/domain/signaling-protocol";
import type { EventSource } from "@weblink/platform/events";

export class WebSocketSignalingService implements SignalingService {
  private eventEmitter: EventBus<SignalingServiceEventMap> =
    new EventBus("signaling.peer");
  readonly events: EventSource<SignalingServiceEventMap> = {
    subscribe: (event, callback, options) => {
      const stop = this.eventEmitter.subscribe(
        event,
        callback,
        options,
      );
      if (event === "signal" && !options?.signal?.aborted) {
        this.signalListenerReady = true;
        this.flushPendingSignals();
      }
      return stop;
    },
  };
  private socket: WebSocket;
  private _clientId: string;
  private _targetClientId: string;
  private _status: SignalingServiceStatus = "init";
  private cipher?: PasswordCipher;
  private controller: AbortController | null = null;
  private signalListenerReady = false;
  private pendingSignals: ClientSignal[] = [];
  private incomingTail: Promise<void> = Promise.resolve();
  private peerConnectionId: string | null = null;
  constructor(
    socket: WebSocket,
    clientId: string,
    targetClientId: string,
    password: string | null = null,
  ) {
    this.socket = socket;
    this._clientId = clientId;
    this._targetClientId = targetClientId;
    this.cipher = password
      ? createPasswordCipher(password)
      : undefined;

    this.setSocket(socket);
  }

  get status(): SignalingServiceStatus {
    return this._status;
  }

  private isClosed(): boolean {
    return this._status === "closed";
  }

  private setSocket(socket: WebSocket) {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.socket = socket;
    const handleOpen = async () => {
      this.setStatus("connected");
    };
    if (socket.readyState === WebSocket.OPEN) {
      handleOpen();
    } else {
      this.setStatus("disconnected");
      socket.addEventListener("open", handleOpen, {
        once: true,
        signal: controller.signal,
      });
    }
    socket.addEventListener(
      "close",
      () => {
        this.setStatus("disconnected");
      },
      {
        once: true,
        signal: controller.signal,
      },
    );
  }

  private emit<K extends keyof SignalingServiceEventMap>(
    event: K,
    data: SignalingServiceEventMap[K],
  ): void {
    return this.eventEmitter.emit(event, data);
  }

  notifyPeerOnline(connectionId: string): void {
    if (
      this.isClosed() ||
      this.peerConnectionId === connectionId
    )
      return;
    this.peerConnectionId = connectionId;
    this.emit("peeravailable", undefined);
  }

  resetSocket(socket: WebSocket) {
    if (this._status === "closed") return;
    this.setSocket(socket);
  }

  get clientId(): string {
    return this._clientId;
  }

  get targetClientId(): string {
    return this._targetClientId;
  }

  setStatus(status: SignalingServiceStatus) {
    if (this._status === status) return;
    this._status = status;
    if (status !== "init") {
      this.emit("statuschange", status);
    }
  }

  async sendSignal(signal: RawSignal): Promise<void> {
    if (
      this.isClosed() ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error(
        `[WebSocketSignalingService] socket is not open`,
      );
    }

    const data = this.cipher
      ? await this.cipher.encrypt(signal.data)
      : signal.data;

    // Encryption yields: the socket or the sender may close in the meantime.
    if (
      this.isClosed() ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error(
        "[WebSocketSignalingService] socket is not open",
      );
    }

    const message = {
      type: "message",
      data: {
        type: signal.type,
        targetClientId: this._targetClientId,
        clientId: this._clientId,
        data,
      } as ClientSignal,
    };

    this.socket.send(encodeSignalingEnvelope(message));
  }

  handleIncomingSignal(signal: RawSignal): Promise<void> {
    this.incomingTail = this.incomingTail.then(() =>
      this.processIncomingSignal(signal),
    );
    return this.incomingTail;
  }

  private async processIncomingSignal(signal: RawSignal) {
    try {
      if (this.isClosed()) return;
      if (signal.type !== "message") return;

      const incoming = signal.data as ClientSignal;
      if (
        incoming.targetClientId &&
        incoming.targetClientId !== this._clientId
      ) {
        return;
      }
      if (incoming.clientId !== this._targetClientId) {
        return;
      }

      const decryptedData = this.cipher
        ? await this.cipher.decrypt(incoming.data)
        : incoming.data;
      const message: ClientSignal = {
        ...incoming,
        data: JSON.parse(decryptedData),
      };
      if (this.isClosed()) return;

      if (!this.signalListenerReady) {
        this.pendingSignals.push(message);
        if (this.pendingSignals.length > 256) {
          this.pendingSignals.splice(
            0,
            this.pendingSignals.length - 256,
          );
        }
        return;
      }
      this.emit("signal", message);
    } catch (error) {
      console.error(
        "[WebSocketSignalingService] failed to handle signal:",
        error,
      );
    }
  }

  private flushPendingSignals() {
    if (!this.signalListenerReady) return;
    const pending = this.pendingSignals.splice(0);
    pending.forEach((message) => {
      this.emit("signal", message);
    });
  }

  close() {
    if (this._status === "closed") return;
    this.controller?.abort();
    this.controller = null;
    this.pendingSignals.length = 0;
    this.cipher?.dispose();
    this.cipher = undefined;
    this.signalListenerReady = false;
    this.setStatus("closed");
    this.eventEmitter.dispose();
  }
}
