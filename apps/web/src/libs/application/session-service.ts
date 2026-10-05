import { resolveRemoteKeyboardOptions } from "../domain/remote-control/keyboard-options";
import { platform } from "@/libs/platform/runtime";
import { RemoteControlHost } from "./remote-control-host";
import {
  NativeScreenSession,
  NATIVE_SCREEN_CHANNEL,
} from "../domain/native-screen/session";
import { readVideoStatistics } from "./video-statistics-service";
import type { VideoStatsBatch } from "../domain/video-stats";
import {
  browserMediaStream,
  getNativeScreenPublication,
} from "./native-screen-service";
import { produce, reconcile } from "solid-js/store";
import { PeerSession } from "../domain/session";
import type { Client } from "@/libs/domain/client";
import {
  createUuid,
  type ClientID,
} from "@/libs/domain/ids";
import type { ClientInfo } from "@/libs/state/app-state";
import type {
  ClientService,
  TransferClient,
} from "../domain/client";
import {
  Accessor,
  createEffect,
  createRoot,
  on,
} from "solid-js";
import { setClientConfig } from "@/libs/state/permission-options";
import { type SendClipboardMessage } from "@/libs/domain/protocol/messages";
import { loadSessionIceServers } from "./ice-server-service";
import { catchError, catchErrorSync } from "@/libs/catch";
import {
  getMeetingAudioSource,
  getMeetingVideoSourceKind,
} from "./meeting-media-service";
import type { SignalingService } from "../domain/signaling";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

export interface SessionServiceOptions {
  loadIceServers?: () => Promise<RTCIceServer[]>;
}

export class SessionService {
  readonly remoteControl = new RemoteControlHost(
    platform,
    {
      decision: (id) =>
        appState.options.clientConfigs[id]?.remoteControl,
      remember: (id, remoteControl) =>
        setClientConfig(id, {
          name: this.clientViewData[id]?.name ?? id,
          remoteControl,
        }),
    },
    () =>
      resolveRemoteKeyboardOptions(
        appState.options.remoteKeyboard,
      ).emergencyShortcut,
  );
  getScreenControl(clientId: string) {
    return this.nativeScreens.get(this.sessions[clientId])
      ?.screenControl;
  }
  getRemoteControl(track: MediaStreamTrack) {
    for (const native of this.nativeScreens.values()) {
      const control = native.getRemoteControl(track);
      if (control) return control;
    }
  }
  reportNativeDecodeFailure(track: MediaStreamTrack) {
    for (const native of this.nativeScreens.values())
      native.decodeFailed(track);
  }
  readonly sessions: Record<ClientID, PeerSession> =
    appState.session.sessions;
  readonly clientViewData: Record<ClientID, ClientInfo> =
    appState.session.clientViewData;
  private service?: ClientService;
  private nativeScreens = new Map<
    PeerSession,
    NativeScreenSession
  >();

  getVideoStats(
    track: MediaStreamTrack,
  ): Promise<VideoStatsBatch[]> {
    return readVideoStatistics(
      track,
      Object.values(this.sessions).map((session) => ({
        pc: session.peerConnection,
        native: this.nativeScreens.get(session),
        name:
          this.clientViewData[session.clientId]?.name ??
          session.clientId,
      })),
    );
  }

  setStream(stream: MediaStream | null) {
    for (const session of Object.values(this.sessions))
      this.setSessionStream(session, stream);
  }

  /** Initial room binding and later capture changes must use the same path. */
  setSessionStream(
    session: PeerSession,
    stream: MediaStream | null,
  ) {
    const tracks = stream?.getTracks() ?? [];
    const publications = tracks.flatMap((track) => {
      const publication = getNativeScreenPublication(track);
      return publication ? [publication] : [];
    });
    const browserStream = browserMediaStream(stream);
    session.setStream(browserStream);
    this.nativeScreens
      .get(session)
      ?.setPublications(publications);
  }
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

  private readonly loadIceServers: () => Promise<
    RTCIceServer[]
  >;

  constructor(options: SessionServiceOptions = {}) {
    this.loadIceServers =
      options.loadIceServers ??
      (() =>
        loadSessionIceServers(appState.options.servers));
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
    setClientConfig(client.clientId, { name: client.name });

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
    this.remoteControl.start();

    cs.addEventListener("statuschange", (ev) => {
      setAppState(
        "session",
        "clientServiceStatus",
        ev.detail,
      );
    });
  }

