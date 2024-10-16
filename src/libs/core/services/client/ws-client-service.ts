import { ClientID, TransferClient } from "../../type";
import {
  comparePasswordHash,
  hashPassword,
} from "../../utils/encrypt";
import { WebSocketSignalingService } from "../signaling/ws-signaling-service";
import { ClientSignal, RawSignal } from "../type";
import {
  ClientService,
  ClientServiceInitOptions,
} from "../type";
import { UpdateClientOptions } from "./firebase-client-service";

export class WebSocketClientService
  implements ClientService
{
  private roomId: string;
  private password: string | null;
  private client: TransferClient;
  private socket: WebSocket | null = null;
  private signalingServices: Map<
    string,
    WebSocketSignalingService
  > = new Map();

  private eventListeners: Map<string, Array<Function>> =
    new Map();

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
    this.socket = new WebSocket(wsUrl);

    this.socket.addEventListener("message", (ev) => {
      const signal: RawSignal = JSON.parse(ev.data);
      switch (signal.type) {
        case "join":
          this.emit("join", signal.data as TransferClient);
          break;
        case "leave":
          this.emit("leave", signal.data as TransferClient);
          break;
        case "ping":
          this.socket?.send(
            JSON.stringify({ type: "pong" }),
          );
        default:
          break;
      }
    });

    this.socket?.addEventListener("close", () => {}, {
      once: true,
    });

    return new Promise<WebSocket>((resolve, reject) => {
      this.socket?.addEventListener(
        "message",
        async (ev) => {
          const message = JSON.parse(ev.data) as RawSignal;
          if (message.type === "connected") {
            const passwordHash = message.data;
            if (passwordHash) {
              if (!this.password) {
                return reject(new Error("password required"));
              }

              const passwordMatch =
                await comparePasswordHash(
                  this.password,
                  passwordHash,
                );
              if (!passwordMatch) {
                return reject(new Error("incorrect password"));
              }
            }
            resolve(this.socket!);
          } else if (message.type === "error") {
            reject(message.data);
          }
        },
        { once: true },
      );
    });
  }

  getSender(
    targetClientId: string,
  ): WebSocketSignalingService {
    let service =
      this.signalingServices.get(targetClientId);
    if (!service) {
      if (!this.socket) {
        throw Error("socket not init yet");
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
    const socket = await this.initialize();

    socket.send(
      JSON.stringify({
        type: "join",
        data: this.client,
      }),
    );
  }
  destroy() {
    this.signalingServices.forEach((service) =>
      service.destroy(),
    );
    this.socket?.close();
    this.eventListeners.clear();
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
