import { produce, reconcile } from "solid-js/store";
import { PeerSession } from "../domain/session";
import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type { ClientInfo } from "@/libs/state/app-state";
import type {
  ClientService,
  TransferClient,
} from "../domain/client";
import { Accessor, createEffect } from "solid-js";
import { type SendClipboardMessage } from "@/libs/domain/protocol/messages";
import { getIceServers } from "@/libs/domain/ice-server";
import { catchError, catchErrorSync } from "@/libs/catch";
import type { SignalingService } from "../domain/signaling";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

export interface SessionServiceOptions {
  loadIceServers?: () => Promise<RTCIceServer[]>;
}

export class SessionService {
  readonly sessions: Record<ClientID, PeerSession> =
    appState.session.sessions;
  readonly clientViewData: Record<ClientID, ClientInfo> =
    appState.session.clientViewData;
  private service?: ClientService;
  private pendingClients = new Map<
    ClientID,
    SignalingService
  >();

  get clientService() {
    return this.service;
  }

  clientServiceStatus: Accessor<
    "connecting" | "connected" | "disconnected"
  > = () => appState.session.clientServiceStatus;

  iceServers: Promise<RTCIceServer[]>;
  private readonly loadIceServers: () => Promise<
    RTCIceServer[]
  >;

  constructor(options: SessionServiceOptions = {}) {
    this.loadIceServers =
      options.loadIceServers ??
      (() => getIceServers(appState.options.servers));
    this.iceServers = this.loadIceServers();
  }

  updateIceServers() {
    this.iceServers = this.loadIceServers();
  }

  setClipboard(message: SendClipboardMessage) {
    setAppState(
      "session",
      "clientViewData",
      message.client,
      produce((state) => {
        state.clipboard = [
          ...(state.clipboard ?? []),
          message,
        ];
      }),
    );
  }

  updateClientProfile(client: Client) {
    const view = this.clientViewData[client.clientId];
    if (!view) return false;

    setAppState(
      "session",
      "clientViewData",
      client.clientId,
      produce((state) => {
        state.name = client.name;
        state.avatar = client.avatar;
      }),
    );
    return true;
  }

  setClientService(cs: ClientService) {
    if (this.service) {
      console.debug(
        "[SessionService] replacing client service",
      );
      this.removeService();
    }
    this.service = cs;

    cs.addEventListener("statuschange", (ev) => {
      setAppState(
        "session",
        "clientServiceStatus",
        ev.detail,
      );
    });
  }

  removeService() {
    this.pendingClients.clear();
    this.service?.close();
    this.service = undefined;
    setAppState(
      "session",
      "clientServiceStatus",
      "disconnected",
    );
  }

  private detachSession(
    target: ClientID,
    session: PeerSession,
  ) {
    if (this.sessions[target] !== session) return;

    this.service?.removeSender(target);
    setAppState(
      "session",
      "clientViewData",
      target,
      undefined!,
    );
    setAppState("session", "sessions", target, undefined!);
  }

  removeSession(target: ClientID) {
    if (this.pendingClients.delete(target))
      this.service?.removeSender(target);
    const session = this.sessions[target];
    if (!session) {
      console.debug(
        `[SessionService] session ${target} already removed`,
      );
      return;
    }

    session.close();
    this.detachSession(target, session);
  }

