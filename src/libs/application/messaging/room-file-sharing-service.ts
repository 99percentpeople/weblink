import type {
  ChunkMetaData,
  FileSource,
} from "@/libs/domain/file";
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";
import type { PeerSession } from "@/libs/domain/session";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";
import type { FileTransferService } from "../transfer/file-transfer-service";
import type { RoomMessagingService } from "./room-messaging-service";
import { combineAbortSignals } from "@/libs/utils/abort-signals";

export interface RoomFileSharingOptions {
  rooms: Pick<
    RoomMessagingService,
    | "currentScopeKey"
    | "sendFile"
    | "getFileBinding"
    | "validateFileBinding"
  > &
    Partial<Pick<RoomMessagingService, "scopeSignal">>;
  files: Pick<
    FileTransferService,
    | "prepareRoomFile"
    | "receiveFileOffer"
    | "serveFileOffer"
  > &
    Partial<
      Pick<FileTransferService, "releasePreparedFile">
    >;
  getMessages(): readonly StoreMessage[];
  getSession(peerId: string): PeerSession | undefined;
  getLocalClientId(): string;
  getAutoDownloadLimit?(conversationId: string): number;
}

/** Room metadata fan-out and explicitly requested, peer-specific binary runs. */
export class RoomFileSharingService {
  private readonly unsubscribe: () => void;
  private readonly pending = new Set<string>();
  private readonly preparing = new Set<AbortController>();

  constructor(
    private readonly protocol: WebRtcProtocol,
    private readonly options: RoomFileSharingOptions,
  ) {
    this.unsubscribe = protocol.handle(
      "request-room-file",
      async ({ session, message, signal }) => {
        const binding = options.rooms.validateFileBinding(
          session,
          message,
        );
        const offer = this.getOffer(message.offerId);
        if (
          offer.client !== session.clientId ||
          offer.fid !== message.fid ||
          offer.conversationId !==
            binding.room.conversationId ||
          offer.room?.roomId !== binding.room.roomId ||
          !Object.hasOwn(
            offer.deliveries ?? {},
            session.targetClientId,
          ) ||
          offer.deliveries?.[session.targetClientId] ===
            "unsupported"
        )
          throw new Error(
            "This file was not offered to this room participant",
          );
        const chunks = Math.ceil(
          offer.fileSize / offer.chunkSize,
        );
        for (const range of message.ranges ?? []) {
          const [start, end] =
            typeof range === "number"
              ? [range, range]
              : range;
          if (start < 0 || end < start || end >= chunks)
            throw new Error(
              "Requested chunks are outside the offered file",
            );
        }
        if (signal.aborted)
          throw new Error("Room file session closed");
        await options.files.serveFileOffer(session, {
          fid: message.fid,
          messageId: offer.id,
          ranges: message.ranges,
          resume: message.resume,
          info: this.metadata(offer),
          signal: binding.signal,
        });
        binding.assertCurrent();
      },
    );
  }

  async sendFile(file: FileSource): Promise<void> {
    const scopeKey = this.options.rooms.currentScopeKey;
    if (!scopeKey)
      throw new Error("Join a room before sharing a file");
    const messageId = crypto.randomUUID();
    const controller = new AbortController();
    this.preparing.add(controller);
    const scopeSignal = this.options.rooms.scopeSignal;
    const { signal, dispose } = combineAbortSignals([
      scopeSignal,
      controller.signal,
    ]);
    let preparedId: string | undefined;
    try {
      const info = await this.options.files.prepareRoomFile(
        file,
        {
          messageId,
          clientId: this.options.getLocalClientId(),
        },
        signal,
      );
      preparedId = info.id;
      signal.throwIfAborted();
      await this.options.rooms.sendFile(
        info,
        scopeKey,
        messageId,
      );
    } catch (error) {
      if (
        preparedId &&
        !this.options
          .getMessages()
          .some(
            (message) =>
              message.type === "file" &&
              message.fid === preparedId,
          )
      )
        await this.options.files.releasePreparedFile?.(
          preparedId,
        );
      throw error;
    } finally {
      dispose();
      this.preparing.delete(controller);
    }
  }

  async requestFile(
    message: FileTransferMessage,
  ): Promise<void> {
    if (this.pending.has(message.id)) return;
    this.pending.add(message.id);
    try {
      // Use the persisted offer, never editable presentation metadata.
      const offer = this.getOffer(message.id);
      if (offer.client === this.options.getLocalClientId())
        throw new Error("You already own this file");
      const session = this.options.getSession(offer.client);
      if (!session)
        throw new Error(
          "The file sender must be online in this room",
        );
      const binding =
        await this.options.rooms.getFileBinding(session);
      if (
        offer.conversationId !==
          binding.room.conversationId ||
        offer.room?.roomId !== binding.room.roomId
      )
        throw new Error(
          "Join the original room to transfer this file",
        );
      await this.options.files.receiveFileOffer(
        session,
        this.metadata(offer),
        {
          messageId: offer.id,
          signal: binding.signal,
          reused: async () => {
            binding.assertCurrent();
            if (!offer.fingerprint) return;
            await this.protocol.call(
              session,
              "file-content-ready",
              {
                offerId: offer.id,
                fid: offer.fid!,
                fingerprint: offer.fingerprint,
                roomId: binding.room.roomId,
                senderToken: binding.senderToken,
                recipientToken: binding.recipientToken,
              },
              { signal: binding.signal, retries: 2 },
            );
          },
          request: async (ranges, signal) => {
            binding.assertCurrent();
            await this.protocol.call(
              session,
              "request-room-file",
              {
                roomId: binding.room.roomId,
                senderToken: binding.senderToken,
                recipientToken: binding.recipientToken,
                offerId: offer.id,
                fid: offer.fid!,
                ranges,
                resume: true,
              },
              { signal },
            );
            binding.assertCurrent();
          },
        },
      );
    } finally {
      this.pending.delete(message.id);
    }
  }

  /** Only called for a freshly received offer, never by rendering or history load. */
  async autoDownloadFile(
    message: FileTransferMessage,
  ): Promise<void> {
    const offer = this.getOffer(message.id);
    const limit = offer.conversationId
      ? this.options.getAutoDownloadLimit?.(
          offer.conversationId,
        )
      : undefined;
    if (
      !Number.isSafeInteger(limit) ||
      !limit ||
      limit < 0 ||
      !Number.isSafeInteger(offer.fileSize) ||
      offer.fileSize < 0 ||
      offer.fileSize > limit ||
      offer.client === this.options.getLocalClientId() ||
      offer.target !== this.options.getLocalClientId() ||
      offer.transferStatus !== undefined
    )
      return;
    await this.requestFile(offer);
  }

  private getOffer(id: string): FileTransferMessage {
    const message = this.options
      .getMessages()
      .find((item) => item.id === id);
    if (
      !message ||
      message.type !== "file" ||
      !message.room ||
      !message.fid
    )
      throw new Error(
        "Room file offer is no longer available",
      );
    return message;
  }

  private metadata(
    offer: FileTransferMessage,
  ): ChunkMetaData {
    return {
      id: offer.fid!,
      fileName: offer.fileName,
      fileSize: offer.fileSize,
      mimetype: offer.mimeType,
      lastModified: offer.lastModified,
      chunkSize: offer.chunkSize,
      fingerprint: offer.fingerprint,
      createdAt: offer.createdAt,
      from: offer.client,
      roomAttachment: true,
      roomOfferId: offer.id,
    };
  }

  dispose(): void {
    for (const controller of this.preparing)
      controller.abort();
    this.unsubscribe();
  }
}
