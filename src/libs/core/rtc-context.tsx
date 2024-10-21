import {
  Component,
  createContext,
  createEffect,
  onCleanup,
  ParentProps,
  useContext,
} from "solid-js";
import {
  Client,
  ClientID,
  FileID,
  RoomStatus,
  TransferClient,
} from "./type";
import { createStore, reconcile } from "solid-js/store";
import { FirebaseClientService } from "./services/client/firebase-client-service";

import { PeerSession } from "./session";
import {
  TRANSFER_CHANNEL_PREFIX,
  TransferMode,
} from "./file-transmitter";
import { v4 } from "uuid";
import { clientProfile } from "./store";
import { cacheManager } from "../services/cache-serivce";
import { transferManager } from "../services/transfer-service";
import { getRangesLength } from "../utils/range";
import { ClientService } from "./services/type";

import {
  messageStores,
  RequestFileMessage,
  SendFileMessage,
  SendTextMessage,
} from "./messge";
import { sessionService } from "../services/session-service";
import { WebSocketClientService } from "./services/client/ws-client-service";
import { SseClientService } from "./services/client/sse-client-service";
import { appOptions } from "@/options";
import { aw } from "vitest/dist/chunks/reporters.DAfKSDh5.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getServiceConstructor() {
  switch (import.meta.env.VITE_BACKEND) {
    case "FIREBASE":
      return FirebaseClientService;
    case "WEBSOCKET":
      return WebSocketClientService;
    case "SSE":
      return SseClientService;
    default:
      throw Error("invalid backend type");
  }
}

export function getRandomUnsignedShort() {
  return Math.floor(Math.random() * 6553);
}

const WebRTCContext = createContext<
  WebRTCContextProps | undefined
>(undefined);

export const useWebRTC = (): WebRTCContextProps => {
  const context = useContext(WebRTCContext);
  if (!context) {
    throw new Error(
      "useWebRTC must be used within a WebRTCProvider",
    );
  }
  return context;
};

export interface SendOptions {
  target?: string;
}

export interface WebRTCContextProps {
  joinRoom: () => Promise<void>;
  leaveRoom: () => void;
  requestFile(
    target: ClientID,
    fileId: FileID,
  ): Promise<void>;
  send: (
    text: string | File,
    options: SendOptions,
  ) => Promise<boolean>;
  roomStatus: RoomStatus;
  remoteStreams: Record<string, MediaStream>;
}

export interface WebRTCProviderProps extends ParentProps {
  onTrackChanged?: (
    target: string,
    pc: RTCPeerConnection,
  ) => void;

  localStream: MediaStream | null;
}

export const WebRTCProvider: Component<
  WebRTCProviderProps
