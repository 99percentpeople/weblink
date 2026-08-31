import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";
import {
  comparePasswordHash,
  hashPassword,
} from "@/libs/core/utils/encrypt/e2e";
import { WebSocketSignalingService } from "../signaling/ws-signaling-service";
import {
  ClientServiceEventMap,
  RawSignal,
  TransferClient,
  type ClientPresence,
  type UpdateClientOptions,
} from "../type";
import {
  ClientService,
  ClientServiceInitOptions,
} from "../type";
import {
  createClientPresence,
  hydrateClientPresence,
} from "./client-presence";
import { toast } from "solid-sonner";
import { catchError, catchErrorSync } from "@/libs/catch";

export class WebSocketClientService implements ClientService {
  private eventEmitter =
    new MultiEventEmitter<ClientServiceEventMap>();
  private roomId: string;
  private password: string | null;
  private client: TransferClient;
  private socket: WebSocket | null = null;
  private controller: AbortController | null = null;
  private signalingServices: Map<
    string,
    WebSocketSignalingService
  > = new Map();

  private eventListeners: Map<string, Array<Function>> =
    new Map();

  private maxReconnectAttempts = 3;
  private reconnectAttempts = 0;
  private reconnectInterval = 3000;
  private websocketUrl: string;
  private status:
    | "created"
    | "connecting"
    | "connected"
    | "disconnected" = "created";

  get info() {
    return this.client;
  }

  constructor({
    roomId,
    password,
    client,
    websocketUrl,
  }: ClientServiceInitOptions) {
    this.roomId = roomId;
    this.password = password;
    this.client = { ...client, createdAt: Date.now() };
    this.websocketUrl =
      websocketUrl ?? import.meta.env.VITE_WEBSOCKET_URL;
  }

  private setStatus(
    status: "connecting" | "connected" | "disconnected",
  ) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent("statuschange", status);
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

  private async initialize(resume?: boolean) {
    if (this.socket) {
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        console.warn(
          `[WebSocketClientService] socket already initialized, return existing socket`,
        );
        return this.socket;
      } else {
        console.warn(
          `[WebSocketClientService] close existing socket`,
        );
        this.disconnect();
      }
    }

    const wsUrl = new URL(this.websocketUrl);

    wsUrl.searchParams.append("room", this.roomId);
    if (this.password) {
      const hash = await hashPassword(this.password).catch(
        (error) => {
          this.password = null;
          toast.error(
            `failed to hash password: ${error.message}`,
          );
          return null;
        },
      );
      if (hash) {
        wsUrl.searchParams.append("pwd", hash);
      }
    }

    const socket = new WebSocket(wsUrl);
    const setupListeners = (socket: WebSocket) => {
      if (this.controller) {
        this.controller.abort();
      }
      const controller = new AbortController();

      this.controller = controller;

      window.addEventListener(
        "beforeunload",
        () => {
          this.close();
        },
        { signal: controller.signal },
      );
      window.addEventListener(
        "unload",
        () => {
          this.close();
        },
        { signal: controller.signal },
      );

      socket.addEventListener(
        "message",
        (ev) => {
          const [error, signal] = catchErrorSync(
            () => JSON.parse(ev.data) as RawSignal,
          );
          if (error) {
            console.error(
              `[WebSocketClientService] parse message error: ${error.message}`,
            );
            return;
          }
          switch (signal.type) {
            case "join":
              this.emit(
                "join",
                hydrateClientPresence(
                  signal.data as ClientPresence,
                ),
              );
              break;
            case "leave":
              this.emit(
                "leave",
                hydrateClientPresence(
                  signal.data as ClientPresence,
                ),
              );
              break;
            case "ping":
              socket.send(JSON.stringify({ type: "pong" }));
              break;
            default:
              break;
          }
        },
        { signal: controller.signal },
      );

      socket.addEventListener(
        "error",
        (ev) => {
          console.warn(
            `[WebSocketClientService] socket error:`,
            ev,
          );
        },
        { signal: controller.signal },
      );

      socket.addEventListener(
        "close",
        () => {
          this.reconnect();
        },
        {
          signal: controller.signal,
        },
      );
      this.socket = socket;
      return socket;
    };

    const connectController = new AbortController();

    return new Promise<WebSocket>((resolve, reject) => {
      this.setStatus("connecting");
      let timer = window.setTimeout(() => {
        reject(
          new Error(
            "[WebSocketClientService] connection timeout",
          ),
        );
      }, 10000);

      connectController.signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timer);
        },
      );

      socket.addEventListener(
        "close",
        (ev) => {
          reject(
            new Error(
              `[WebSocketClientService] socket error ${ev.code} ${ev.reason}`,
            ),
          );
        },
        { once: true, signal: connectController.signal },
      );
      socket.addEventListener(
        "message",
        async (ev) => {
          const [error, message] = catchErrorSync(
            () => JSON.parse(ev.data) as RawSignal,
          );
          if (error) {
            return reject(error);
          }
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
                  new Error(
                    "[WebSocketClientService] incorrect password",
                  ),
                );
              }
            } else {
              this.password = null;
              toast.warning(
                "[WebSocketClientService] the room is not password protected",
              );
            }
            socket.send(
              JSON.stringify({
                type: "join",
                data: createClientPresence(
                  this.client,
                  resume,
                ),
              }),
            );
            resolve(socket);
          } else if (message.type === "error") {
            reject(new Error(message.data));
          }
        },
        { once: true, signal: connectController.signal },
      );
    })
      .then((socket) => {
        this.setStatus("connected");
        return setupListeners(socket);
      })
      .catch((err) => {
        this.setStatus("disconnected");
        this.disconnect();
        throw err;
      })
      .finally(() => {
        connectController.abort();
      });
  }

  private async reconnect() {
    const [error, socket] = await catchError(
      this.initialize(true),
    );
    if (error) {
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
        console.error(
          `[WebSocketClientService] reach max reconnect attempts, send close message`,
        );
        toast.error(`socket reach max reconnect attempts`);
        this.close();
      }
      return;
    }

    this.signalingServices.forEach((service) => {
      service.resetSocket(socket);
    });

    this.reconnectAttempts = 0;
    console.log(
      `[WebSocketClientService] socket reconnect success`,
    );
  }

  createSender(
    targetClientId: string,
  ): WebSocketSignalingService | null {
    let service =
      this.signalingServices.get(targetClientId);
    if (service) {
      console.warn(
        `[WebSocketClientService] sender to remote client: ${targetClientId} already exists`,
      );
      return null;
    }

    if (!this.socket) {
      throw Error(
        "[WebSocketClientService] socket not initialized",
      );
    }
    service = new WebSocketSignalingService(
      this.socket,
      this.client.clientId,
      targetClientId,
      this.password,
    );
    this.signalingServices.set(targetClientId, service);
    return service;
  }
  removeSender(targetClientId: string) {
    const service =
      this.signalingServices.get(targetClientId);
    if (service) {
      service.close();
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

  private disconnect() {
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            type: "leave",
            data: createClientPresence(this.client),
          }),
        );
      }
      this.socket = null;
    }
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    this.setStatus("disconnected");
  }

  close() {
    this.disconnect();
    this.signalingServices.forEach((service) =>
      service.close(),
    );
    this.signalingServices.clear();
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
    this.client.avatar =
      options.avatar === undefined
        ? this.client.avatar
        : options.avatar;
  }
}
