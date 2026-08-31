import {
  Component,
  createContext,
  createEffect,
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
import { createRtcService } from "@/libs/services/rtc-service";
import {
  createRtcProtocol,
  protocolMessageFactory,
  type RtcProtocolRequestError,
  type RtcProtocolRequestResult,
  type AckMessage,
  type RequestFileMessage,
  type SendClipboardMessage,
  type SendFileMessage,
  type SessionMessage,
} from "@/libs/services/rtc-protocol";
import { sessionService } from "@/libs/services/session-service";
import { PeerProfileService } from "@/libs/services/peer-profile-service";
import { toast } from "solid-sonner";
import {
  FileTransferMessage,
  messageStores,
  type StoreMessage,
} from "@/libs/core/message";
import { catchError } from "@/libs/catch";

async function getClientService(
  options: ClientServiceInitOptions,
): Promise<ClientService> {
  switch (import.meta.env.VITE_BACKEND) {
    case "FIREBASE":
      return import("@/libs/core/services/client/firebase-client-service").then(
        (m) => new m.FirebaseClientService(options),
      );
    case "WEBSOCKET":
      options.websocketUrl =
        appState.options.websocketUrl ??
        import.meta.env.VITE_WEBSOCKET_URL;
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
  resumeFile: (fileId: FileID, target: ClientID) => void;
  pauseFile: (fileId: FileID, target: ClientID) => void;
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

    const offSendText = protocol.onRequest(
      "send-text",
      ({ message }) => {
        messageStores.setReceiveMessage(message);
      },
      { ackMode: "receive" },
    );

    const offClipboard = protocol.onRequest(
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
      { ackMode: "receive" },
    );

    const offSendFile = protocol.onRequest(
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
      { ackMode: "receive" },
    );

    const offRequestFile = protocol.onRequest(
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
      { ackMode: "send" },
    );

    const offResumeFile = protocol.onRequest(
      "resume-file",
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
        await requestFile(message.client, info, true);
      },
      { ackMode: "receive" },
    );

    const offStorage = protocol.onRequest(
      "storage",
      ({ message }) => {
        sessionService.setStorage(message);
      },
      { ackMode: "receive" },
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

    const offRequestStorage = protocol.onRequest(
      "request-storage",
      async ({ session, message }) => {
        const replyMessage = protocolMessageFactory.storage(
          {
            data:
              (await cacheManager.getStorages({
                includeIncomplete: false,
              })) ?? [],
            client: message.target,
            target: message.client,
            id: message.id,
          },
        );

        const result = await protocol.requestWithResult(
          session,
          replyMessage,
          {
            timeoutMs: 5000,
          },
        );
        if (
          !result.ok &&
          result.error.code !== "already-pending"
        ) {
          throw new Error(result.error.message);
        }
      },
      { ackMode: "receive" },
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

      transferManager.addChannel(fileId, channel);
    });

    onCleanup(() => {
      controller.abort();
      offSendText();
      offClipboard();
      offSendFile();
      offRequestFile();
      offResumeFile();
      offStorage();
      offStreamState();
      offRequestStorage();
      offChannel();
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

  const getRequestErrorMessage = (
    error: RtcProtocolRequestError,
  ) => {
    if (error.code === "already-pending") return null;
    return error.message;
  };

  const setLocalSendError = (
    request: SessionMessage,
    error: string,
  ) => {
    const errorMessage = protocolMessageFactory.error({
      client: request.client,
      target: request.target,
      error,
      id: request.id,
    });

    messageStores.setReceiveMessage(errorMessage);
  };

  const resolveAckResult = (
    request: SessionMessage,
    result: RtcProtocolRequestResult,
  ) => {
    if (!result.ok) {
      const error = getRequestErrorMessage(result.error);
      if (error) {
        setLocalSendError(request, error);
      }
      return null;
    }
    messageStores.setReceiveMessage(result.ackMessage);
    return result.ackMessage;
  };

  const resolveSilentResult = (
    request: SessionMessage,
    result: RtcProtocolRequestResult,
    options: {
      silent?: boolean;
    } = {},
  ) => {
    if (result.ok) return true;
    const error = getRequestErrorMessage(result.error);
    if (error && !options.silent) {
      console.warn(
        `[AppState] request ${request.type} failed: ${error}`,
      );
    }
    return false;
  };

  const addTransferChannels = async (
    session: PeerSession,
    transferId: FileID,
    fileId: FileID,
  ) => {
    for (
      let i = 0;
      i < appState.options.channelsNumber;
      i++
    ) {
      const [err, channel] = await catchError(
        session.createChannel(
          `${transferId}-${i}`,
          "transfer",
        ),
      );
      if (err) throw err;
      if (!channel) continue;
      transferManager.addChannel(fileId, channel);
    }
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
      await addTransferChannels(
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
    await addTransferChannels(
      session,
      transferer.id,
      message.fid,
    );
  };

  const setupTransferAfterAckSafe = async (
    session: PeerSession,
    message: SendFileMessage | RequestFileMessage,
    ackMessage: AckMessage,
  ) => {
    const [err] = await catchError(
      setupTransferAfterAck(session, message, ackMessage),
    );
    if (!err) return;
    console.error(err);
    setLocalSendError(
      message,
      err instanceof Error ? err.message : String(err),
    );
  };

  async function sendText(
    text: string,
    target: ClientID | ClientID[],
  ) {
    const sessions = getTargetSessions(target);
    if (sessions.length === 0) return;

    for (const session of sessions) {
      const message = protocolMessageFactory.sendText({
        client: session.clientId,
        target: session.targetClientId,
        data: text,
      });
      messageStores.setSendMessage(message, {
        timeoutMs: null,
      });
      const result = await protocol.requestWithResult(
        session,
        message,
      );
      resolveAckResult(message, result);
      console.log(`send text message`, message);
    }
  }

  async function sendFile(
    file: File,
    target: ClientID | ClientID[],
  ) {
    const sessions = getTargetSessions(target);
    if (sessions.length === 0) return;

    for (const session of sessions) {
      const fid = v4();
      const message = protocolMessageFactory.sendFile({
        client: session.clientId,
        target: session.targetClientId,
        fid,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        lastModified: file.lastModified,
        chunkSize: appState.options.chunkSize,
      });

      const cache = await cacheManager.createCache(
        message.fid,
      );
      await cache.setInfo({
        fileName: message.fileName,
        fileSize: message.fileSize,
        mimetype: message.mimeType,
        lastModified: message.lastModified,
        chunkSize: message.chunkSize,
        createdAt: message.createdAt,
        file: file,
      });

      console.log(`send file message`, message);
      messageStores.setSendMessage(message, {
        timeoutMs: null,
      });
      const result = await protocol.requestWithResult(
        session,
        message,
      );
      const ackMessage = resolveAckResult(message, result);
      if (!ackMessage) continue;
      await setupTransferAfterAckSafe(
        session,
        message,
        ackMessage,
      );
    }
  }

  async function sendClipboard(
    text: string,
    target: ClientID | ClientID[],
  ) {
    const sessions = getTargetSessions(target);
    if (sessions.length === 0) return;

    for (const session of sessions) {
      const message = protocolMessageFactory.sendClipboard({
        client: session.clientId,
        target: session.targetClientId,
        data: text,
      });

      const result = await protocol.requestWithResult(
        session,
        message,
      );
      resolveSilentResult(message, result);
    }
  }

  async function requestStorage(
    target: ClientID | ClientID[],
  ) {
    const sessions = getTargetSessions(target);
    if (sessions.length === 0) return;

    for (const session of sessions) {
      const message = protocolMessageFactory.requestStorage(
        {
          client: session.clientId,
          target: session.targetClientId,
        },
      );

      const result = await protocol.requestWithResult(
        session,
        message,
      );
      resolveSilentResult(message, result);
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
      const sessionMessage =
        protocolMessageFactory.sendText({
          client: session.clientId,
          target: session.targetClientId,
          data: message.data,
          id: message.id,
          createdAt: message.createdAt,
        });

      messageStores.retrySendMessage(sessionMessage, {
        timeoutMs: null,
      });
      const result = await protocol.requestWithResult(
        session,
        sessionMessage,
      );
      resolveAckResult(sessionMessage, result);
    } else if (message.type === "file") {
      if (!message.fid) return;

      const isSender = message.client === self;
      if (!isSender) {
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

      const sessionMessage =
        protocolMessageFactory.sendFile({
          client: session.clientId,
          target: session.targetClientId,
          fid: message.fid,
          fileName: message.fileName,
          fileSize: message.fileSize,
          mimeType: message.mimeType,
          lastModified: message.lastModified,
          chunkSize: message.chunkSize,
          createdAt: message.createdAt,
          id: message.id,
        });

      messageStores.retrySendMessage(sessionMessage, {
        timeoutMs: null,
      });
      const result = await protocol.requestWithResult(
        session,
        sessionMessage,
      );
      const ackMessage = resolveAckResult(
        sessionMessage,
        result,
      );
      if (!ackMessage) return;
      await setupTransferAfterAckSafe(
        session,
        sessionMessage,
        ackMessage,
      );
    }
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
    if (!info) {
      console.warn(`cache ${fileId} info not exist`);
      return;
    }

    if (!info.file) {
      console.warn(`cache ${fileId} file not exist`);
      return;
    }

    const message = protocolMessageFactory.sendFile({
      client: session.clientId,
      target: session.targetClientId,
      fid: fileId,
      fileName: info.fileName,
      fileSize: info.fileSize,
      mimeType: info.mimetype,
      lastModified: info.lastModified,
      chunkSize: appState.options.chunkSize,
    });
    messageStores.setSendMessage(message, {
      timeoutMs: null,
    });
    const result = await protocol.requestWithResult(
      session,
      message,
    );
    const ackMessage = resolveAckResult(message, result);
    if (!ackMessage) return;
    await setupTransferAfterAckSafe(
      session,
      message,
      ackMessage,
    );
  }

  async function requestFile(
    target: ClientID,
    info: ChunkMetaData,
    resume: boolean = false,
  ) {
    const session = sessionService.sessions[target];
    if (!session) {
      console.warn(
        `can not request file from target: ${target}, target not exist`,
      );
      return;
    }
    const client = sessionService.clientViewData[target];
    if (client.onlineStatus !== "online") {
      console.warn(
        `can not request file from target: ${target}, client status is ${client.onlineStatus}`,
      );
      return;
    }

    let cache = cacheManager.getCache(info.id);
    console.log(`get local cache`, cache);
    if (!cache) {
      cache = await cacheManager.createCache(info.id);
      await cache.setInfo({
        ...info,
        file: undefined,
      });
      console.log(`create cache`, await cache.getInfo());
    } else {
      console.log(`get local cache`, cache);
    }

    const ranges = await cache.getReqRanges();

    if (ranges && getRangesLength(ranges) === 0) {
      messageStores.addCache(cache);
      await cache.getFile();
      return;
    }

    let index = messageStores.messages.findIndex(
      (msg) => msg.type === "file" && msg.fid === info.id,
    );

    let id;
    if (resume && index !== -1) {
      id = messageStores.messages[index].id;
    } else {
      id = v4();
    }

    const existing =
      resume && index !== -1
        ? messageStores.messages[index]
        : undefined;
    const createdAt =
      existing && existing.status === "error"
        ? existing.createdAt
        : Date.now();

    const message = protocolMessageFactory.requestFile({
      fid: info.id,
      client: session.clientId,
      target: session.targetClientId,
      ranges: ranges ?? undefined,
      fileName: info.fileName,
      fileSize: info.fileSize,
      mimeType: info.mimetype,
      lastModified: info.lastModified,
      chunkSize:
        info.chunkSize ?? appState.options.chunkSize,
      resume,
      id,
      createdAt,
    });

    if (existing) {
      if (existing.status === "error") {
        messageStores.retrySendMessage(message, {
          timeoutMs: null,
        });
      } else {
        messageStores.setSendMessage(message, {
          timeoutMs: null,
        });
      }
    } else {
      messageStores.setSendMessage(message, {
        timeoutMs: null,
      });
    }

    const result = await protocol.requestWithResult(
      session,
      message,
    );
    const ackMessage = resolveAckResult(message, result);
    if (!ackMessage) return;
    await setupTransferAfterAckSafe(
      session,
      message,
      ackMessage,
    );
  }

  async function resumeFile(
    fileId: FileID,
    target: ClientID,
  ) {
    const session = sessionService.sessions[target];
    if (!session) return;
    const cache = cacheManager.getCache(fileId);
    if (!cache) return;
    const info = await cache.getInfo();
    if (!info) return;
    if (!info.file) return;

    const transferMessage = messageStores.messages.findLast(
      (msg) => msg.type === "file" && msg.fid === fileId,
    ) as FileTransferMessage | undefined;
    if (!transferMessage) return;
    if (transferMessage.transferStatus === "complete")
      return;

    const message = protocolMessageFactory.resumeFile({
      fid: fileId,
      client: session.clientId,
      target: session.targetClientId,
      id: transferMessage.id,
    });

    const result = await protocol.requestWithResult(
      session,
      message,
    );
    resolveSilentResult(message, result);
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
        resumeFile: (fileId, target) => {
          void resumeFile(fileId, target);
        },
        pauseFile: (fileId, target) => {
          void pauseFile(fileId, target);
        },
        roomStatus: appState.roomStatus,
      }}
    >
      {props.children}
    </AppStateContext.Provider>
  );
};
