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
import type {
  ChunkMetaData,
  FileMetaData,
} from "@/libs/cache";
import type { PeerSession } from "@/libs/core/session";
import type {
  ClientID,
  FileID,
  RoomStatus,
} from "@/libs/core/type";
import type {
  ClientService,
  ClientServiceInitOptions,
} from "@/libs/core/services/type";
import {
  TRANSFER_CHANNEL_PREFIX,
  TransferMode,
} from "@/libs/core/file-transferer";
import { v4 } from "uuid";
import { cacheManager } from "@/libs/services/cache-serivce";
import { transferManager } from "@/libs/services/transfer-service";
import { getRangesLength } from "@/libs/utils/range";
import {
  appState,
  saveMediaConstraintsToSession,
  setAppState,
} from "@/libs/state/app-state";
import {
  resolveClientConfig,
  signalingWebSocketUrl,
} from "@/libs/state/app-options";
import { createRtcService } from "@/libs/services/rtc-service";
import {
  createRtcProtocol,
  type AckMessage,
  type RequestFileMessage,
  type SendClipboardMessage,
  type SendFileMessage,
} from "@/libs/services/rtc-protocol";
import { sessionService } from "@/libs/services/session-service";
import { PeerProfileService } from "@/libs/services/peer-profile-service";
import {
  PeerMessagingService,
  type TrackedSendOptions,
} from "@/libs/services/peer-messaging-service";
import { toast } from "solid-sonner";
import {
  FileTransferMessage,
  messageStores,
  type StoreMessage,
} from "@/libs/core/message";
import { catchError } from "@/libs/catch";
import {
  SpeedTestService,
  type SpeedTestState,
} from "@/libs/services/speed-test-service";
import { createSpeedTestApproval } from "@/components/speed-test-approval";
import {
  createTaskService,
  type TaskService,
} from "@/libs/services/task-service";

