// signaling/websocket-signaling-service.ts
import { v4 as uuidv4 } from "uuid";
import {
  RawSignal,
  ClientSignal,
  SignalingService,
  SignalingServiceEventMap,
} from "../type";

import { SessionID } from "../../type";
import {
  encryptData,
  decryptData,
} from "../../utils/encrypt";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";

export class WebSocketSignalingService
  implements SignalingService
{
  private eventEmitter: MultiEventEmitter<SignalingServiceEventMap> =
    new MultiEventEmitter();
  private socket: WebSocket;
  private _sessionId: SessionID;
  private _clientId: string;
  private _targetClientId: string;
  private password: string | null = null;

  constructor(
    socket: WebSocket,
    clientId: string,
    targetClientId: string,
    password: string | null = null,
  ) {
    this.socket = socket;
    this._sessionId = uuidv4();
    this._clientId = clientId;
    this._targetClientId = targetClientId;
    this.password = password;

    // Handle incoming messages
    this.socket.addEventListener("message", this.onMessage);
  }

  addEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      event,
      callback,
      options,
    );
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

  setSocket(socket: WebSocket) {
    this.socket.removeEventListener(
      "message",
      this.onMessage,
    );
    this.socket = socket;
    this.socket.addEventListener("message", this.onMessage);
  }

  get sessionId(): SessionID {
    return this._sessionId;
  }

  get clientId(): string {
    return this._clientId;
  }

  get targetClientId(): string {
    return this._targetClientId;
  }

  async sendSignal(signal: RawSignal): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("socket is not open");
    }

    if (this.password) {
      signal.data = await encryptData(
        this.password,
        signal.data,
      );
    }

    this.socket.send(
      JSON.stringify({
        type: "message",
        data: {
          type: signal.type,
          targetClientId: this._targetClientId,
          clientId: this._clientId,
          data: signal.data,
        } as ClientSignal,
      }),
    );
  }

  private onMessage = async (event: MessageEvent) => {
    const signal: RawSignal = JSON.parse(event.data);
    if (signal.type !== "message") return;

    const message = signal.data as ClientSignal;
    // Ignore signals sent by this instance
    if (message.sessionId === this._sessionId) return;

    // Check if the signal is intended for this client
    if (
      message.targetClientId &&
      message.targetClientId !== this._clientId
    )
      return;

    // Check if the signal is from the target client
    if (message.clientId !== this._targetClientId) return;

    if (this.password) {
      message.data = await decryptData(
        this.password,
        message.data,
      );
    }
    message.data = JSON.parse(message.data);

    this.dispatchEvent("signal", message);
  };

  destroy() {
    this.eventEmitter.clearListeners();
    this.socket.removeEventListener(
      "message",
      this.onMessage,
    );
    // Additional cleanup if necessary
  }
}
