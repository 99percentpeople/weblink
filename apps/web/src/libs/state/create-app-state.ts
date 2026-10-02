import { ConversationMessagingService } from "@/libs/application/messaging/conversation-messaging-service";
import { userErrorMessage } from "@/libs/user-error";
import { setRoomConfig } from "@/libs/state/permission-options";
import { t } from "@/i18n";
import { SharedFileTransfers } from "@/libs/application/transfer/shared-file-transfers";
import { FileContentCapabilities } from "@/libs/application/transfer/file-content-capabilities";
import { completeLocalFile } from "@/libs/application/transfer/file-content-completion";
import {
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import type {
  ChunkMetaData,
  FileSource,
} from "@/libs/domain/file";
import type { PeerSession } from "@/libs/domain/session";
import type { ClientID, FileID } from "@/libs/domain/ids";
import type { RoomStatus } from "@/libs/state/app-state";
import { cacheManager } from "@/libs/application/cache-service";
import { transferManager } from "@/libs/application/transfer/transfer-service";
import {
  appState,
  saveMediaConstraintsToSession,
  setAppState,
} from "@/libs/state/app-state";
import {
  resolveClientConfig,
  resolveRoomConfig,
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
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";
import { messageStores } from "@/libs/application/messaging/message-store";
import { ConversationHistoryService } from "@/libs/application/messaging/conversation-history-service";
import { catchError } from "@/libs/catch";
import {
  SpeedTestService,
  type SpeedTestState,
} from "@/libs/application/speed-test-service";
import type { SpeedTestApprovalController } from "@/components/speed-test-approval";
import {
  createTaskService,
  type TaskService,
} from "@/libs/application/task-service";
import {
  createClientService,
  waitForRoomAvailability,
} from "@/libs/application/client-service-factory";
import { RoomConflictRecovery } from "@/libs/application/room-conflict-recovery";
import { RoomService } from "@/libs/application/room-service";
import type { ClientJoinOptions } from "@/libs/domain/client";
import { FileCatalogService } from "@/libs/application/file-catalog-service";
import type { LocalStreamService } from "@/libs/application/local-stream-service";
import { RoomMessagingService } from "@/libs/application/messaging/room-messaging-service";
import { RoomFileSharingService } from "@/libs/application/messaging/room-file-sharing-service";
import { roomConversationId } from "@/libs/domain/conversation";
import { getRoomNamespace } from "@/libs/application/room-identity";

import type { AppStateContextProps } from "@/libs/state/app-state-context";

/** Services are owned by the application composition scope, independently of views. */
export function createAppState(
  localStreamService: LocalStreamService,
  speedTestApproval: SpeedTestApprovalController,
): AppStateContextProps {
  const localStream = localStreamService.stream;
  const conversationHistory =
    new ConversationHistoryService(
      messageStores,
      () => appState.profile.clientId,
    );
  const rtc = createRtcService();
  const protocol = createRtcProtocol();
  const fileContent = new FileContentCapabilities(
    protocol,
    rtc,
  );
  onCleanup(() => fileContent.dispose());
  const messaging = new PeerMessagingService(
    protocol,
    messageStores,
  );
  onCleanup(() => messaging.dispose());
  const namespace = getRoomNamespace();
  const desiredRoom = createMemo(() => {
    const roomId = appState.roomStatus.roomId?.trim();
    return roomId
      ? {
          roomId,
          namespace,
          conversationId: roomConversationId(
            namespace,
            roomId,
          ),
        }
      : null;
  });
  const [currentRoom, setCurrentRoom] =
    createSignal<ReturnType<typeof desiredRoom>>(null);
  createEffect(() => {
    const room = desiredRoom();
    if (room)
      untrack(() =>
        setRoomConfig(room.conversationId, {
          name: room.roomId,
        }),
      );
  });
  const [roomChatCapabilities, setRoomChatCapabilities] =
    createSignal<
      Readonly<
        Record<
          string,
          "checking" | "supported" | "unsupported"
        >
      >
    >({});
  const [roomFileCapabilities, setRoomFileCapabilities] =
    createSignal<
      ReturnType<
        AppStateContextProps["roomChatCapabilities"]
      >
    >({});
  const roomMessaging = new RoomMessagingService(protocol, {
    supportsFiles: true,
    onFileSending: (id) =>
      cacheManager.library.setShared(id, true),
    supportsContent: (session) =>
      fileContent.supports(session),
    reuseFile: (message, signal) =>
      files.reuseRoomOffer(message, signal),
    onFileReused: async (message, peerId) => {
      completeLocalFile(messageStores, message.id, peerId);
      await messageStores.flushMessage(message.id);
    },
    onFileReceived: (message) => {
      // Receiving bytes must not delay the metadata ACK or its local history.
      void runFileAction(() =>
        roomFiles.autoDownloadFile(message),
      );
    },
    onFileCapabilitiesChange: setRoomFileCapabilities,
    getRoom: currentRoom,
    getSessions: () =>
      Object.values(sessionService.sessions),
    getLocalClient: () => ({
      clientId: appState.profile.clientId,
      name: appState.profile.name,
      avatar: appState.profile.avatar,
    }),
    store: messageStores,
    onCapabilitiesChange: setRoomChatCapabilities,
  });
  createEffect(() => {
    const scope = desiredRoom();
    // The active room stays available after its local history is cleared.
    if (scope)
      appState.message.conversations.some(
        (item) => item.id === scope.conversationId,
      );
    Object.values(sessionService.sessions);
    appState.profile.clientId;
    untrack(() => {
      if (scope)
        messageStores.ensureRoomConversation(
          scope.roomId,
          scope.namespace,
        );
      setCurrentRoom(scope);
      roomMessaging.syncSessions();
    });
  });
  onCleanup(() => roomMessaging.dispose());
  cacheManager.isCacheInUse = (cache) =>
    transferManager.isCacheInUse(cache);
  const files = new FileTransferService({
    protocol,
    rtc,
    registry: transferManager,
    caches: cacheManager,
    messages: messageStores,
    messaging,
    getSession: (peerId) => sessionService.sessions[peerId],
    getChunkSize: () => appState.options.chunkSize,
    automaticCacheDeletion: () =>
      appState.options.automaticCacheDeletion,
    supportsContent: (session) =>
      fileContent.supports(session),
    validateRoomReady: (session, message) => {
      roomMessaging.validateFileBinding(
        session,
        message as Parameters<
          typeof roomMessaging.validateFileBinding
        >[1],
      );
    },
  });
  onCleanup(() => files.dispose());
  let previousAttachments = new Set<string>();
  createEffect(() => {
    const current = new Set(
      appState.message.messages.flatMap((message) =>
        message.type === "file" && message.fid
          ? [message.fid]
          : [],
      ),
    );
    for (const id of previousAttachments)
      if (!current.has(id))
        untrack(() => files.releaseMessage(id));
    previousAttachments = current;
  });
  const roomFiles = new RoomFileSharingService(protocol, {
    rooms: roomMessaging,
    files,
    getMessages: () => appState.message.messages,
    getSession: (peerId) => sessionService.sessions[peerId],
    getLocalClientId: () => appState.profile.clientId,
    getAutoDownloadLimit: (conversationId) => {
      const config = resolveRoomConfig(
        appState.options,
        conversationId,
      );
      return config.autoDownloadFiles
        ? config.autoDownloadMaxSize
        : 0;
    },
  });
  onCleanup(() => roomFiles.dispose());
  const conversationMessaging =
    new ConversationMessagingService({
      getConversation: (id) =>
        appState.message.conversations.find(
          (item) => item.id === id,
        ),
      getMessage: (id) =>
        messageStores.messages.find(
          (message) => message.id === id,
        ),
      getLocalClientId: () => appState.profile.clientId,
      getSession: (id) => sessionService.sessions[id],
      getActiveRoomId: () =>
        currentRoom()?.conversationId ?? null,
      peers: messaging,
      rooms: roomMessaging,
      files,
      roomFiles,
    });

  const canShareFiles = (session: PeerSession) =>
    sessionService.sessions[session.targetClientId] ===
      session &&
    session.isMessageChannelReady &&
    resolveClientConfig(
      appState.options,
      session.targetClientId,
    ).provideFileList;
  const sharedFiles = new SharedFileTransfers({
    protocol,
    rtc,
    registry: transferManager,
    caches: cacheManager,
    receives: files.contentReceives,
    getSession: (id) => sessionService.sessions[id],
    canShare: canShareFiles,
    supports: (session) =>
      fileContent.supportsShared(session),
    reportError: (error) =>
      toast.error(
        userErrorMessage(error, "errors.file_failed"),
      ),
  });
  createEffect(() => {
    // Read the permission sources even before any transfer has started.
    Object.values(sessionService.sessions).forEach(
      canShareFiles,
    );
    sharedFiles.syncPermissions();
  });
  onCleanup(() => sharedFiles.dispose());
  const catalog = new FileCatalogService({
    protocol,
    index: cacheManager.catalog,
    getSessions: () =>
      Object.values(sessionService.sessions),
    isReady: (session) =>
      sessionService.sessions[session.targetClientId] ===
        session && session.isMessageChannelReady,
    supports: (session) =>
      fileContent.supportsShared(session),
    canList: canShareFiles,
    onSessionClosed: (handler) =>
      rtc.onSessionClosed(handler),
  });
  createEffect(() => catalog.syncSharing());
  onCleanup(() => catalog.dispose());
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
  const tasks = createTaskService({
    sharedFiles: sharedFiles.tasks,
    clearSharedFiles: sharedFiles.clearFinished,
    preparations: cacheManager.preparations,
    clearPreparations: cacheManager.clearPreparations,
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

  const [roomConflict, setRoomConflict] =
    createSignal(false);
  const [recoverLocalConflict, setRecoverLocalConflict] =
    createSignal(false);
  const [manualJoin, setManualJoin] = createSignal(false);
  const [recoveryRevision, setRecoveryRevision] =
    createSignal(0);
  let recovery: RoomConflictRecovery | undefined;
  const room = new RoomService({
    sessions: sessionService,
    rtc,
    profiles: peerProfiles,
    messages: messageStores,
    createClientService: (options) =>
      createClientService({
        ...options,
        onNotice: (notice) => {
          if (notice === "room-unprotected")
            toast.warning(
              t("common.notification.room_unprotected"),
            );
          else if (
            notice === "session-replaced" ||
            notice === "tab-replaced"
          ) {
            recovery?.stop();
            room.leave();
            setRecoverLocalConflict(
              notice === "tab-replaced",
            );
            setRoomConflict(true);
            setRecoveryRevision((revision) => revision + 1);
          } else toast.error(t("errors.password_prepare"));
        },
      }),
    getLocalStream: () => localStream(),
    onMemberJoined: (roomId, client) => {
      const id = roomId.trim();
      messageStores.recordRoomMember(
        roomConversationId(namespace, id),
        client.clientId,
      );
    },
    onLeaving: () => {
      files.cancelAll();
      speedTests.cancel();
    },
  });
  const joinRoom = async (options?: ClientJoinOptions) => {
    recovery?.stop();
    setManualJoin(true);
    try {
      await room.join(options);
      setRoomConflict(false);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Room is already open in another tab"
      ) {
        setRecoverLocalConflict(true);
        setRoomConflict(true);
      }
      throw error;
    } finally {
      setManualJoin(false);
    }
  };
  const leaveRoom = () => {
    recovery?.stop();
    setRoomConflict(false);
    room.leave();
  };
  createEffect(() => {
    if (
      !roomConflict() ||
      !recoverLocalConflict() ||
      manualJoin()
    )
      return;
    recoveryRevision();
    const { roomId, clientId, password } = appState.profile;
    // Changing room credentials retires the old observer and any in-flight join.
    void password;
    const current = new RoomConflictRecovery({
      waitUntilAvailable: (signal) =>
        waitForRoomAvailability(roomId, clientId, signal),
      join: () => room.join(),
      cancelJoin: () => room.leave(),
      onRestored: () => setRoomConflict(false),
      onError: (error) => {
        console.error(
          "Unable to restore room connection",
          error,
        );
        toast.error(
          userErrorMessage(
            error,
            "errors.connection_failed",
          ),
        );
      },
    });
    recovery = current;
    current.start();
    onCleanup(() => {
      current.stop();
      if (recovery === current) recovery = undefined;
    });
  });

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
        toast.error(t("common.notification.copy_failed"));
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
          {
            streamState: message.mode,
            videoSources: message.videoSources.map(
              (source) => ({ ...source }),
            ),
            audioSources: message.audioSources.map(
              (source) => ({ ...source }),
            ),
          },
        );
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
      offClipboard();
      offStreamState();
      offSpeedTestChannel();
    });
  });

  createEffect(() => {
    setAppState("session", "localStream", localStream());
    sessionService.setStream(localStream());
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
    recovery?.stop();
    room.dispose();
    peerProfiles.dispose();
    clipboardCacheData = [];
  });

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
        userErrorMessage(error, "errors.file_failed"),
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
    for (const id of Array.isArray(target)
      ? target
      : [target]) {
      const conversation =
        messageStores.ensureDirectConversation(id);
      await conversationMessaging.sendText(
        conversation.id,
        text,
      );
    }
  }

  async function sendFile(
    file: FileSource,
    target: ClientID | ClientID[],
  ) {
    for (const id of Array.isArray(target)
      ? target
      : [target]) {
      const conversation =
        messageStores.ensureDirectConversation(id);
      await conversationMessaging.sendFile(
        conversation.id,
        file,
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

  const retryMessage = (message: StoreMessage) =>
    conversationMessaging.retryMessage(message);

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

  return {
    conversationMessaging,
    conversationHistory,
    joinRoom,
    roomConflict,
    leaveRoom,
    activeRoomConversationId: () =>
      currentRoom()?.conversationId ?? null,
    roomChatCapabilities,
    roomFileCapabilities,
    sendRoomFile: async (file) => {
      await conversationMessaging.sendFile(
        currentRoom()?.conversationId ?? "",
        file,
      );
    },
    requestRoomFile: (message) =>
      runFileAction(() => roomFiles.requestFile(message)),
    sendRoomText: async (text) => {
      await conversationMessaging.sendText(
        currentRoom()?.conversationId ?? "",
        text,
      );
    },
    shareFile: (fileId, target) => {
      void shareFile(fileId, target);
    },
    sendText,
    sendFile,
    sendClipboard,
    catalog,
    sharedFiles,
    supportsSharedFiles: (session) =>
      fileContent.supportsShared(session),
    retryMessage,
    requestFile,
    resumeFile,
    pauseFile,
    tasks,
    getSpeedTestState: tasks.latestSpeedTest,
    speedTestState,
    startSpeedTest: (target) => speedTests.start(target),
    cancelSpeedTest: (target) => speedTests.cancel(target),
    approveSpeedTest: (target) => {
      speedTestApproval.accept(target);
    },
    declineSpeedTest: (target) => {
      speedTestApproval.decline(target);
    },
    localStream,
    replaceLocalStream: (stream) =>
      localStreamService.replace(stream),
    clearLocalStream: () => localStreamService.clear(),
    roomStatus: appState.roomStatus,
  };
}
