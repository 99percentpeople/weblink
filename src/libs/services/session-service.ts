import { produce, reconcile } from "solid-js/store";
import { PeerSession } from "../core/session";
import { Client, ClientID, ClientInfo } from "../core/type";
import {
  ClientService,
  TransferClient,
} from "../core/services/type";
import { Accessor, createEffect } from "solid-js";
import {
  type SendClipboardMessage,
  type StorageMessage,
} from "@/libs/services/rtc-protocol";
import { getIceServers } from "@/libs/core/store";
import { catchError, catchErrorSync } from "../catch";
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
      options.loadIceServers ?? getIceServers;
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

  setStorage(message: StorageMessage) {
    setAppState(
      "session",
      "clientViewData",
      message.client,
      produce((state) => {
        state.storage = [...(message.data ?? [])];
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
      console.warn(
        `client service already set, destory old service`,
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
    const session = this.sessions[target];
    if (!session) {
      console.log(
        `can not destory session, session ${target} not found`,
      );
      return;
    }

    session.close();
    this.detachSession(target, session);
  }

  async addClient(client: TransferClient) {
    if (!this.service) {
      throw new Error(
        `can not add client: ${client.clientId}, client service not found`,
      );
    }
    if (this.sessions[client.clientId]) {
      throw new Error(
        `client ${client.clientId} has already created`,
      );
    }
    const polite =
      this.service.info.createdAt < client.createdAt;
    const sender = this.service.createSender(
      client.clientId,
    );
    if (!sender) {
      throw new Error(
        `can not create sender for client: ${client.clientId}`,
      );
    }
    const session = new PeerSession(sender, {
      polite,
      iceServers: await this.iceServers,
      relayOnly:
        appState.options.servers.turns.length > 0 &&
        appState.options.relayOnly,
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
        console.log(`session status change`, ev.detail);
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
                      .then(() => {
                        console.log(
                          `set audio parameters success, encoding:`,
                          audioParameters.encodings?.[0],
                        );
                      })
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
                      .then(() => {
                        console.log(
                          `set video parameters success, encoding:`,
                          videoParameters.encodings?.[0],
                        );
                      })
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
