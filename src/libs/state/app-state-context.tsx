import {
  Component,
  createContext,
  createEffect,
  createSignal,
  type Accessor,
  onCleanup,
  onMount,
  ParentProps,
  useContext,
} from "solid-js";
import type { ChunkMetaData } from "@/libs/cache";
import type { PeerSession } from "@/libs/core/session";
import type { ClientID, FileID } from "@/libs/core/ids";
import type { RoomStatus } from "@/libs/state/app-state";
import type {
  ClientService,
  ClientServiceInitOptions,
} from "@/libs/core/client";
import { cacheManager } from "@/libs/application/cache-service";
import { transferManager } from "@/libs/application/transfer/transfer-service";
import {
  appState,
  saveMediaConstraintsToSession,
  setAppState,
} from "@/libs/state/app-state";
import {
  resolveClientConfig,
  signalingWebSocketUrl,
} from "@/libs/state/app-options";
import { createRtcService } from "@/libs/application/rtc/rtc-service";
import {
  createRtcProtocol,
  type SendClipboardMessage,
} from "@/libs/application/rtc/rtc-protocol";
import { sessionService } from "@/libs/application/session-service";
import { PeerProfileService } from "@/libs/application/peer-profile-service";
import { PeerMessagingService } from "@/libs/application/messaging/peer-messaging-service";
import { FileTransferService } from "@/libs/application/transfer/file-transfer-service";
import { toast } from "solid-sonner";
import type { StoreMessage } from "@/libs/core/message";
import { messageStores } from "@/libs/application/messaging/message-store";
import { catchError } from "@/libs/catch";
import {
  SpeedTestService,
  type SpeedTestState,
} from "@/libs/application/speed-test-service";
import { createSpeedTestApproval } from "@/components/speed-test-approval";
import {
  createTaskService,
  type TaskService,
} from "@/libs/application/task-service";

async function getClientService(
  options: ClientServiceInitOptions,
): Promise<ClientService> {
  switch (import.meta.env.VITE_BACKEND) {
    case "FIREBASE":
      return import("@/libs/infrastructure/signaling/client/firebase-client-service").then(
        (m) => new m.FirebaseClientService(options),
      );
    case "WEBSOCKET":
      options.websocketUrl = signalingWebSocketUrl;
      return import("@/libs/infrastructure/signaling/client/ws-client-service").then(
        (m) => new m.WebSocketClientService(options),
      );
    default:
      throw Error("invalid backend type");
  }
}

export interface AppStateContextProps {
  joinRoom: () => Promise<void>;
  leaveRoom: () => void;
  requestFile: (
    target: ClientID,
    info: ChunkMetaData,
    resume?: boolean,
  ) => Promise<void>;
  sendText: (
    text: string,
    target: ClientID | ClientID[],
  ) => Promise<void>;
  sendFile: (
    file: File,
    target: ClientID | ClientID[],
  ) => Promise<void>;
  sendClipboard: (
    text: string,
    target: ClientID | ClientID[],
  ) => Promise<void>;
  requestStorage: (
    target: ClientID | ClientID[],
  ) => Promise<void>;
  retryMessage: (message: StoreMessage) => Promise<void>;
  shareFile: (fileId: FileID, target: ClientID) => void;
  resumeFile: (
    fileId: FileID,
    target: ClientID,
  ) => Promise<void>;
  pauseFile: (
    fileId: FileID,
    target: ClientID,
  ) => Promise<void>;
  tasks: TaskService;
  getSpeedTestState: (
    target: ClientID | null,
  ) => SpeedTestState | undefined;
  speedTestState: Accessor<SpeedTestState>;
  startSpeedTest: (target: ClientID) => Promise<void>;
  cancelSpeedTest: (target?: ClientID) => void;
  approveSpeedTest: (target: ClientID) => void;
  declineSpeedTest: (target: ClientID) => void;
  roomStatus: RoomStatus;
}

const AppStateContext = createContext<
  AppStateContextProps | undefined
>(undefined);

export const useAppState = (): AppStateContextProps => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error(
      "useAppState must be used within a AppStateProvider",
    );
  }
  return context;
};

export interface AppStateProviderProps extends ParentProps {
  localStream: MediaStream | null;
}