async function getClientService(
  options: ClientServiceInitOptions,
): Promise<ClientService> {
  switch (import.meta.env.VITE_BACKEND) {
    case "FIREBASE":
      return import("@/libs/core/services/client/firebase-client-service").then(
        (m) => new m.FirebaseClientService(options),
      );
    case "WEBSOCKET":
      options.websocketUrl = signalingWebSocketUrl;
      return import("@/libs/core/services/client/ws-client-service").then(
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
    transfers: () => appState.transfer.transferers,
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
      Object.values(appState.transfer.transferers).some(
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

    const offSendFile = protocol.handle(
      "send-file",
      async ({ message }) => {
        if (cacheManager.getCache(message.fid)) {
          throw new Error(
            `cache ${message.fid} already exists`,
          );
        }
        messageStores.setReceiveMessage(message);

        const cache = await cacheManager.createCache(
          message.fid,
        );

        const receiveInfo = {
          fileName: message.fileName,
          fileSize: message.fileSize,
          mimetype: message.mimeType,
          lastModified: message.lastModified,
          chunkSize: message.chunkSize,
          createdAt: message.createdAt,
          id: message.fid,
        } satisfies FileMetaData;

        const transferer = transferManager.createTransfer(
          cache,
          TransferMode.Receive,
          receiveInfo,
        );

        messageStores.addTransfer(transferer);
        await transferer.initialize();
      },
    );

    const offRequestFile = protocol.handle(
      "request-file",
      async ({ message }) => {
        const cache = cacheManager.getCache(message.fid);
        if (!cache) {
          throw new Error(`cache ${message.fid} not found`);
        }

        const info = await cache.getInfo();
        if (!info) {
          throw new Error(
            `cache ${message.fid} info not found`,
          );
        }

        if (!info.isComplete) {
          throw new Error(
            `cache ${message.fid} is not complete`,
          );
        }
        messageStores.setReceiveMessage(message);
        const transferer = transferManager.createTransfer(
          cache,
          TransferMode.Send,
        );
        messageStores.addTransfer(transferer);

        transferer.addEventListener("ready", async () => {
          const [error] = await catchError(
            transferer.sendFile(message.ranges),
          );
          if (error) {
            console.error(error);
            toast.error(error.message);
          }
        });

        await transferer.initialize();
        transferer.setSendStatus(message);
      },
    );

    const offResumeFile = protocol.handle(
      "resume-file",
      async ({ message, signal }) => {
        const cache = cacheManager.getCache(message.fid);
        if (!cache) {
          throw new Error(`cache ${message.fid} not found`);
        }
        const info = await cache.getInfo();
        if (!info) {
          throw new Error(
            `cache ${message.fid} info not found`,
          );
        }
        await requestFile(message.client, info, true, {
          signal,
          throwOnError: true,
        });
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

    const offChannel = rtc.onChannel(({ channel }) => {
      if (channel.protocol !== "transfer") return;
      console.log(`datachannel event`, channel);

      const fileIdWithChannelId = channel.label.replace(
        TRANSFER_CHANNEL_PREFIX,
        "",
      );

      const index = fileIdWithChannelId.lastIndexOf("-");
      const fileId =
        index === -1
          ? fileIdWithChannelId
          : fileIdWithChannelId.slice(0, index);

      console.log(`receive channel for file ${fileId}`);

      transferManager.setChannel(fileId, channel);
    });

    onCleanup(() => {
      controller.abort();
      offSendText();
      offClipboard();
      offSendFile();
      offRequestFile();
      offResumeFile();
      offStreamState();
      offRequestStorage();
      offChannel();
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

  const addTransferChannel = async (
    session: PeerSession,
    transferId: FileID,
    fileId: FileID,
  ) => {
    const [err, channel] = await catchError(
      session.createChannel(
        // Keep the legacy "-0" suffix so older clients can
        // still associate the channel with the file.
        `${transferId}-0`,
        "transfer",
      ),
    );
    if (err) throw err;
    if (!channel) return;
    transferManager.setChannel(fileId, channel);
  };

  const setupTransferAfterAck = async (
    session: PeerSession,
    message: SendFileMessage | RequestFileMessage,
    ackMessage: AckMessage,
  ) => {
    const cache = cacheManager.getCache(message.fid);
    if (!cache) {
      throw new Error(`cache ${message.fid} not found`);
    }

    if (message.type === "send-file") {
      if (ackMessage.mode !== "receive") return;
      const transferer = transferManager.createTransfer(
        cache,
        TransferMode.Send,
      );
      messageStores.addTransfer(transferer);
      transferer.addEventListener("ready", async () => {
        const [error] = await catchError(
          transferer.sendFile(),
        );
        if (error) {
          console.error(error);
          toast.error(error.message);
        }
      });
      await transferer.initialize();
      await addTransferChannel(
        session,
        transferer.id,
        message.fid,
      );
      return;
    }

    if (ackMessage.mode !== "send") return;
    const transferer = transferManager.createTransfer(
      cache,
      TransferMode.Receive,
    );
    messageStores.addTransfer(transferer);
    await transferer.initialize();
    await addTransferChannel(
      session,
      transferer.id,
      message.fid,
    );
  };

  const setupTransferAfterAckSafe = async (
    session: PeerSession,
    message: SendFileMessage | RequestFileMessage,
    ackMessage: AckMessage,
    options: { throwOnError?: boolean } = {},
  ) => {
    const [err] = await catchError(
      setupTransferAfterAck(session, message, ackMessage),
    );
    if (!err) return;
    console.error(err);
    messaging.fail(message, err);
    if (options.throwOnError) throw err;
  };

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
    for (const session of getTargetSessions(target)) {
      const fid = v4();
      const payload = {
        fid,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        lastModified: file.lastModified,
        chunkSize: appState.options.chunkSize,
      };
      const cache = await cacheManager.createCache(fid);
      await cache.setInfo({
        fileName: file.name,
        fileSize: file.size,
        mimetype: file.type,
        lastModified: file.lastModified,
        chunkSize: payload.chunkSize,
        createdAt: Date.now(),
        file,
      });
      const result = await messaging.send(
        session,
        "send-file",
        payload,
      );
      if (result)
        await setupTransferAfterAckSafe(
          session,
          result.message,
          result.ackMessage,
        );
    }
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
    if (message.type !== "file" || !message.fid) return;
    if (message.client !== self) {
      const cache = cacheManager.getCache(message.fid);
      const info = await cache?.getInfo();
      await requestFile(
        message.client,
        {
          id: message.fid,
          fileName: info?.fileName ?? message.fileName,
          fileSize: info?.fileSize ?? message.fileSize,
          mimetype: info?.mimetype ?? message.mimeType,
          lastModified:
            info?.lastModified ?? message.lastModified,
          chunkSize: info?.chunkSize ?? message.chunkSize,
          createdAt: info?.createdAt ?? message.createdAt,
        },
        true,
      );
      return;
    }
    const cache = cacheManager.getCache(message.fid);
    if (!cache) {
      toast.error(`cache ${message.fid} not exist`);
      return;
    }
    const info = await cache.getInfo();
    if (!info?.file) {
      toast.error(`cache ${message.fid} file not exist`);
      return;
    }
    const result = await messaging.send(
      session,
      "send-file",
      {
        fid: message.fid,
        fileName: message.fileName,
        fileSize: message.fileSize,
        mimeType: message.mimeType,
        lastModified: message.lastModified,
        chunkSize: message.chunkSize,
      },
      {
        id: message.id,
        createdAt: message.createdAt,
        retry: true,
      },
    );
    if (result)
      await setupTransferAfterAckSafe(
        session,
        result.message,
        result.ackMessage,
      );
  }

  async function shareFile(
    fileId: FileID,
    target: ClientID,
  ) {
    const cache = cacheManager.getCache(fileId);
    if (!cache) {
      console.warn(`cache ${fileId} not exist`);
      return;
    }
    const session = sessionService.sessions[target];
    if (!session) {
      console.warn(`session ${target} not exist`);
      return;
    }
    const info = await cache.getInfo();
    if (!info?.file) {
      console.warn(`cache ${fileId} file not exist`);
      return;
    }
    const result = await messaging.send(
      session,
      "send-file",
      {
        fid: fileId,
        fileName: info.fileName,
        fileSize: info.fileSize,
        mimeType: info.mimetype,
        lastModified: info.lastModified,
        chunkSize:
          info.chunkSize ?? appState.options.chunkSize,
      },
    );
    if (result)
      await setupTransferAfterAckSafe(
        session,
        result.message,
        result.ackMessage,
      );
  }

  async function requestFile(
    target: ClientID,
    info: ChunkMetaData,
    resume: boolean = false,
    options: TrackedSendOptions = {},
  ) {
    const session = sessionService.sessions[target];
    const client = sessionService.clientViewData[target];
    if (!session || client?.onlineStatus !== "online") {
      const error = new Error(
        `can not request file from offline target: ${target}`,
      );
      if (options.throwOnError) throw error;
      console.warn(error.message);
      return;
    }
    let cache = cacheManager.getCache(info.id);
    if (!cache) {
      cache = await cacheManager.createCache(info.id);
      await cache.setInfo({ ...info, file: undefined });
    }
    const ranges = await cache.getReqRanges();
    if (ranges && getRangesLength(ranges) === 0) {
      messageStores.addCache(cache);
      await cache.getFile();
      return;
    }
    const existing = resume
      ? messageStores.messages.findLast(
          (msg) =>
            msg.type === "file" &&
            msg.fid === info.id &&
            ((msg.client === session.clientId &&
              msg.target === session.targetClientId) ||
              (msg.client === session.targetClientId &&
                msg.target === session.clientId)),
        )
      : undefined;
    const result = await messaging.send(
      session,
      "request-file",
      {
        fid: info.id,
        ranges: ranges ?? undefined,
        fileName: info.fileName,
        fileSize: info.fileSize,
        mimeType: info.mimetype,
        lastModified: info.lastModified,
        chunkSize:
          info.chunkSize ?? appState.options.chunkSize,
        resume,
      },
      {
        ...options,
        id: existing?.id,
        createdAt:
          existing?.status === "error"
            ? existing.createdAt
            : undefined,
        retry: existing?.status === "error",
      },
    );
    if (result)
      await setupTransferAfterAckSafe(
        session,
        result.message,
        result.ackMessage,
        options,
      );
  }

  async function resumeFile(
    fileId: FileID,
    target: ClientID,
  ) {
    const session = sessionService.sessions[target];
    const cache = cacheManager.getCache(fileId);
    if (!session || !cache) return;
    const info = await cache.getInfo();
    if (!info?.file) return;
    const transferMessage = messageStores.messages.findLast(
      (msg) =>
        msg.type === "file" &&
        msg.fid === fileId &&
        msg.client === session.clientId &&
        msg.target === target,
    ) as FileTransferMessage | undefined;
    if (
      !transferMessage ||
      transferMessage.transferStatus === "complete"
    )
      return;
    const [error] = await catchError(
      protocol.call(
        session,
        "resume-file",
        { fid: fileId },
        { id: transferMessage.id },
      ),
    );
    if (error)
      console.warn("[AppState] resume-file failed", error);
  }

  async function pauseFile(
    fileId: FileID,
    target: ClientID,
  ) {
    const session = sessionService.sessions[target];
    if (!session) return;
    const transferer =
      transferManager.getTransferer(fileId);
    if (!transferer) return;
    await transferer.pause(true);
  }

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