  removeService() {
    this.remoteControl.close();
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
      iceServers = await this.loadIceServers();
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
      loadIceServers: this.loadIceServers,
      relayOnly: appState.options.relayOnly,
      getRuntimeOptions: () => ({
        ordered: appState.options.ordered,
        preferredVideoCodec:
          appState.options.preferredVideoCodec,
        preferredAudioCodec:
          appState.options.preferredAudioCodec,
      }),
      getVideoSourceKind: getMeetingVideoSourceKind,
      getAudioSource: getMeetingAudioSource,
    });

    const controller = new AbortController();
    let controlGeneration = createUuid();
    const native = new NativeScreenSession({
      loadControlCapabilities: () =>
        this.remoteControl.capabilities(client.clientId),
      requestScreen: (signal) =>
        this.remoteControl.requestScreen(
          client.clientId,
          controlGeneration,
          signal,
        ),
      cancelScreenRequest: () =>
        this.remoteControl.screen.cancelPeer(
          client.clientId,
          controlGeneration,
        ),
      controlContext: () =>
        this.remoteControl.context(
          controlGeneration,
          client.clientId,
        ),
      loadIceServers: this.loadIceServers,
      relayOnly: () => appState.options.relayOnly,
      viewsChanged: (views) => {
        if (
          this.sessions[client.clientId] === session &&
          this.clientViewData[client.clientId]
        )
          setAppState(
            "session",
            "clientViewData",
            client.clientId,
            "nativeScreenViews",
            reconcile(views),
          );
      },
      channelClosed: () => {
        opening = false;
        controlGeneration = createUuid();
        clearTimeout(nativeReopenTimer);
        if (!controller.signal.aborted)
          nativeReopenTimer = setTimeout(openNative, 1000);
      },
      changed: (stream) => {
        if (
          this.sessions[client.clientId] === session &&
          this.clientViewData[client.clientId]
        )
          setAppState(
            "session",
            "clientViewData",
            client.clientId,
            "nativeScreenStream",
            reconcile(stream ?? undefined),
          );
      },
      error: (error) =>
        console.error("Native screen connection", error),
    });
    this.nativeScreens.set(session, native);
    const disposePolicy = createRoot((dispose) => {
      createEffect(
        on(
          [
            () =>
              appState.options.clientConfigs[
                client.clientId
              ]?.remoteControl,
            this.remoteControl.revision,
          ],
          ([, ownerRevision], previous) => {
            const ownerChanged =
              previous !== undefined &&
              ownerRevision !== previous[1];
            void (async () => {
              await this.remoteControl.policyChanged(
                client.clientId,
              );
              await native.refreshControlCapabilities(
                ownerChanged,
              );
            })().catch((error) =>
              console.warn(
                "Remote control permissions",
                error,
              ),
            );
          },
          { defer: true },
        ),
      );
      return dispose;
    });
    let opening = false;
    let mainChannelReady = false;
    let nativeReopenTimer:
      | ReturnType<typeof setTimeout>
      | undefined;
    const openNative = () => {
      if (
        !session.polite ||
        controller.signal.aborted ||
        !mainChannelReady ||
        opening ||
        !session.peerConnection
      )
        return;
      opening = true;
      try {
        native.bind(
          session.peerConnection.createDataChannel(
            NATIVE_SCREEN_CHANNEL,
            {
              protocol: NATIVE_SCREEN_CHANNEL,
              ordered: true,
            },
          ),
        );
      } catch (error) {
        opening = false;
        console.debug(
          "Native screen channel unavailable",
          error,
        );
        if (!controller.signal.aborted)
          nativeReopenTimer = setTimeout(openNative, 2000);
      }
    };
    session.addEventListener(
      "channel",
      ({ detail }) => {
        if (
          detail.label === NATIVE_SCREEN_CHANNEL &&
          detail.protocol === NATIVE_SCREEN_CHANNEL
        )
          native.bind(detail);
      },
      { signal: controller.signal },
    );
    session.addEventListener(
      "peerconnectioninit",
      () => {
        opening = false;
        mainChannelReady = false;
        clearTimeout(nativeReopenTimer);
        native.reset();
        controlGeneration = createUuid();
      },
      { signal: controller.signal },
    );
    session.addEventListener(
      "messagechannelchange",
      ({ detail }) => {
        mainChannelReady = detail === "ready";
        if (detail === "ready") void openNative();
        else {
          opening = false;
          clearTimeout(nativeReopenTimer);
          native.reset();
          controlGeneration = createUuid();
        }
      },
      { signal: controller.signal },
    );
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(nativeReopenTimer);
        disposePolicy();
        native.reset();
        controlGeneration = createUuid();
        this.nativeScreens.delete(session);
      },
      { once: true },
    );

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
    setClientConfig(client.clientId, { name: client.name });

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
      "remotevideotrackschange",
      (ev) => {
        setAppState(
          "session",
          "clientViewData",
          client.clientId,
          "videoTracks",
          ev.detail.map((binding) => ({ ...binding })),
        );
      },
      { signal: controller.signal },
    );

    session.addEventListener(
      "remoteaudiotrackschange",
      (ev) => {
        setAppState(
          "session",
          "clientViewData",
          client.clientId,
          "audioTracks",
          ev.detail.map((binding) => ({ ...binding })),
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
    this.remoteControl.close();
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
