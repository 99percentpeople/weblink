import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";
import { ClientID, TransferClient } from "../../type";
import {
  comparePasswordHash,
  hashPassword,
} from "../../utils/encrypt";
import { WebSocketSignalingService } from "../signaling/ws-signaling-service";
import { ClientServiceEventMap, RawSignal } from "../type";
import {
  ClientService,
  ClientServiceInitOptions,
} from "../type";
import { UpdateClientOptions } from "./firebase-client-service";
import { toast } from "solid-sonner";

export class WebSocketClientService
  implements ClientService
{
  private eventEmitter =
    new MultiEventEmitter<ClientServiceEventMap>();
  private roomId: string;
  private password: string | null;
  private client: TransferClient;
  private socket: WebSocket | null = null;
  private controller: AbortController =
    new AbortController();
  private signalingServices: Map<
    string,
    WebSocketSignalingService
  > = new Map();

  private eventListeners: Map<string, Array<Function>> =
    new Map();

  private maxReconnectAttempts = 3;
  private reconnectAttempts = 0;
  private reconnectInterval = 5000;

  get info() {
    return this.client;
  }

  constructor({
    roomId,
    password,
    client,
  }: ClientServiceInitOptions) {
    this.roomId = roomId;
    this.password = password;
    this.client = { ...client, createdAt: Date.now() };

    window.addEventListener("beforeunload", () => {
      this.destroy();
    });
  }

  private dispatchEvent<
    K extends keyof ClientServiceEventMap,
  >(event: K, data: ClientServiceEventMap[K]) {
    return this.eventEmitter.dispatchEvent(event, data);
  }

  addEventListener<K extends keyof ClientServiceEventMap>(
    event: K,
    callback: EventHandler<ClientServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      event,
      callback,
      options,
    );
  }

  removeEventListener<
    K extends keyof ClientServiceEventMap,
  >(
    event: K,
    callback: EventHandler<ClientServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      event,
      callback,
      options,
    );
  }

  async initialize() {
    const wsUrl = new URL(
      import.meta.env.VITE_WEBSOCKET_URL,
    );

    wsUrl.searchParams.append("room", this.roomId);
    if (this.password) {
      const hash = await hashPassword(this.password);
      wsUrl.searchParams.append("pwd", hash);
    }
    const socket = new WebSocket(wsUrl);
    this.dispatchEvent("status-change", "connecting");
    socket.addEventListener("message", (ev) => {
      const signal: RawSignal = JSON.parse(ev.data);
      switch (signal.type) {
        case "join":
          this.emit("join", signal.data as TransferClient);
          break;
        case "leave":
          this.emit("leave", signal.data as TransferClient);
          break;
        case "ping":
          socket.send(JSON.stringify({ type: "pong" }));
        default:
          break;
      }
    });

    socket.addEventListener(
      "close",
      this.handleDisconnect,
      {
        signal: this.controller.signal,
      },
    );

    this.controller.signal.addEventListener("abort", () => {
      this.dispatchEvent("status-change", "disconnected");
    });

    this.socket = socket;

    return new Promise<WebSocket>((resolve, reject) => {
      socket.addEventListener(
        "error",
        () => {
          reject(new Error(`WebSocket error occurred`));
          this.destroy();
        },
        { once: true, signal: this.controller.signal },
      );
      socket.addEventListener(
        "message",
        async (ev) => {
          const message = JSON.parse(ev.data) as RawSignal;
          if (message.type === "connected") {
            const passwordHash = message.data;
            if (passwordHash) {
              if (!this.password) {
                return reject(
                  new Error("password required"),
                );
              }

              const passwordMatch =
                await comparePasswordHash(
                  this.password,
                  passwordHash,
                );
              if (!passwordMatch) {
                return reject(
                  new Error("incorrect password"),
                );
              }
            } else {
              this.password = null;
              toast.error(
                "the room is not password protected",
              );
            }
            socket.send(
              JSON.stringify({
                type: "join",
                data: this.client,
              }),
            );
            this.dispatchEvent(
              "status-change",
              "connected",
            );
            resolve(socket);
          } else if (message.type === "error") {
            reject(new Error(message.data));
            this.destroy();
          }
        },
        { once: true, signal: this.controller.signal },
      );
    });
  }

  private handleDisconnect = () => {
    if (
      this.reconnectAttempts < this.maxReconnectAttempts
    ) {
      console.log(`WebSocket closed, reconnecting...`);
      setTimeout(
        () => this.reconnect(),
        this.reconnectInterval,
      );
    } else {
      console.log(`Reconnect failed, send leave message`);
      this.destroy();
    }
  };

  private async reconnect() {
    try {
      await this.initialize();
      this.reconnectAttempts = 0;
      console.log(`Reconnect success`);
    } catch (error) {
      this.reconnectAttempts++;
      console.log(
        `Reconnect failed, attempt: ${this.reconnectAttempts}`,
      );
      if (
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        setTimeout(
          () => this.reconnect(),
          this.reconnectInterval,
        );
      } else {
        console.log(
          `Reach max reconnect attempts, send leave message`,
        );
        this.destroy();
      }
    }
  }

  getSender(
    targetClientId: string,
  ): WebSocketSignalingService {
    let service =
      this.signalingServices.get(targetClientId);
    if (!service) {
      if (!this.socket) {
        throw Error("WebSocket not init yet");
      }
      service = new WebSocketSignalingService(
        this.socket,
        this.client.clientId,
        targetClientId,
        this.password,
      );
      this.signalingServices.set(targetClientId, service);
    }
    return service;
  }
  removeSender(targetClientId: string) {
    const service =
      this.signalingServices.get(targetClientId);
    if (service) {
      service.destroy();
      this.signalingServices.delete(targetClientId);
    }
  }
  listenForJoin(
    callback: (client: TransferClient) => void,
  ) {
    this.on("join", callback);
  }

  listenForLeave(
    callback: (client: TransferClient) => void,
  ) {
    this.on("leave", callback);
  }
  async createClient() {
    await this.initialize();
  }
  destroy() {
    this.signalingServices.forEach((service) =>
      service.destroy(),
    );
    this.eventListeners.clear();

    this.socket?.send(
      JSON.stringify({
        type: "leave",
        data: this.client,
      }),
    );

    this.controller.abort();
    this.socket = null;
  }
  private emit(event: string, data: any) {
    const listeners = this.eventListeners.get(event) || [];
    listeners.forEach((callback) => callback(data));
  }

  private on(event: string, callback: Function) {
    const listeners = this.eventListeners.get(event) || [];
    listeners.push(callback);
    this.eventListeners.set(event, listeners);
  }

  async updateClient(options: UpdateClientOptions) {
    this.client.name = options.name ?? this.client.name;
  }
}
