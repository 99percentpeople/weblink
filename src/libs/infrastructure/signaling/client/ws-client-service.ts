import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";
import {
  comparePasswordHash,
  hashPassword,
} from "@/libs/domain/utils/encrypt/e2e";
import { WebSocketSignalingService } from "../transport/ws-signaling-service";
import type {
  ClientPresence,
  ClientJoinOptions,
  ClientService,
  ClientServiceEventMap,
  ClientServiceInitOptions,
  TransferClient,
  UpdateClientOptions,
} from "@/libs/domain/client";
import type {
  ClientSignal,
  RawSignal,
} from "@/libs/domain/signaling";
import {
  createClientPresence,
  hydrateClientPresence,
} from "./client-presence";
import {
  getReconnectDelayMs,
  waitForReconnect,
  WEBSOCKET_CONNECTION_TIMEOUT_MS,
  WEBSOCKET_JOIN_ACK_TIMEOUT_MS,
} from "./reconnect-policy";
import {
  encodeSignalingEnvelope,
  isSignalingJoinAcknowledgement,
  parseSignalingEnvelope,
  parseSignalingPeerOnline,
  SIGNALING_MAX_CACHED_SIGNALS,
} from "@/libs/domain/signaling-protocol";
import { catchErrorSync } from "@/libs/catch";
import { startSocketHeartbeat } from "./ws-heartbeat";
import {
  acquireRoomConnectionLock,
  roomConnectionLockName,
} from "./room-connection-lock";

type PublicConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected";

const MAX_BUFFERED_SIGNALS = SIGNALING_MAX_CACHED_SIGNALS;

interface JoinedSocket {
  socket: WebSocket;
  resumed?: boolean;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error));
}

export class WebSocketClientService implements ClientService {
  private eventEmitter =
    new MultiEventEmitter<ClientServiceEventMap>();
  private roomId: string;
  private password: string | null;
  private client: TransferClient;
  private websocketUrl: string;

  private socket: WebSocket | null = null;
  private activeSocket: WebSocket | null = null;
  private socketController: AbortController | null = null;
  private connectController: AbortController | null = null;
  private connectPromise: Promise<WebSocket> | null = null;
  private reconnectController: AbortController | null =
    null;
  private reconnectPromise: Promise<void> | null = null;
  private lifecycleController = new AbortController();
  private connectionGeneration = 0;
  private reconnectAttempts = 0;
  private hasConnected = false;
  private createPromise: Promise<void> | null = null;
  private releaseRoomLock: (() => void) | null = null;
  private closed = false;
  private passwordHashPromise: Promise<
    string | null
  > | null = null;
  private warnedUnprotectedRoom = false;
  private warnedLegacyJoinAck = false;
  private joiningSocket: WebSocket | null = null;
  private bufferedSignals: RawSignal[] = [];
  private pendingPeerSignals = new Map<
    string,
    RawSignal[]
  >();
  private peers = new Map<string, TransferClient>();

  private signalingServices: Map<
    string,
    WebSocketSignalingService
  > = new Map();

  private eventListeners: Map<string, Array<Function>> =
    new Map();

  private status: "created" | PublicConnectionStatus =
    "created";

  get info() {
    return this.client;
  }

  private readonly onNotice: ClientServiceInitOptions["onNotice"];

  constructor({
    onNotice,
    roomId,
    password,
    client,
    websocketUrl,
  }: ClientServiceInitOptions) {
    this.onNotice = onNotice;
    this.roomId = roomId;
    this.password = password;
    this.client = { ...client, createdAt: Date.now() };
    this.websocketUrl =
      websocketUrl ?? import.meta.env.VITE_WEBSOCKET_URL;

    if (typeof window !== "undefined") {
      const { signal } = this.lifecycleController;
      window.addEventListener(
        "beforeunload",
        () => this.close(),
        { signal },
      );
      window.addEventListener(
        "online",
        () => {
          if (
            this.hasConnected &&
            !this.closed &&
            this.status !== "connected"
          ) {
            this.startReconnect();
          }
        },
        { signal },
      );
    }
  }

