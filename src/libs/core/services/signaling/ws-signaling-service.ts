// signaling/websocket-signaling-service.ts
import { v4 as uuidv4 } from "uuid";
import {
  RawSignal,
  ClientSignal,
  SignalingService,
} from "../type";

import { SessionID } from "../../type";
import {
  encryptData,
  decryptData,
} from "../../utils/encrypt";

export class WebSocketSignalingService
  implements SignalingService
{
  private socket: WebSocket;
  private _sessionId: SessionID;
  private _clientId: string;
  private _targetClientId: string;
  private password: string | null = null;
  private listeners: Array<(signal: ClientSignal) => void> =
    [];

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

  listenForSignal(
    callback: (signal: ClientSignal) => void,
  ) {
    this.listeners.push(callback);
  }

  private onMessage = async (event: MessageEvent) => {
    const signal: RawSignal = JSON.parse(event.data);
    if (signal.type !== "message") return;

    const data = signal.data as ClientSignal;
    // Ignore signals sent by this instance
    if (data.sessionId === this._sessionId) return;

    // Check if the signal is intended for this client
    if (
      data.targetClientId &&
      data.targetClientId !== this._clientId
    )
      return;

    // Check if the signal is from the target client
    if (data.clientId !== this._targetClientId) return;

    if (this.password) {
      data.data = await decryptData(
        this.password,
        data.data,
      );
    }

    this.listeners.forEach((callback) => callback(data));
  };

  destroy() {
    this.listeners = [];
    this.socket.removeEventListener(
      "message",
      this.onMessage,
    );
    // Additional cleanup if necessary
  }
}
