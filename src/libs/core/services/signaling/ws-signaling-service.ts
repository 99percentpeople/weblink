// signaling/websocket-signaling-service.ts
import {
  RawSignal,
  ClientSignal,
  SignalingService,
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "../type";
import {
  encryptData,
  decryptData,
} from "@/libs/core/utils/encrypt/e2e";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";

export class WebSocketSignalingService implements SignalingService {
  private eventEmitter: MultiEventEmitter<SignalingServiceEventMap> =
    new MultiEventEmitter();
  private socket: WebSocket;
  private _clientId: string;
  private _targetClientId: string;
  private _status: SignalingServiceStatus = "init";
  private password: string | null = null;
  private controller: AbortController | null = null;
  private signalListenerReady = false;
  private pendingSignals: ClientSignal[] = [];
  private incomingTail: Promise<void> = Promise.resolve();
  constructor(
    socket: WebSocket,
    clientId: string,
    targetClientId: string,
    password: string | null = null,
  ) {
    this.socket = socket;
    this._clientId = clientId;
    this._targetClientId = targetClientId;
    this.password = password;

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
    const handleOpen = async () => {
      this.setStatus("connected");
    };
    if (socket.readyState === WebSocket.OPEN) {
      handleOpen();
    } else {
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
    this.controller = controller;
    this.socket = socket;
  }

  addEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.eventEmitter.addEventListener(
      event,
      callback,
      options,
    );
    if (event === "signal") {
      this.signalListenerReady = true;
      this.flushPendingSignals();
    }
  }

  removeEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      event,
      callback,
      options,
    );
  }

  dispatchEvent<K extends keyof SignalingServiceEventMap>(
    event: K,
    data: SignalingServiceEventMap[K],
  ): boolean {
    return this.eventEmitter.dispatchEvent(event, data);
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
      this.dispatchEvent("statuschange", status);
    }
  }

  async sendSignal(signal: RawSignal): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(
        `[WebSocketSignalingService] socket is not open`,
      );
    }

    const data = this.password
      ? await encryptData(this.password, signal.data)
      : signal.data;

    const message = {
      type: "message",
      data: {
        type: signal.type,
        targetClientId: this._targetClientId,
        clientId: this._clientId,
        data,
      } as ClientSignal,
    };

    this.socket.send(JSON.stringify(message));
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

      const decryptedData = this.password
        ? await decryptData(this.password, incoming.data)
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
      this.dispatchEvent("signal", message);
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
      this.dispatchEvent("signal", message);
    });
  }

  close() {
    if (this._status === "closed") return;
    this.controller?.abort();
    this.controller = null;
    this.pendingSignals.length = 0;
    this.signalListenerReady = false;
    this.setStatus("closed");
    this.eventEmitter.clearListeners();
  }
}