  private setStatus(status: PublicConnectionStatus) {
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

  private isCurrentConnection(
    socket: WebSocket,
    generation: number,
  ): boolean {
    return (
      !this.closed &&
      this.connectionGeneration === generation &&
      this.socket === socket
    );
  }

  private async getPasswordHash(): Promise<string | null> {
    if (!this.password) return null;
    if (!this.passwordHashPromise) {
      this.passwordHashPromise = hashPassword(
        this.password,
      ).catch((error: unknown) => {
        console.error(
          "Failed to hash room password",
          error,
        );
        this.password = null;
        this.onNotice?.("password-hash-failed");
        return null;
      });
    }
    return this.passwordHashPromise;
  }

  private async createWebSocketUrl(
    signal: AbortSignal,
  ): Promise<URL> {
    const wsUrl = new URL(this.websocketUrl);
    wsUrl.searchParams.set("room", this.roomId);

    const passwordHash = await this.getPasswordHash();
    if (signal.aborted) {
      throw abortError(
        "[WebSocketClientService] connection aborted",
      );
    }
    if (passwordHash) {
      wsUrl.searchParams.set("pwd", passwordHash);
    }
    return wsUrl;
  }

  private async validateRoomPassword(
    passwordHash: unknown,
  ): Promise<void> {
    if (typeof passwordHash === "string" && passwordHash) {
      if (!this.password) {
        throw new Error("password required");
      }

      const passwordMatch = await comparePasswordHash(
        this.password,
        passwordHash,
      );
      if (!passwordMatch) {
        throw new Error(
          "[WebSocketClientService] incorrect password",
        );
      }
      return;
    }

    this.password = null;
    this.passwordHashPromise = null;
    if (!this.warnedUnprotectedRoom) {
      this.warnedUnprotectedRoom = true;
      this.onNotice?.("room-unprotected");
    }
  }

  private activateSocket(
    socket: WebSocket,
    generation: number,
  ): void {
    this.socketController?.abort();

    const controller = new AbortController();
    this.socketController = controller;
    this.activeSocket = socket;
    this.joiningSocket = socket;
    this.bufferedSignals = [];

    socket.addEventListener(
      "message",
      (event) => this.handleSocketMessage(socket, event),
      { signal: controller.signal },
    );
    socket.addEventListener(
      "error",
      (event) => {
        if (!this.isCurrentConnection(socket, generation)) {
          return;
        }
        // The close/reconnect path records the actionable failure once.
        console.debug(
          "[WebSocketClientService] socket error",
          event,
        );
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      },
      { signal: controller.signal },
    );
    socket.addEventListener(
      "close",
      (event) =>
        this.handleSocketClose(socket, generation, event),
      { once: true, signal: controller.signal },
    );
  }

  private handleSocketMessage(
    socket: WebSocket,
    event: MessageEvent,
  ): void {
    if (socket !== this.activeSocket) return;

    const [error, signal] = catchErrorSync(() =>
      parseSignalingEnvelope(String(event.data)),
    );
    if (error) {
      console.error(
        `[WebSocketClientService] parse message error: ${error.message}`,
      );
      return;
    }

    if (
      this.joiningSocket === socket &&
      !["connected", "joined", "error", "ping"].includes(
        signal.type,
      )
    ) {
      this.bufferedSignals.push(signal);
      if (
        this.bufferedSignals.length > MAX_BUFFERED_SIGNALS
      ) {
        this.bufferedSignals.splice(
          0,
          this.bufferedSignals.length -
            MAX_BUFFERED_SIGNALS,
        );
      }
      return;
    }

    this.routeSocketSignal(socket, signal);
  }

  private routeSocketSignal(
    socket: WebSocket,
    signal: RawSignal,
  ): void {
    switch (signal.type) {
      case "peer-online": {
        const availability = parseSignalingPeerOnline(
          signal.data,
        );
        if (
          !availability ||
          availability.clientId === this.client.clientId
        )
          return;
        this.signalingServices
          .get(availability.clientId)
          ?.notifyPeerOnline(availability.connectionId);
        break;
      }
      case "join": {
        const client = hydrateClientPresence(
          signal.data as ClientPresence,
        );
        this.peers.set(client.clientId, client);
        this.emit("join", client);
        break;
      }
      case "leave": {
        const client = hydrateClientPresence(
          signal.data as ClientPresence,
        );
        this.peers.delete(client.clientId);
        this.emit("leave", client);
        break;
      }
      case "message": {
        const message = signal.data as ClientSignal;
        if (
          !message ||
          typeof message.clientId !== "string"
        ) {
          console.warn(
            "[WebSocketClientService] invalid client signal",
          );
          return;
        }
        const service = this.signalingServices.get(
          message.clientId,
        );
        if (service) {
          void service.handleIncomingSignal(signal);
          return;
        }

        const pending =
          this.pendingPeerSignals.get(message.clientId) ??
          [];
        pending.push(signal);
        if (pending.length > MAX_BUFFERED_SIGNALS) {
          pending.splice(
            0,
            pending.length - MAX_BUFFERED_SIGNALS,
          );
        }
        this.pendingPeerSignals.set(
          message.clientId,
          pending,
        );
        break;
      }
      case "ping":
        if (socket.readyState === WebSocket.OPEN) {
          try {
            socket.send(
              encodeSignalingEnvelope({
                type: "pong",
                data: undefined,
              }),
            );
          } catch (error) {
            console.warn(
              "[WebSocketClientService] failed to send pong:",
              error,
            );
          }
        }
        break;
      default:
        break;
    }
  }

  private completeRoomJoin(
    socket: WebSocket,
    resetPeers: boolean,
  ): void {
    if (this.joiningSocket !== socket) return;

    // An expired server session is a fresh membership. Retire the old peer
    // sessions before the new roster creates senders for the same client IDs.
    if (resetPeers) {
      const peers = [...this.peers.values()];
      this.peers.clear();
      peers.forEach((client) => this.emit("leave", client));
      this.signalingServices.forEach((service) =>
        service.close(),
      );
      this.signalingServices.clear();
      this.pendingPeerSignals.clear();
    }

    this.signalingServices.forEach((service) => {
      service.resetSocket(socket);
    });
    this.joiningSocket = null;

    const buffered = this.bufferedSignals.splice(0);
    buffered.forEach((signal) => {
      if (this.closed || this.activeSocket !== socket)
        return;
      this.routeSocketSignal(socket, signal);
    });

    if (
      this.activeSocket === socket &&
      this.socketController
    ) {
      const generation = this.connectionGeneration;
      startSocketHeartbeat(
        socket,
        this.socketController.signal,
        () => {
          if (!this.isCurrentConnection(socket, generation))
            return;
          console.warn(
            "[WebSocketClientService] heartbeat timeout; replacing unresponsive socket",
            {
              clientId: this.client.clientId,
              readyState: socket.readyState,
              generation,
            },
          );
          // close() can remain in CLOSING indefinitely on a broken network.
          // Invalidate senders and replace the transport without awaiting it.
          this.signalingServices.forEach((service) =>
            service.setStatus("disconnected"),
          );
          this.releaseSocket(socket, false);
          this.setStatus("disconnected");
          this.startReconnect();
        },
      );
    }
  }

  private handleSocketClose(
    socket: WebSocket,
    generation: number,
    event: CloseEvent,
  ): void {
    if (!this.isCurrentConnection(socket, generation)) {
      return;
    }

    if (
      (event.code === 1000 || event.code === 1008) &&
      [
        "Session resumed elsewhere",
        "Session replaced",
        "Stale client session",
      ].includes(event.reason)
    ) {
      // Reconnecting here would evict the new owner and start a takeover loop.
      this.handleSessionReplaced();
      return;
    }

    const details = {
      clientId: this.client.clientId,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
    };
    if (this.reconnectAttempts > 0) {
      console.debug(
        "[WebSocketClientService] retry socket closed",
        details,
      );
    } else {
      console.warn(
        "[WebSocketClientService] socket closed",
        details,
      );
    }
    this.socket = null;
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.socketController?.abort();
      this.socketController = null;
    }
    if (this.joiningSocket === socket) {
      this.joiningSocket = null;
      this.bufferedSignals = [];
    }
    this.setStatus("disconnected");

    if (!this.closed) {
      this.startReconnect();
    }
  }

