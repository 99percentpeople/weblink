import { scopes } from "@weblink/automation";
import type { NativeAutomationPeer } from "@weblink/platform";
import { PeerTrustService } from "./peer-trust";
import { bootstrapMessage } from "../domain/device-identity/access";
import { resolveRemoteKeyboardOptions } from "../domain/remote-control/keyboard-options";
import type { EncodedVideoSource } from "@/libs/domain/encoded-video";
import {
  browserCodecs,
  commonCodecs,
} from "../domain/media-codecs";
import { platform } from "@/libs/platform/runtime";
import { RemoteControlHost } from "./remote-control-host";
import { PeerCapabilitiesService } from "./peer-capabilities";
import { requiredMessageFeatures } from "../domain/protocol/protocol-versions";
import { browserDecodeCapabilities } from "../domain/media-codecs";
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
  createSignal,
  on,
  untrack,
} from "solid-js";
import {
  resetClientConfig,
  setClientConfig,
} from "@/libs/state/permission-options";
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
  readonly trust = new PeerTrustService({
    quarantine: (id) =>
      setClientConfig(id, {
        remoteControl: "deny",
        automation: Object.fromEntries(
          scopes.map((scope) => [scope, "deny" as const]),
        ),
        provideFileList: false,
        shareScreen: false,
        receiveContent: false,
      }),
    paired: resetClientConfig,
  });
  canReceive(id: string): boolean {
    return (
      this.trust.trusted(id) &&
      appState.options.clientConfigs[id]?.receiveContent ===
        true
    );
  }
  canShareScreen(id: string): boolean {
    return (
      this.trust.trusted(id) &&
      appState.options.clientConfigs[id]?.shareScreen ===
        true
    );
  }
  private requestedStreams = new Map<
    PeerSession,
    MediaStream | null
  >();
  private readonly speedBusy = createSignal(false);
  private readonly automationEnabled = createSignal(false);
  private readonly diagnosticsReady = createSignal(false);
  private readonly automationController =
    createSignal<NativeAutomationPeer | null>(null);
  setAutomationEnabled(enabled: boolean): void {
    this.automationEnabled[1](enabled);
    if (!enabled) this.automationController[1](null);
  }
  setDiagnosticsReady(ready: boolean): void {
    this.diagnosticsReady[1](ready);
  }
  setAutomationController(
    controller: NativeAutomationPeer | null,
  ): void {
    this.automationController[1](controller);
  }
  private automationControlActive(
    session: PeerSession,
  ): boolean {
    const controller = this.automationController[0]();
    return (
      !!controller &&
      controller.id === session.targetClientId &&
      controller.generation ===
        this.capabilities.generation(session) &&
      this.canReceive(session.targetClientId)
    );
  }
  readonly capabilities = new PeerCapabilitiesService(
    (session) => ({
      identity: {
        receiveContent: this.canReceive(
          session.targetClientId,
        ),
      },
      messaging: {},
      ...(this.diagnosticsReady[0]()
        ? {
            automation: {
              diagnostics: true,
              controlActive:
                this.automationEnabled[0]() &&
                this.automationControlActive(session),
            },
          }
        : {}),
      fileDrop: platform.fileDrop?.hover
        ? { hover: true, hoverUpdates: true }
        : {},
      files: { content: true, shared: true, queue: true },
      room: { chat: true, files: true },
      screen: {
        decode: browserDecodeCapabilities(),
        trickleIce: true,
        multiScreen: true,
      },
      ...(this.remoteControl.exposes(session.targetClientId)
        ? {
            control: this.remoteControl.capability(
              session.targetClientId,
            ),
          }
        : {}),
      clipboard: { inlineText: true },
      speedTest: { busy: this.speedBusy[0]() },
    }),
  );
  setSpeedTestBusy(busy: boolean): void {
    this.speedBusy[1](busy);
  }
  readonly remoteControl = new RemoteControlHost(
    platform,
    {
      whitelistOnly: () =>
        appState.options.remoteControlWhitelistOnly,
      decision: (id) =>
        this.canReceive(id) && this.canShareScreen(id)
          ? appState.options.clientConfigs[id]
              ?.remoteControl
          : "deny",
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
  private readonly browserEncoders = {
    video: browserCodecs("send", "video"),
    audio: browserCodecs("send", "audio"),
  };
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

  getRecordingVideoSources(
    track: MediaStreamTrack,
    audio: readonly MediaStreamTrack[] = [],
  ): EncodedVideoSource[] {
    return Object.values(this.sessions).flatMap(
      (session) => {
        return [
          ...session.getRecordingMediaSources(track, audio),
          ...(this.nativeScreens
            .get(session)
            ?.getRecordingMediaSources(track, audio) ?? []),
        ];
      },
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
    this.requestedStreams.set(session, stream);
    this.applySessionStream(session);
  }
  private applySessionStream(session: PeerSession) {
    const stream =
      this.canShareScreen(session.targetClientId) &&
      this.capabilities.get(session)?.identity
        ?.receiveContent === true
        ? this.requestedStreams.get(session)
        : null;
    const tracks = stream?.getTracks() ?? [];
    const publications = tracks.flatMap((track) => {
      const publication = getNativeScreenPublication(track);
      return publication ? [publication] : [];
    });
    const browserStream = browserMediaStream(
      stream ?? null,
    );
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

    const session: PeerSession = new PeerSession(sender, {
      acceptsContent: () =>
        this.canReceive(client.clientId),
      allowsApplication: () =>
        this.trust.trusted(client.clientId),
      acceptMessage: (message) =>
        bootstrapMessage(message.type) ||
        (this.canReceive(client.clientId) &&
          (!requiredMessageFeatures(message.type).includes(
            "control",
          ) ||
            this.remoteControl.exposes(client.clientId))),
      authorizeMessage: async (peer, message, signal) => {
        if (
          !bootstrapMessage(message.type) &&
          !this.trust.trusted(client.clientId)
        )
          throw new Error("DEVICE_UNTRUSTED");
        const features = requiredMessageFeatures(
          message.type,
        );
        if (features.length)
          return this.capabilities.require(
            peer,
            features,
            signal,
          );
      },
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
        automaticVideoCodecs: commonCodecs(
          "video",
          this.browserEncoders.video,
          [this.capabilities.get(session)?.screen?.decode],
        ),
        automaticAudioCodecs: commonCodecs(
          "audio",
          this.browserEncoders.audio,
          [this.capabilities.get(session)?.screen?.decode],
        ),
      }),
      getVideoSourceKind: getMeetingVideoSourceKind,
      getAudioSource: getMeetingAudioSource,
    });

    const controller = new AbortController();
    let controlGeneration = createUuid();
    let mainChannelReady = false;
    const native = new NativeScreenSession({
      clientId: session.clientId,
      loadControlCapabilities: () =>
        this.remoteControl.capabilities(client.clientId),
      acceptsControlRequests: () =>
        this.remoteControl.exposes(client.clientId),
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
          this.capabilities.generation(session),
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
        if (!controller.signal.aborted)
          queueMicrotask(() => openNative());
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
    const disposeTrust = this.trust.bind(session);
    const disposeCapabilities = this.capabilities.bind(
      session,
      (services) => {
        native.setRemoteCapabilities(services);
        session.refreshMediaCodecs();
        // Binding can publish before openNative is initialized.
        queueMicrotask(() => {
          this.applySessionStream(session);
          openNative();
          session.refreshAccess();
        });
      },
    );
    const disposePolicy = createRoot((dispose) => {
      createEffect(() =>
        this.capabilities.refresh(session),
      );
      createEffect(() => {
        const trust = this.trust.get(client.clientId);
        const exists =
          !!this.clientViewData[client.clientId];
        this.canReceive(client.clientId);
        this.canShareScreen(client.clientId);
        this.capabilities.get(session);
        untrack(() => {
          if (exists)
            setAppState(
              "session",
              "clientViewData",
              client.clientId,
              "trust",
              trust?.state,
            );
          this.applySessionStream(session);
          session.refreshAccess();
          if (!this.canReceive(client.clientId))
            native.reset();
          queueMicrotask(() => openNative());
        });
      });
      createEffect(
        on(
          [
            () => appState.options.preferredVideoCodec,
            () => appState.options.preferredAudioCodec,
          ],
          () => session.refreshMediaCodecs(),
          { defer: true },
        ),
      );
      createEffect(
        on(
          [
            () =>
              appState.options.clientConfigs[
                client.clientId
              ]?.remoteControl,
            this.remoteControl.revision,
            () =>
              appState.options.remoteControlWhitelistOnly,
            () => this.canReceive(client.clientId),
            () => this.canShareScreen(client.clientId),
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
    const openNative = () => {
      if (controller.signal.aborted) return;
      const capabilities = this.capabilities.get(session);
      if (
        !this.canReceive(client.clientId) ||
        capabilities?.identity?.receiveContent === false
      ) {
        opening = false;
        native.reset();
        return;
      }
      if (
        !session.polite ||
        !mainChannelReady ||
        !capabilities?.screen ||
        capabilities.identity?.receiveContent !== true ||
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
          native.reset();
          controlGeneration = createUuid();
        }
      },
      { signal: controller.signal },
    );
    controller.signal.addEventListener(
      "abort",
      () => {
        disposePolicy();
        disposeCapabilities();
        disposeTrust();
        this.requestedStreams.delete(session);
        mainChannelReady = false;
        native.dispose();
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
        trust: "verifying",
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