> = (props) => {
  // createEffect(() => {
  //   const info: Record<string, ClientInfo> = {};
  //   messageStores.clients.forEach((client) => {
  //     info[client.clientId] = {
  //       ...client,
  //       onlineStatus: "offline",
  //     };
  //   });

  //   setClientSessionInfo(info);

  //   if (!clientService()) {
  //     setClientSessionInfo(
  //       produce((state) =>
  //         Object.values(state).forEach(
  //           (info) => (info.onlineStatus = "offline"),
  //         ),
  //       ),
  //     );
  //   }
  // });

  const [remoteStreams, setRemoteStreams] = createStore<
    Record<string, MediaStream>
  >({});

  const [dataChannels, setDataChannels] = createStore<
    Record<string, Record<string, RTCDataChannel>>
  >({});

  const [roomStatus, setRoomStatus] =
    createStore<RoomStatus>({
      roomId: null,
      profile: null,
    });

  function removeAllDataCahnnels() {
    Object.values(dataChannels).forEach((channels) => {
      Object.values(channels).forEach((channel) => {
        channel.close();
      });
    });
    setDataChannels({});
  }

  // targetClientId, connection

  const joinRoom = async (): Promise<void> => {
    console.log(`join room`, clientProfile);

    if (sessionService.clientService) {
      return;
    }
    const ClientServiceConstructor =
      getServiceConstructor();
    const cs = new ClientServiceConstructor({
      roomId: clientProfile.roomId,
      password: clientProfile.password,
      client: {
        clientId: clientProfile.clientId,
        name: clientProfile.name,
        avatar: clientProfile.avatar,
      },
    }) as ClientService;

    sessionService.setClientService(cs);

    await cs.createClient();

    cs.listenForJoin(
      async (targetClient: TransferClient) => {
        console.log(`new client join in `, targetClient);

        const session =
          sessionService.addClient(targetClient);
        if (!session) {
          console.error(`no client service setted`);
          return;
        }
        // const updateStats = async (pc: RTCPeerConnection) => {
        //   const reports: any[] = [];
        //   const stats = await pc.getStats();

        //   let candidateType: string | undefined;
        //   stats.forEach((report) => {
        //     reports.push(report);
        //     if (report.type === "transport") {
        //       let activeCandidatePair = stats.get(
        //         report.selectedCandidatePairId,
        //       ) as RTCIceCandidatePairStats;
        //       if (!activeCandidatePair) return;
        //       let remoteCandidate = stats.get(
        //         activeCandidatePair.remoteCandidateId,
        //       );
        //       let localCandidate = stats.get(
        //         activeCandidatePair.localCandidateId,
        //       );
        //       if (
        //         localCandidate?.candidateType ||
        //         remoteCandidate?.candidateType
        //       ) {
        //         candidateType =
        //           localCandidate?.candidateType ??
        //           remoteCandidate?.candidateType;
        //       }
        //     }
        //   });
        //   if (clientSessionInfo[targetClient.clientId]) {
        //     setClientSessionInfo(
        //       targetClient.clientId,
        //       "statsReports",
        //       reports,
        //     );
        //     setClientSessionInfo(
        //       targetClient.clientId,
        //       "candidateType",
        //       candidateType,
        //     );
        //   }
        // };

        // setClientSessionInfo(targetClient.clientId, {
        //   ...targetClient,
        //   onlineStatus: "offline",
        // } satisfies ClientInfo);

        // const polite =
        //   cs.info.createAt < targetClient.createAt;
        // const session = new PeerSession(
        //   cs.getSender(targetClient.clientId),
        //   { polite },
        // );

        const localStream = props.localStream;

        session.addEventListener("message", async (ev) => {
          const message = ev.detail;
          messageStores.setMessage(message, session);

          if (message.type === "send-text") {
            return;
          } else if (message.type === "send-file") {
            const cache = cacheManager.createCache(
              message.fid,
            );
            cache.setInfo({
              fileName: message.fileName,
              fileSize: message.fileSize,
              mimetype: message.mimeType,
              lastModified: message.lastModified,
              chunkSize: message.chunkSize,
              id: message.fid,
            });
            const transferer =
              transferManager.createTransfer(
                cache,
                TransferMode.Receive,
              );

            if (messageStores.addTransfer(transferer)) {
              await transferer.initialize();
            }
          } else if (message.type === "request-file") {
            const cache = cacheManager.getCache(
              message.fid,
            );
            // if (!cache?.getInfo()?.file) return;
            if (!cache) {
              console.warn(
                `cache ${message.fid} not found`,
              );

              return;
            }
            const transferer =
              transferManager.createTransfer(
                cache,
                TransferMode.Send,
              );
            if (!messageStores.addTransfer(transferer)) {
              console.warn(
                `can not add transfer ${transferer.id}, return`,
              );
            }

            for (
              let i = 0;
              i < appOptions.channelsNumber;
              i++
            ) {
              const channel = await session.createChannel(
                `${TRANSFER_CHANNEL_PREFIX}${transferer.id}${v4()}`,
              );
              if (!channel) {
                break;
              }
              transferManager.addChannel(cache.id, channel);
            }

            await transferer.initialize();
            transferer.setSendStatus(message);
            await transferer.sendFile(message.ranges);
          } else if (message.type === "check-message") {
            const index = messageStores.messages.findIndex(
              (msg) => msg.id === message.id,
            );
            if (index === -1) {
              console.warn(
                `check message ${message.id} not found`,
              );
              return;
            }
            const storeMessage =
              messageStores.messages[index];
            if (storeMessage.type === "file") {
              const cache = cacheManager.getCache(
                storeMessage.fid,
              );
              if (!cache) {
                console.warn(
                  `cache ${storeMessage.fid} not found`,
                );
                return;
              }
              const transferer =
                transferManager.createTransfer(
                  cache,
                  TransferMode.Send,
                );

              if (!messageStores.addTransfer(transferer)) {
                console.warn(
                  `can not add transfer ${transferer.id}, return`,
                );
                return;
              }

              for (
                let i = 0;
                i < appOptions.channelsNumber;
                i++
              ) {
                const channel = await session.createChannel(
                  `${TRANSFER_CHANNEL_PREFIX}${transferer.id}${v4()}`,
                );
                if (!channel) break;
                transferManager.addChannel(
                  storeMessage.fid,
                  channel,
                );
              }

              await transferer.initialize();
              await transferer.sendFile();
            }
          }
        });

        session.addEventListener("channel", (ev) => {
          const channel = ev.detail;

          if (
            channel.label.startsWith(
              TRANSFER_CHANNEL_PREFIX,
            )
          ) {
            console.log(`datachannel event`, channel);

            const fileIdWithChannelId =
              channel.label.replace(
                TRANSFER_CHANNEL_PREFIX,
                "",
              );

            const fileId = Object.keys(
              transferManager.transferers,
            ).find((fileId) =>
              fileIdWithChannelId.startsWith(fileId),
            );

            if (!fileId) return;
            console.log(
              `receive channel for file ${fileId}`,
            );

            transferManager.addChannel(fileId, channel);
          }
        });

        session.addEventListener("created", () => {
          const pc = session.peerConnection!;

          if (localStream) {
            const tracks = localStream.getTracks();

            pc.getTransceivers().forEach((transceiver) => {
              const track = tracks.find(
                (t) =>
                  t.kind ===
                  transceiver.receiver.track.kind,
              );
              if (track) {
                transceiver.direction = "sendrecv";
                transceiver.sender.replaceTrack(track);
                transceiver.sender.setStreams(localStream);
              }
            });
          }
          props.onTrackChanged?.(targetClient.clientId, pc);

          const onTrack = ({
            track,
            streams,
          }: RTCTrackEvent) => {
            console.log(`on track event:`, streams, track);
            const stream = streams[0];
            if (!stream) return;
            if (
              remoteStreams[targetClient.clientId] &&
              remoteStreams[targetClient.clientId].id ===
                stream.id
            )
              return;

            stream.addEventListener("removetrack", (ev) => {
              console.log(
                `client ${targetClient.clientId} removetrack`,
                ev.track.id,
              );
              if (stream.getTracks().length === 0) {
                setRemoteStreams(
                  targetClient.clientId,
                  undefined!,
                );
              }
            });

            console.log(
              `new remote stream from client ${targetClient.clientId}`,
              stream.getTracks(),
            );

            setRemoteStreams(targetClient.clientId, stream);
            props.onTrackChanged?.(
              targetClient.clientId,
              pc,
            );
          };
          pc.addEventListener("track", onTrack);
        });

        await session.listen();
        messageStores.setClient(targetClient);

        if (!session.polite) {
          try {
            await session.connect();
          } catch (err) {
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
      },
    );

    cs.listenForLeave((client) => {
      console.log(`client ${client.clientId} leave`);
      sessionService.destorySession(client.clientId);

      setRemoteStreams(client.clientId, undefined!);
    });

    setRoomStatus("roomId", clientProfile.roomId);
  };

  const leaveRoom = async () => {
    const room = roomStatus.roomId;
    if (room) {
      console.log(`on leave room ${room}`);
    }

    updateRemoteStreams(null);

    sessionService.destoryAllSession();
    setRoomStatus("roomId", null);
    setRoomStatus("profile", null);

    setRemoteStreams(reconcile({}));
    removeAllDataCahnnels();
  };

  onCleanup(() => {
    leaveRoom();
  });

  async function updateRemoteStreams(
    stream: MediaStream | null,
  ) {
    for (const session of Object.values(
      sessionService.sessions,
    )) {
      let renegotiate: boolean = false;
      const pc = session.peerConnection;
      if (!pc) return;

      const tracks = stream?.getTracks() || [];
      console.log(`get tracks`, tracks);

      const transceivers = pc.getTransceivers();
      console.log(`get transceivers`, transceivers);
      transceivers.forEach((transceiver) => {
        const track = tracks.find(
          (t) => t.kind === transceiver.receiver.track.kind,
        );
        if (track) {
          if (transceiver.sender.track !== track) {
            transceiver.direction = "sendrecv";
            transceiver.sender.replaceTrack(track);
            stream && transceiver.sender.setStreams(stream);
            renegotiate = true;
          }
        } else {
          if (transceiver.sender.track) {
            transceiver.direction = "recvonly";
            transceiver.sender.replaceTrack(null);
            transceiver.sender.setStreams();
            renegotiate = true;
          }
        }
      });

      if (renegotiate) {
        await session.renegotiate();
        props.onTrackChanged?.(session.targetClientId, pc);
      }
    }
  }

  createEffect(() => {
    updateRemoteStreams(props.localStream);
  });

  const sendText = async (
    text: string,
    session: PeerSession,
  ) => {
    const message = {
      id: v4(),
      type: "send-text",
      client: session.clientId,
      target: session.targetClientId,
      data: text,
      createdAt: Date.now(),
    } as SendTextMessage;
    session.sendMessage(message);
    messageStores.setMessage(message, session);
    console.log(`send text message`, message);
  };

  const sendFile = async (
    file: File,
    session: PeerSession,
  ) => {
    const fid = v4();
    const target = session.targetClientId;
    const client = session.clientId;
    const message = {
      id: v4(),
      type: "send-file",
      client: client,
      target: target,
      fid: fid,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      lastModified: file.lastModified,
      createdAt: Date.now(),
      chunkSize: appOptions.chunkSize,
    } satisfies SendFileMessage;

    messageStores.setMessage(message, session);
    session.sendMessage(message);

    const cache = cacheManager.createCache(message.fid);
    cache.setInfo({
      fileName: message.fileName,
      fileSize: message.fileSize,
      mimetype: message.mimeType,
      lastModified: message.lastModified,
      chunkSize: message.chunkSize,
      id: message.fid,
      file: file,
    });

    console.log(`send file message`, message);
  };

  const send = async (
    data: string | File,
    { target }: SendOptions,
  ): Promise<boolean> => {
    const sessions = target
      ? sessionService.sessions[target]
        ? [sessionService.sessions[target]]
        : []
      : Object.values(sessionService.sessions);

    if (sessions.length === 0) return false;

    for (const session of sessions) {
      if (typeof data === "string") {
        sendText(data, session);
      } else if (data instanceof File) {
        sendFile(data, session);
      }
    }

    return true;
  };

  const requestFile = async (
    target: ClientID,
    fileId: string,
  ) => {
    const session = sessionService.sessions[target];
    if (!session) {
      console.warn(
        `can not request file from target: ${target}, target not exist`,
      );
      return;
    }
    const client = sessionService.clientInfo[target];
    if (client.onlineStatus !== "online") {
      console.warn(
        `can not request file from target: ${target}, client status is ${client.onlineStatus}`,
      );

      return;
    }

    const cache = cacheManager.getCache(fileId);
    if (!cache) {
      console.warn(`cache ${fileId} not exist`);
      return;
    }

    const ranges = await cache.getReqRanges();
    if (!ranges) {
      return;
    }

    if (getRangesLength(ranges) === 0) {
      messageStores.addCache(cache);
      await cache.getFile();
      return;
    }

    const transferer = transferManager.createTransfer(
      cache,
      TransferMode.Receive,
    );

    if (!messageStores.addTransfer(transferer)) {
      return;
    }

    await transferer.initialize();

    const message = {
      id: v4(),
      type: "request-file",
      fid: fileId,
      client: session.clientId,
      target: session.targetClientId,
      ranges: ranges,
      createdAt: Date.now(),
    } satisfies RequestFileMessage;

    messageStores.setMessage(message, session);
    session.sendMessage(message);

    await transferer.initialize();
  };

  return (
    <WebRTCContext.Provider
      value={{
        joinRoom,
        leaveRoom,
        send,
        requestFile,
        roomStatus,
        remoteStreams: remoteStreams,
      }}
    >
      {props.children}
    </WebRTCContext.Provider>
  );
};