  async addClient(client: TransferClient) {
    const service = this.service;
    if (!service) {
      throw new Error(
        `can not add client: ${client.clientId}, client service not found`,
      );
    }
    if (
      this.sessions[client.clientId] ||
      this.pendingClients.has(client.clientId)
    ) {
      throw new Error(
        `client ${client.clientId} has already created`,
      );
    }
    const polite =
      service.info.createdAt < client.createdAt ||
      (service.info.createdAt === client.createdAt &&
        service.info.clientId < client.clientId);
    const sender = service.createSender(client.clientId);
    if (!sender) {
      throw new Error(
        `can not create sender for client: ${client.clientId}`,
      );
    }

    this.pendingClients.set(client.clientId, sender);
    let iceServers: RTCIceServer[];
    try {
      iceServers = await this.iceServers;
    } catch (error) {
      if (
        this.pendingClients.get(client.clientId) === sender
      ) {
        this.pendingClients.delete(client.clientId);
        service.removeSender(client.clientId);
      }
      throw error;
    }
    const ownsPending =
      this.pendingClients.get(client.clientId) === sender;
    if (ownsPending)
      this.pendingClients.delete(client.clientId);
    if (
      this.service !== service ||
      !ownsPending ||
      sender.status === "closed" ||
      this.sessions[client.clientId]
    ) {
      sender.close();
      throw new DOMException(
        "Client service changed while creating the session",
        "AbortError",
      );
    }

    const session = new PeerSession(sender, {
      polite,
      iceServers,
      relayOnly:
        appState.options.servers.turns.length > 0 &&
        appState.options.relayOnly,
      getRuntimeOptions: () => ({
        ordered: appState.options.ordered,
        preferredVideoCodec:
          appState.options.preferredVideoCodec,
        preferredAudioCodec:
          appState.options.preferredAudioCodec,
      }),
    });

    setAppState(
      "session",
      "clientViewData",
      client.clientId,
      {
        ...client,
        onlineStatus: "offline",
        messageChannel: false,
      } satisfies ClientInfo,
    );
    setAppState(
      "session",
      "sessions",
      client.clientId,
      session,
    );

    const controller = new AbortController();

    session.addEventListener(
      "peerconnectioninit",
      (ev) => {
        const pc = ev.detail;
        pc.getSenders().forEach((sender) => {
          switch (sender.track?.kind) {
            case "audio": {
              const audioParameters = changeAudioEncoding(
                sender.getParameters(),
              );
              if (audioParameters) {
                sender
                  .setParameters(audioParameters)
                  .catch((e) => {
                    console.error(
                      `set audio parameters error: ${e}`,
                    );
                  });
              }
              break;
            }
            case "video": {
              const videoParameters = changeVideoEncoding(
                sender.getParameters(),
              );
              if (videoParameters) {
                sender
                  .setParameters(videoParameters)
                  .catch((e) => {
                    console.error(
                      `set video parameters error: ${e}`,
                    );
                  });
              }
              break;
            }
          }
        });
      },
      { signal: controller.signal },
    );

    session.addEventListener(
      "statuschange",
      (ev) => {
        switch (ev.detail) {
          case "created":
            break;
          case "connecting":
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "onlineStatus",
              "connecting",
            );
            break;
          case "connected":
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "onlineStatus",
              this.clientViewData[client.clientId]
                ?.messageChannel
                ? "online"
                : "connecting",
            );
            break;
          case "reconnecting":
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "onlineStatus",
              "reconnecting",
            );
            break;
          case "disconnected":
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "onlineStatus",
              "offline",
            );
            break;
          case "closed":
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "onlineStatus",
              "offline",
            );
            controller.abort();
            this.detachSession(client.clientId, session);
            break;
        }
      },
      { signal: controller.signal },
    );

    session.addEventListener(
      "error",
      (ev) => {
        console.error(
          `session ${client.clientId} error`,
          ev.detail,
        );
      },
      { signal: controller.signal },
    );

    session.addEventListener(
      "remotestreamchange",
      (ev) => {
        setAppState(
          "session",
          "clientViewData",
          client.clientId,
          "stream",
          reconcile(ev.detail ?? undefined),
        );
      },
      { signal: controller.signal },
    );

    session.addEventListener(
      "messagechannelchange",
      (ev) => {
        const view = this.clientViewData[client.clientId];
        if (!view) return;

        const ready = ev.detail === "ready";

        setAppState(
          "session",
          "clientViewData",
          client.clientId,
          "messageChannel",
          ready,
        );

        if (!ready) {
          if (view.onlineStatus === "online") {
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "onlineStatus",
              "reconnecting",
            );
          }
          return;
        }

        if (
          session.peerConnection?.connectionState ===
          "connected"
        ) {
          setAppState(
            "session",
            "clientViewData",
            client.clientId,
            "onlineStatus",
            "online",
          );
        }
      },
      { signal: controller.signal },
    );

    return session;
  }

  destoryAllSession() {
    this.pendingClients.clear();
    Object.values(this.sessions).forEach((session) =>
      session.close(),
    );
    setAppState("session", "sessions", reconcile({}));
    setAppState("session", "clientViewData", reconcile({}));

    this.service?.close();
    this.service = undefined;
    setAppState(
      "session",
      "clientServiceStatus",
      "disconnected",
    );
  }
}

export let sessionService: SessionService;

export function createSessionService() {
  if (!sessionService) {
    sessionService = new SessionService();

    createEffect(() => {
      appState.options.servers.turns.length;
      sessionService.updateIceServers();
    });

    createEffect(() => {
      appState.options.videoMaxBitrate;
      appState.options.degradationPreference;
      Object.values(sessionService.sessions).forEach(
        (session) => {
          session.peerConnection
            ?.getSenders()
            .forEach((sender) => {
              switch (sender.track?.kind) {
                case "audio":
                  const audioParameters =
                    changeAudioEncoding(
                      sender.getParameters(),
                    );
                  if (audioParameters) {
                    sender
                      .setParameters(audioParameters)
                      .catch((e) => {
                        console.error(
                          `set audio parameters error: ${e}`,
                        );
                      });
                  }
                  break;
                case "video":
                  const videoParameters =
                    changeVideoEncoding(
                      sender.getParameters(),
                    );
                  if (videoParameters) {
                    sender
                      .setParameters(videoParameters)
                      .catch((e) => {
                        console.error(
                          `set video parameters error: ${e}`,
                        );
                      });
                  }
                  break;
              }
            });
        },
      );
    });
  }

  return sessionService;
}

function changeAudioEncoding(
  parameters: RTCRtpSendParameters,
): RTCRtpSendParameters | null {
  if (!parameters.encodings) {
    parameters.encodings = [{ active: true }];
  }
  const encoding = parameters.encodings[0] ?? {};
  encoding.active = true;
  // encoding.maxBitrate = appState.options.audioMaxBitrate;
  encoding.priority = "high";
  encoding.networkPriority = "high";
  return parameters;
}

function changeVideoEncoding(
  parameters: RTCRtpSendParameters,
): RTCRtpSendParameters | null {
  parameters.degradationPreference =
    appState.options.degradationPreference ?? "balanced";
  if (!parameters.encodings) {
    parameters.encodings = [{ active: true }];
  }
  const encoding = parameters.encodings[0] ?? {};
  encoding.active = true;
  encoding.maxBitrate = appState.options.videoMaxBitrate;
  encoding.priority = "high";
  encoding.networkPriority = "high";
  return parameters;
}