export const AppStateProvider: Component<
  AppStateProviderProps
> = (props) => {
  const rtc = createRtcService();
  const protocol = createRtcProtocol();
  const messaging = new PeerMessagingService(
    protocol,
    messageStores,
  );
  const files = new FileTransferService({
    protocol,
    rtc,
    registry: transferManager,
    caches: cacheManager,
    messages: messageStores,
    messaging,
    getSession: (peerId) => sessionService.sessions[peerId],
    getChunkSize: () => appState.options.chunkSize,
  });
  onCleanup(() => files.dispose());
  const peerProfiles = new PeerProfileService(protocol, {
    getLocalClient: () => ({
      clientId: appState.profile.clientId,
      name: appState.profile.name,
      avatar: appState.profile.avatar,
    }),
    onRemoteClient: (client) => {
      sessionService.updateClientProfile(client);
      messageStores.setClient(client);
    },
  });
  let clipboardCacheData: SendClipboardMessage[] = [];
  let clientServiceListenersBound = false;
  const tasks = createTaskService({
    clientId: () => appState.profile.clientId,
    messages: () => appState.message.messages,
    caches: () => appState.cache.cacheInfo,
    transfers: () => appState.transfer.transfers,
  });
  const [speedTestState, setSpeedTestState] =
    createSignal<SpeedTestState>({
      status: "idle",
      peerId: null,
    });
  const speedTestApproval = createSpeedTestApproval();
  const speedTests = new SpeedTestService({
    getConnection: (peerId) =>
      appState.session.sessions[peerId]?.peerConnection,
    isBusy: () =>
      Object.values(appState.transfer.transfers).some(
        Boolean,
      ),
    onState: (state) => {
      setSpeedTestState(state);
      tasks.recordSpeedTest(state);
    },
    approve: (peerId, signal) =>
      speedTestApproval.request(
        peerId,
        appState.message.clients.find(
          (client) => client.clientId === peerId,
        )?.name ?? peerId,
        signal,
      ),
  });
  onCleanup(() => speedTests.dispose());

  createEffect(() => {
    saveMediaConstraintsToSession({
      microphone: {
        autoGainControl:
          appState.media.constraints.microphone
            .autoGainControl,
        echoCancellation:
          appState.media.constraints.microphone
            .echoCancellation,
        noiseSuppression:
          appState.media.constraints.microphone
            .noiseSuppression,
        voiceIsolation:
          appState.media.constraints.microphone
            .voiceIsolation,
      },
      speaker: {
        suppressLocalAudioPlayback:
          appState.media.constraints.speaker
            .suppressLocalAudioPlayback,
        echoCancellation:
          appState.media.constraints.speaker
            .echoCancellation,
        noiseSuppression:
          appState.media.constraints.speaker
            .noiseSuppression,
        autoGainControl:
          appState.media.constraints.speaker
            .autoGainControl,
        latency: appState.media.constraints.speaker.latency,
      },
      video: {
        frameRate:
          appState.media.constraints.video.frameRate,
      },
    });
  });

  const onFocus = () => {
    if (clipboardCacheData.length === 0) return;
    const data = clipboardCacheData
      .map((msg) => msg.data)
      .join("\n");
    navigator.clipboard
      .writeText(data)
      .then(() => {
        toast.success(data);
      })
      .catch((err) => {
        toast.error(err.message);
      })
      .finally(() => {
        clipboardCacheData.length = 0;
      });
  };

  onMount(() => {
    const controller = new AbortController();
    window.addEventListener("focus", onFocus, {
      signal: controller.signal,
    });

    const offSendText = protocol.handle(
      "send-text",
      ({ message }) => {
        messageStores.setReceiveMessage(message);
      },
    );

    const offClipboard = protocol.handle(
      "send-clipboard",
      ({ message }) => {
        sessionService.setClipboard(message);
        window.focus();
        if (navigator.clipboard) {
          navigator.clipboard
            .writeText(message.data)
            .then(() => {
              toast.success(message.data);
            })
            .catch((err) => {
              clipboardCacheData.push(message);
              if (err instanceof Error) {
                console.warn(
                  `can not write ${message.data} to clipboard, ${err.message}`,
                );
              }
            });
        }
      },
    );

    const offStreamState = protocol.on(
      "stream-state",
      ({ message }) => {
        if (
          !sessionService.clientViewData[message.client]
        ) {
          return;
        }
        setAppState(
          "session",
          "clientViewData",
          message.client,
          "streamState",
          message.mode,
        );
      },
    );

    const offRequestStorage = protocol.handle(
      "request-storage",
      async ({ session }) => {
        const provideFileList = resolveClientConfig(
          appState.options,
          session.targetClientId,
        ).provideFileList;
        return provideFileList
          ? ((await cacheManager.getStorages({
              includeIncomplete: false,
            })) ?? [])
          : [];
      },
    );

    const offSpeedTestChannel = rtc.onChannel(
      ({ session, channel }) => {
        speedTests.handleChannel(
          session.targetClientId,
          session.peerConnection,
          channel,
        );
      },
    );

    onCleanup(() => {
      controller.abort();
      offSendText();
      offClipboard();
      offStreamState();
      offRequestStorage();
      offSpeedTestChannel();
    });
  });

  createEffect(() => {
    setAppState(
      "session",
      "localStream",
      props.localStream,
    );
    for (const session of Object.values(
      sessionService.sessions,
    )) {
      session.setStream(props.localStream);
    }
  });

  createEffect(() => {
    const name = appState.profile.name;
    const avatar = appState.profile.avatar;
    if (!appState.roomStatus.roomId) return;

    sessionService.clientService
      ?.updateClient({ name, avatar })
      .catch((error) => {
        console.error(
          "failed to update local client profile",
          error,
        );
      });
    peerProfiles.broadcast();

    if (appState.roomStatus.profile) {
      setAppState("roomStatus", "profile", "name", name);
      setAppState(
        "roomStatus",
        "profile",
        "avatar",
        avatar,
      );
    }
  });

  onCleanup(() => {
    leaveRoom();
    peerProfiles.dispose();
    rtc.unbindAllSessions();
    clipboardCacheData = [];
    clientServiceListenersBound = false;
  });

  async function joinRoom(): Promise<void> {
    console.log(
      `join ${appState.profile.roomId} with profile`,
      appState.profile,
    );

    let cs: ClientService;
    if (sessionService.clientService) {
      cs = sessionService.clientService;
    } else {
      cs = await getClientService({
        roomId: appState.profile.roomId,
        password: appState.profile.password,
        client: {
          clientId: appState.profile.clientId,
          name: appState.profile.name,
          avatar: appState.profile.avatar,
        },
      });

      sessionService.setClientService(cs);
      clientServiceListenersBound = false;
    }

    if (!clientServiceListenersBound) {
      clientServiceListenersBound = true;
      cs.listenForJoin(async (targetClient) => {
        console.log(`new client join in `, targetClient);

        const [err, session] = await catchError(
          sessionService.addClient(targetClient),
        );
        if (err) {
          console.error(err);
          return;
        }

        session.setStream(props.localStream);
        rtc.bindSession(session);
        peerProfiles.bindSession(session);

        await session.listen();
        messageStores.setClient(targetClient);

        if (!session.polite) {
          const [err] = await catchError(session.connect());
          if (err) {
            console.error(err);
            if (
              Object.values(sessionService.sessions)
                .length === 0
            ) {
              leaveRoom();
              throw err;
            }
          }
        }
      });

      cs.listenForLeave((client) => {
        console.log(`client ${client.clientId} leave`);
        peerProfiles.unbindSession(client.clientId);
        sessionService.removeSession(client.clientId);
        rtc.unbindSession(client.clientId);
      });
    }

    await cs.createClient().catch((err) => {
      sessionService.removeService();
      clientServiceListenersBound = false;
      throw err;
    });

    setAppState("roomStatus", "profile", cs.info);
    setAppState(
      "roomStatus",
      "roomId",
      appState.profile.roomId,
    );
  }

  function leaveRoom() {
    files.cancelAll();
    speedTests.cancel();
    const room = appState.roomStatus.roomId;
    if (room) {
      console.log(`on leave room ${room}`);
    }

    peerProfiles.unbindAllSessions();
    rtc.unbindAllSessions();
    sessionService.destoryAllSession();
    setAppState("roomStatus", "roomId", null);
    setAppState("roomStatus", "profile", null);
    clientServiceListenersBound = false;
  }

  function getTargetSessions(
    target: ClientID | ClientID[],
  ) {
    const sessions = target
      ? Array.isArray(target)
        ? target.map((t) => sessionService.sessions[t])
        : [sessionService.sessions[target]]
      : Object.values(sessionService.sessions);
    return sessions.filter((s) => s);
  }

  // Presentation policy stays here; services reject errors without importing UI/toast.
  const runFileAction = async (
    action: () => Promise<void>,
  ) => {
    try {
      await action();
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "AbortError"
      )
        return;
      console.error(error);
      toast.error(
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  };
  const withFileSession = (
    target: ClientID,
    action: (session: PeerSession) => Promise<void>,
  ) =>
    runFileAction(async () => {
      const session = sessionService.sessions[target];
      if (!session)
        throw new Error(`session ${target} not found`);
      await action(session);
    });

  async function sendText(
    text: string,
    target: ClientID | ClientID[],
  ) {
    for (const session of getTargetSessions(target)) {
      await messaging.send(session, "send-text", {
        data: text,
      });
    }
  }

  async function sendFile(
    file: File,
    target: ClientID | ClientID[],
  ) {
    for (const session of getTargetSessions(target))
      await runFileAction(() =>
        files.sendFile(session, file),
      );
  }

  async function sendClipboard(
    text: string,
    target: ClientID | ClientID[],
  ) {
    for (const session of getTargetSessions(target)) {
      const [error] = await catchError(
        protocol.call(session, "send-clipboard", {
          data: text,
        }),
      );
      if (error)
        console.warn(
          "[AppState] send-clipboard failed",
          error,
        );
    }
  }

  async function requestStorage(
    target: ClientID | ClientID[],
  ) {
    for (const session of getTargetSessions(target)) {
      const [error, storage] = await catchError(
        protocol.call(session, "request-storage", {}),
      );
      if (error) {
        console.warn(
          "[AppState] request-storage failed",
          error,
        );
        continue;
      }
      if (
        sessionService.sessions[session.targetClientId] ===
        session
      ) {
        sessionService.setStorage(
          session.targetClientId,
          storage,
        );
      }
    }
  }

  async function retryMessage(message: StoreMessage) {
    const self = appState.profile.clientId;
    const sessionId =
      message.client === self
        ? message.target
        : message.client;
    const session = sessionService.sessions[sessionId];
    if (!session) return;
    if (message.type === "text") {
      await messaging.send(
        session,
        "send-text",
        { data: message.data },
        {
          id: message.id,
          createdAt: message.createdAt,
          retry: true,
        },
      );
      return;
    }
    if (message.type === "file")
      await runFileAction(() =>
        files.retryFile(session, message),
      );
  }

  const shareFile = (fileId: FileID, target: ClientID) =>
    withFileSession(target, (session) =>
      files.shareFile(session, fileId),
    );
  const requestFile = (
    target: ClientID,
    info: ChunkMetaData,
    resume = false,
  ) =>
    withFileSession(target, (session) =>
      files.requestFile(session, info, resume),
    );
  const resumeFile = (fileId: FileID, target: ClientID) =>
    withFileSession(target, (session) =>
      files.resumeFile(session, fileId),
    );
  const pauseFile = (fileId: FileID, target: ClientID) =>
    withFileSession(target, (session) =>
      files.pauseFile(session, fileId),
    );

  return (
    <AppStateContext.Provider
      value={{
        joinRoom,
        leaveRoom,
        shareFile: (fileId, target) => {
          void shareFile(fileId, target);
        },
        sendText,
        sendFile,
        sendClipboard,
        requestStorage,
        retryMessage,
        requestFile,
        resumeFile,
        pauseFile,
        tasks,
        getSpeedTestState: tasks.latestSpeedTest,
        speedTestState,
        startSpeedTest: (target) =>
          speedTests.start(target),
        cancelSpeedTest: (target) =>
          speedTests.cancel(target),
        approveSpeedTest: (target) => {
          speedTestApproval.accept(target);
        },
        declineSpeedTest: (target) => {
          speedTestApproval.decline(target);
        },
        roomStatus: appState.roomStatus,
      }}
    >
      {props.children}
    </AppStateContext.Provider>
  );
};
