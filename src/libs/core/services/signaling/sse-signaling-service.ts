import {
  SignalingService,
  RawSignal,
  ClientSignal,
  SendSignalOptions,
} from "../type";
import { v4 as uuidv4 } from "uuid";

export interface SignalingServiceInitOptions {
  serverUrl: string;
  roomId: string;
  clientId: string;
  targetClientId: string;
}

export class SseSignalingService
  implements SignalingService
{
  private serverUrl: string;
  private roomId: string;
  private _sessionId: string;
  private _clientId: string;
  private _targetClientId: string;
  private eventSource: EventSource;

  private controller: AbortController =
    new AbortController();
  constructor(options: SignalingServiceInitOptions) {
    const { serverUrl, roomId, clientId, targetClientId } =
      options;
    this.serverUrl = serverUrl;
    this.roomId = roomId;
    this._sessionId = uuidv4();
    this._clientId = clientId;
    this._targetClientId = targetClientId;

    // Start listening for signals
    this.eventSource = new EventSource(
      `${this.serverUrl}/rooms/${this.roomId}/signals/${this._clientId}/events`,
    );
  }

  get sessionId() {
    return this._sessionId;
  }

  get clientId() {
    return this._clientId;
  }

  get targetClientId() {
    return this._targetClientId;
  }

  async sendSignal(
    signal: RawSignal,
    options: SendSignalOptions = {},
  ): Promise<void> {
    const payload: ClientSignal = {
      ...signal,
      sessionId: this._sessionId,
      clientId: this._clientId,
      targetClientId: options.bocast
        ? null
        : this._targetClientId,
    };

    await fetch(
      `${this.serverUrl}/rooms/${this.roomId}/signals`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    );
  }

  listenForSignal(
    callback: (signal: ClientSignal) => void,
  ): void {
    this.eventSource.addEventListener(
      "signal",
      (ev) => {
        callback(JSON.parse(ev.data) as ClientSignal);
      },
      {
        signal: this.controller.signal,
      },
    );
  }

  destroy(): void {
    this.eventSource.close();
    this.controller.abort();
  }
}