  private releaseSocket(
    socket: WebSocket | null,
    sendLeave: boolean,
  ): void {
    if (!socket) return;

    if (this.socket === socket) {
      this.socket = null;
    }
    if (this.activeSocket === socket) {
      this.activeSocket = null;
      this.socketController?.abort();
      this.socketController = null;
    }
    if (this.joiningSocket === socket) {
      this.joiningSocket = null;
      this.bufferedSignals = [];
    }

    if (sendLeave && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(
          encodeSignalingEnvelope({
            type: "leave",
            data: createClientPresence(this.client),
          }),
        );
      } catch (error) {
        console.warn(
          "[WebSocketClientService] failed to send leave:",
          error,
        );
      }
    }

    if (
      socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING
    ) {
      try {
        socket.close(1000, sendLeave ? "Left" : "Reset");
      } catch (error) {
        console.warn(
          "[WebSocketClientService] failed to close socket:",
          error,
        );
      }
    }
  }

  private async connectSocket(
    resume: boolean,
    generation: number,
    signal: AbortSignal,
  ): Promise<JoinedSocket> {
    const wsUrl = await this.createWebSocketUrl(signal);
    if (signal.aborted || this.closed) {
      throw abortError(
        "[WebSocketClientService] connection aborted",
      );
    }

    const socket = new WebSocket(wsUrl);
    if (
      this.connectionGeneration !== generation ||
      this.closed
    ) {
      socket.close(1000, "Stale connection");
      throw abortError(
        "[WebSocketClientService] stale connection",
      );
    }
    this.socket = socket;

    return new Promise<JoinedSocket>((resolve, reject) => {
      let settled = false;
      let handlingConnected = false;
      let joinStarted = false;
      let joinAckTimer: ReturnType<
        typeof setTimeout
      > | null = null;
      const connectionTimer = setTimeout(() => {
        fail(
          new Error(
            "[WebSocketClientService] connection timeout",
          ),
        );
      }, WEBSOCKET_CONNECTION_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(connectionTimer);
        if (joinAckTimer !== null) {
          clearTimeout(joinAckTimer);
          joinAckTimer = null;
        }
        signal.removeEventListener("abort", handleAbort);
      };
      const succeed = (resumed?: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ socket, resumed });
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const handleAbort = () => {
        fail(
          abortError(
            "[WebSocketClientService] connection aborted",
          ),
        );
      };

      signal.addEventListener("abort", handleAbort, {
        once: true,
      });
      socket.addEventListener(
        "error",
        () => {
          fail(
            new Error(
              "[WebSocketClientService] socket connection error",
            ),
          );
        },
        { once: true, signal },
      );
      socket.addEventListener(
        "close",
        (event) => {
          fail(
            new Error(
              `[WebSocketClientService] socket closed ${event.code} ${event.reason}`,
            ),
          );
        },
        { once: true, signal },
      );
      socket.addEventListener(
        "message",
        async (event) => {
          if (settled) return;

          const [parseError, message] = catchErrorSync(() =>
            parseSignalingEnvelope(String(event.data)),
          );
          if (parseError) {
            fail(parseError);
            return;
          }
          if (message.type === "error") {
            fail(new Error(String(message.data)));
            return;
          }
          if (message.type === "joined") {
            if (!joinStarted) {
              fail(
                new Error(
                  "[WebSocketClientService] received join acknowledgement before join",
                ),
              );
              return;
            }
            if (
              !isSignalingJoinAcknowledgement(message.data)
            ) {
              fail(
                new Error(
                  "[WebSocketClientService] invalid join acknowledgement",
                ),
              );
              return;
            }
            succeed(message.data.resumed);
            return;
          }
          if (
            message.type !== "connected" ||
            handlingConnected ||
            joinStarted
          ) {
            return;
          }

          handlingConnected = true;
          try {
            await this.validateRoomPassword(message.data);
            if (
              signal.aborted ||
              !this.isCurrentConnection(socket, generation)
            ) {
              throw abortError(
                "[WebSocketClientService] stale handshake",
              );
            }

            this.activateSocket(socket, generation);
            joinStarted = true;
            clearTimeout(connectionTimer);
            joinAckTimer = setTimeout(() => {
              if (!this.warnedLegacyJoinAck) {
                this.warnedLegacyJoinAck = true;
                console.warn(
                  "[WebSocketClientService] signaling server does not acknowledge joins; using legacy fallback",
                );
              }
              succeed();
            }, WEBSOCKET_JOIN_ACK_TIMEOUT_MS);
            socket.send(
              encodeSignalingEnvelope({
                type: "join",
                data: createClientPresence(
                  this.client,
                  resume,
                ),
              }),
            );
          } catch (error) {
            fail(toError(error));
          } finally {
            handlingConnected = false;
          }
        },
        { signal },
      );
    });
  }

  private initialize(resume = false): Promise<WebSocket> {
    if (this.closed) {
      return Promise.reject(
        new Error(
          "[WebSocketClientService] service is closed",
        ),
      );
    }
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.status === "connected"
    ) {
      return Promise.resolve(this.socket);
    }
    if (this.connectPromise) return this.connectPromise;

    this.releaseSocket(this.socket, false);
    const generation = ++this.connectionGeneration;
    const controller = new AbortController();
    this.connectController = controller;
    this.setStatus("connecting");

    const promise = this.connectSocket(
      resume,
      generation,
      controller.signal,
    )
      .then(({ socket, resumed }) => {
        if (
          !this.isCurrentConnection(socket, generation) ||
          socket.readyState !== WebSocket.OPEN
        ) {
          throw abortError(
            "[WebSocketClientService] stale connection",
          );
        }
        this.hasConnected = true;
        this.setStatus("connected");
        if (!this.isCurrentConnection(socket, generation)) {
          throw abortError(
            "[WebSocketClientService] stale connection",
          );
        }
        // Membership callbacks may synchronously create senders. Publish
        // readiness before rebinding existing senders or replaying any joins.
        this.completeRoomJoin(
          socket,
          resume && resumed === false,
        );
        console.info(
          "[WebSocketClientService] room signaling ready",
          {
            clientId: this.client.clientId,
            reconnect: resume,
            resumed: resumed ?? null,
            generation,
          },
        );
        return socket;
      })
      .catch((error: unknown) => {
        if (this.connectionGeneration === generation) {
          this.releaseSocket(this.socket, false);
          if (!this.closed) {
            this.setStatus("disconnected");
          }
        }
        throw toError(error);
      })
      .finally(() => {
        controller.abort();
        if (this.connectController === controller) {
          this.connectController = null;
        }
        if (this.connectPromise === promise) {
          this.connectPromise = null;
        }
      });

    this.connectPromise = promise;
    return promise;
  }

  private startReconnect(): void {
    if (this.closed || this.reconnectPromise) return;

    const controller = new AbortController();
    this.reconnectController = controller;
    const promise = this.runReconnect(controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !this.closed) {
          console.error(
            "[WebSocketClientService] reconnect loop failed:",
            error,
          );
        }
      })
      .finally(() => {
        if (this.reconnectController === controller) {
          this.reconnectController = null;
        }
        if (this.reconnectPromise === promise) {
          this.reconnectPromise = null;
        }

        // A socket can close after the reconnect attempt resolves but
        // before this loop releases ownership. Do not lose that close.
        if (
          !this.closed &&
          this.hasConnected &&
          this.status !== "connected"
        ) {
          queueMicrotask(() => this.startReconnect());
        }
      });

    this.reconnectPromise = promise;
  }

  private async runReconnect(
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !this.closed) {
      if (this.reconnectAttempts > 0) {
        const delay = getReconnectDelayMs(
          this.reconnectAttempts,
        );
        await waitForReconnect(delay, signal);
      } else if (
        typeof navigator !== "undefined" &&
        navigator.onLine === false
      ) {
        await waitForReconnect(0, signal);
      }

      if (signal.aborted || this.closed) return;

      try {
        await this.initialize(true);
        this.reconnectAttempts = 0;
        return;
      } catch (error) {
        if (signal.aborted || this.closed) return;
        this.reconnectAttempts++;
        // Preserve the first failure, not a new warning for every retry.
        if (this.reconnectAttempts === 1) {
          console.warn(
            "[WebSocketClientService] reconnect failed; retrying",
            { clientId: this.client.clientId },
            error,
          );
        } else {
          console.debug(
            `[WebSocketClientService] reconnect attempt ${this.reconnectAttempts} failed`,
            error,
          );
        }
      }
    }
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

    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      this.status !== "connected"
    ) {
      throw new Error(
        "[WebSocketClientService] socket is not connected",
      );
    }
    service = new WebSocketSignalingService(
      this.socket,
      this.client.clientId,
      targetClientId,
      this.password,
    );
    this.signalingServices.set(targetClientId, service);

    const pending =
      this.pendingPeerSignals.get(targetClientId) ?? [];
    this.pendingPeerSignals.delete(targetClientId);
    pending.forEach((signal) => {
      void service.handleIncomingSignal(signal);
    });
    return service;
  }

  removeSender(targetClientId: string) {
    const service =
      this.signalingServices.get(targetClientId);
    if (service) {
      service.close();
      this.signalingServices.delete(targetClientId);
    }
    this.pendingPeerSignals.delete(targetClientId);
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

  private handleSessionReplaced(local = false): void {
    if (this.closed) return;
    console.info(
      "[WebSocketClientService] session replaced",
      {
        clientId: this.client.clientId,
        source: local ? "local-tab" : "server",
      },
    );
    this.close();
    this.onNotice?.(
      local ? "tab-replaced" : "session-replaced",
    );
  }

  createClient(
    options: ClientJoinOptions = {},
  ): Promise<void> {
    if (this.createPromise) return this.createPromise;
    const promise = (async () => {
      try {
        if (!this.releaseRoomLock) {
          this.releaseRoomLock =
            await acquireRoomConnectionLock(
              roomConnectionLockName(
                this.websocketUrl,
                this.roomId,
                this.client.clientId,
              ),
              this.lifecycleController.signal,
              {
                takeover: options.takeover,
                onReplaced: () =>
                  this.handleSessionReplaced(true),
              },
            );
        }
        await this.initialize();
      } catch (error) {
        this.releaseRoomLock?.();
        this.releaseRoomLock = null;
        throw error;
      }
    })().finally(() => {
      if (this.createPromise === promise)
        this.createPromise = null;
    });
    this.createPromise = promise;
    return promise;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connectionGeneration++;
    this.lifecycleController.abort();
    this.reconnectController?.abort();
    this.reconnectController = null;
    this.connectController?.abort();
    this.connectController = null;

    this.signalingServices.forEach((service) =>
      service.close(),
    );
    this.signalingServices.clear();
    this.pendingPeerSignals.clear();
    this.peers.clear();
    this.releaseSocket(this.socket, true);
    this.releaseRoomLock?.();
    this.releaseRoomLock = null;
    this.eventListeners.clear();
    this.setStatus("disconnected");
  }

  private emit(event: string, data: unknown) {
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
