import type { Client } from "@/libs/domain/client";
import type {
  FileTransferMessage,
  RoomMessage,
} from "@/libs/domain/message";
import type { ChunkMetaData } from "@/libs/domain/file";
import { normalizePeerProfile } from "@/libs/domain/profile";
import type { PeerSession } from "@/libs/domain/session";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";
import {
  ROOM_CHAT_MAX_TEXT_LENGTH,
  ROOM_FILE_FEATURE,
} from "@/libs/domain/protocol/messages";

export type RoomChatScope = {
  roomId: string;
  namespace: string;
  conversationId: string;
};
export type RoomChatCapability =
  | "checking"
  | "supported"
  | "unsupported";
export type RoomDeliveryStatus =
  | "sending"
  | "delivered"
  | "failed"
  | "unsupported";

export interface RoomMessagingServiceOptions {
  supportsFiles?: boolean;
  supportsContent?(session: PeerSession): boolean;
  reuseFile?(
    message: FileTransferMessage,
    signal: AbortSignal,
  ): Promise<boolean>;
  onFileReused?(
    message: FileTransferMessage,
    peerId: string,
  ): Promise<void>;
  getRoom(): RoomChatScope | null;
  getSessions(): PeerSession[];
  getLocalClient(): Client;
  store: {
    /** True only for a new durable insertion, including concurrent duplicates. */
    putRoomMessage(message: RoomMessage): Promise<boolean>;
    setRoomDelivery(
      messageId: string,
      peerId: string,
      status: RoomDeliveryStatus,
    ): Promise<void>;
  };
  /** Called only for newly stored, current-room file offers; never for history. */
  onFileReceived?(message: FileTransferMessage): void;
  onCapabilitiesChange?(
    capabilities: Readonly<
      Record<string, RoomChatCapability>
    >,
  ): void;
  onFileCapabilitiesChange?(
    capabilities: Readonly<
      Record<string, RoomChatCapability>
    >,
  ): void;
}

export type RoomFileBinding = {
  room: RoomChatScope;
  senderToken: string;
  recipientToken: string;
  signal: AbortSignal;
  assertCurrent(): void;
};

type Binding = {
  session: PeerSession;
  room: RoomChatScope;
  scopeKey: string;
  lifetime: AbortController;
  epoch: AbortController;
  files: AbortController;
  token: string;
  remoteToken?: string;
  remoteFeatures?: readonly string[];
  remoteOfferAt: number;
  remoteOfferWaiters: Set<() => void>;
  acknowledged: boolean;
  capability: RoomChatCapability;
  handshake?: Promise<void>;
};

type Recipient = {
  binding: Binding;
  /** Snapshot before persistence or concurrency limits can yield execution. */
  epoch: AbortController;
};

/** Online-only fan-out. One stored message owns a fixed recipient snapshot. */
export class RoomMessagingService {
  private readonly bindings = new Map<string, Binding>();
  private readonly unsubscribe: (() => void)[];
  private readonly retries = new Set<string>();
  private scopeKey: string | null = null;
  private scopeRevision = 0;
  private scopeLifetime = new AbortController();
  get scopeSignal(): AbortSignal {
    this.syncSessions();
    return this.scopeLifetime.signal;
  }
  private lastOfferAt = 0;
  private disposed = false;

  constructor(
    private readonly protocol: WebRtcProtocol,
    private readonly options: RoomMessagingServiceOptions,
  ) {
    this.unsubscribe = [
      protocol.handle(
        "room-capabilities",
        ({ session, message }) => {
          this.syncSessions();
          const binding = this.currentBinding(
            session,
            message.roomId,
          );
          if (message.createdAt < binding.remoteOfferAt)
            throw new Error("Stale room capability offer");
          binding.remoteOfferAt = message.createdAt;
          if (
            binding.remoteToken &&
            (binding.remoteToken !== message.token ||
              (binding.remoteFeatures?.includes(
                ROOM_FILE_FEATURE,
              ) &&
                !message.features?.includes(
                  ROOM_FILE_FEATURE,
                )))
          ) {
            binding.files.abort();
            binding.files = new AbortController();
          }
          binding.remoteToken = message.token;
          binding.remoteFeatures = message.features;
          this.publishCapabilities();
          for (const ready of binding.remoteOfferWaiters)
            ready();
          if (binding.acknowledged)
            this.setCapability(binding, "supported");
          // The other side can become ready after our initial probe timed out.
          if (
            !binding.handshake ||
            binding.capability === "unsupported"
          )
            this.startHandshake(binding);
        },
      ),
      protocol.handle(
        "send-room-text",
        async ({ session, message, signal }) => {
          this.syncSessions();
          const binding = this.currentBinding(
            session,
            message.roomId,
          );
          if (
            message.senderToken !== binding.remoteToken ||
            message.recipientToken !== binding.token
          )
            throw new Error("Stale room message binding");
          if (
            signal.aborted ||
            binding.epoch.signal.aborted
          )
            throw new Error("Room session closed");
          const epoch = binding.epoch;
          await this.options.store.putRoomMessage({
            id: message.id,
            type: "text",
            data: message.data,
            createdAt: message.createdAt,
            client: message.client,
            target: message.target,
            status: "received",
            conversationId: binding.room.conversationId,
            room: {
              roomId: message.roomId,
              senderName: message.senderName,
              senderAvatar: message.senderAvatar,
            },
          });
          // The protocol ACK follows durable, idempotent local insertion.
          if (
            signal.aborted ||
            epoch.signal.aborted ||
            !this.isCurrent(binding)
          )
            throw new Error(
              "Room changed while receiving a message",
            );
        },
      ),
      protocol.handle(
        "send-room-file",
        async ({ session, message, signal }) => {
          const binding = this.validateFileBinding(
            session,
            message,
          );
          if (signal.aborted)
            throw new Error("Room session closed");
          const offer: FileTransferMessage = {
            id: message.id,
            type: "file",
            fid: message.fid,
            fileName: message.fileName,
            fileSize: message.fileSize,
            mimeType: message.mimeType,
            lastModified: message.lastModified,
            chunkSize: message.chunkSize,
            fingerprint: message.fingerprint,
            createdAt: message.createdAt,
            client: message.client,
            target: message.target,
            status: "received",
            conversationId: binding.room.conversationId,
            room: {
              roomId: message.roomId,
              senderName: message.senderName,
              senderAvatar: message.senderAvatar,
            },
          };
          const inserted =
            await this.options.store.putRoomMessage(offer);
          binding.assertCurrent();
          if (signal.aborted)
            throw new Error("Room session closed");
          if (
            message.fingerprint &&
            this.options.reuseFile
          ) {
            const reused = await this.options.reuseFile(
              offer,
              binding.signal,
            );
            binding.assertCurrent();
            if (reused)
              return {
                fid: message.fid,
                disposition: "have" as const,
              };
          }
          if (inserted)
            this.options.onFileReceived?.(offer);
          if (message.fingerprint)
            return {
              fid: message.fid,
              disposition: "deferred" as const,
              reason: "user" as const,
            };
        },
      ),
    ];
  }

  get currentScopeKey(): string | null {
    this.syncSessions();
    return !this.disposed && this.scopeKey
      ? JSON.stringify([this.scopeKey, this.scopeRevision])
      : null;
  }

  get fileCapabilities(): Readonly<
    Record<string, RoomChatCapability>
  > {
    return Object.fromEntries(
      [...this.bindings].map(([peer, binding]) => [
        peer,
        this.fileCapability(binding),
      ]),
    );
  }

  private fileCapability(
    binding: Binding,
  ): RoomChatCapability {
    if (!this.options.supportsFiles) return "unsupported";
    if (binding.capability !== "supported")
      return binding.capability;
    return binding.remoteFeatures?.includes(
      ROOM_FILE_FEATURE,
    )
      ? "supported"
      : "unsupported";
  }

  private fileBinding(
    binding: Binding,
    inbound = false,
  ): RoomFileBinding {
    const epoch = binding.epoch;
    const files = binding.files;
    const remoteToken = binding.remoteToken;
    const assertCurrent = () => {
      if (
        !this.isCurrent(binding) ||
        binding.epoch !== epoch ||
        binding.files !== files ||
        files.signal.aborted ||
        binding.remoteToken !== remoteToken ||
        epoch.signal.aborted ||
        !binding.session.isMessageChannelReady ||
        (inbound
          ? !this.options.supportsFiles ||
            !binding.remoteFeatures?.includes(
              ROOM_FILE_FEATURE,
            )
          : this.fileCapability(binding) !== "supported") ||
        !binding.remoteToken
      )
        throw new Error(
          "Room file session is no longer available",
        );
    };
    assertCurrent();
    return {
      room: { ...binding.room },
      senderToken: binding.token,
      recipientToken: binding.remoteToken!,
      signal: files.signal,
      assertCurrent,
    };
  }

  async getFileBinding(
    session: PeerSession,
  ): Promise<RoomFileBinding> {
    this.syncSessions();
    const room = this.options.getRoom();
    if (!room)
      throw new Error(
        "Join the room to transfer this file",
      );
    const binding = this.currentBinding(
      session,
      room.roomId,
    );
    const epoch = binding.epoch;
    await binding.handshake;
    if (binding.epoch !== epoch)
      throw new Error("Room file session changed");
    return this.fileBinding(binding);
  }

  validateFileBinding(
    session: PeerSession,
    message: {
      roomId: string;
      senderToken: string;
      recipientToken: string;
    },
  ): RoomFileBinding {
    this.syncSessions();
    const binding = this.currentBinding(
      session,
      message.roomId,
    );
    if (
      message.senderToken !== binding.remoteToken ||
      message.recipientToken !== binding.token
    )
      throw new Error("Stale room file binding");
    return this.fileBinding(binding, true);
  }

  get capabilities(): Readonly<
    Record<string, RoomChatCapability>
  > {
    return Object.fromEntries(
      [...this.bindings].map(([peer, binding]) => [
        peer,
        binding.capability,
      ]),
    );
  }

  private getScopeKey(): string | null {
    const room = this.options.getRoom();
    return room
      ? JSON.stringify([
          room.namespace,
          room.roomId,
          room.conversationId,
          this.options.getLocalClient().clientId,
        ])
      : null;
  }

  syncSessions(): void {
    if (this.disposed) return;
    const key = this.getScopeKey();
    if (key !== this.scopeKey) {
      this.scopeLifetime.abort();
      this.scopeLifetime = new AbortController();
      this.scopeRevision++;
      for (const binding of this.bindings.values())
        this.retire(binding);
      this.bindings.clear();
      this.scopeKey = key;
      this.publishCapabilities();
    }
    if (!key) return;
    const sessions = this.options.getSessions();
    for (const [peer, binding] of this.bindings) {
      if (!sessions.includes(binding.session)) {
        this.retire(binding);
        this.bindings.delete(peer);
        this.publishCapabilities();
      }
    }
    for (const session of sessions)
      this.bindSession(session);
  }

  bindSession(session: PeerSession): void {
    if (this.disposed) return;
    const room = this.options.getRoom();
    const key = this.getScopeKey();
    if (key !== this.scopeKey) this.syncSessions();
    if (
      !room ||
      !key ||
      session.clientId !==
        this.options.getLocalClient().clientId
    )
      return;
    const existing = this.bindings.get(
      session.targetClientId,
    );
    if (existing?.session === session) return;
    if (existing) this.retire(existing);
    const binding: Binding = {
      session,
      room: { ...room },
      scopeKey: key,
      lifetime: new AbortController(),
      epoch: new AbortController(),
      files: new AbortController(),
      token: crypto.randomUUID(),
      remoteOfferAt: -1,
      remoteOfferWaiters: new Set(),
      acknowledged: false,
      capability: "checking",
    };
    this.bindings.set(session.targetClientId, binding);
    session.addEventListener(
      "messagechannelchange",
      ({ detail }) => {
        if (!this.isCurrent(binding)) return;
        if (detail === "ready")
          this.startHandshake(binding);
        else this.resetEpoch(binding);
      },
      { signal: binding.lifetime.signal },
    );
    session.addEventListener(
      "statuschange",
      ({ detail }) => {
        if (
          detail !== "closed" ||
          this.bindings.get(session.targetClientId) !==
            binding
        )
          return;
        this.retire(binding);
        this.bindings.delete(session.targetClientId);
        this.publishCapabilities();
      },
      { signal: binding.lifetime.signal },
    );
    this.publishCapabilities();
    if (session.isMessageChannelReady)
      this.startHandshake(binding);
  }

  private resetEpoch(binding: Binding): void {
    binding.epoch.abort();
    binding.epoch = new AbortController();
    binding.files.abort();
    binding.files = new AbortController();
    binding.token = crypto.randomUUID();
    binding.remoteToken = undefined;
    binding.remoteFeatures = undefined;
    binding.remoteOfferAt = -1;
    binding.acknowledged = false;
    binding.handshake = undefined;
    this.setCapability(binding, "checking");
  }

  private startHandshake(binding: Binding): void {
    if (
      !this.isCurrent(binding) ||
      !binding.session.isMessageChannelReady
    )
      return;
    if (
      binding.handshake &&
      binding.capability !== "unsupported"
    )
      return;
    const epoch = binding.epoch;
    this.setCapability(binding, "checking");
    const createdAt = (this.lastOfferAt = Math.max(
      Date.now(),
      this.lastOfferAt + 1,
    ));
    binding.handshake = Promise.resolve().then(async () => {
      try {
        await this.protocol.call(
          binding.session,
          "room-capabilities",
          {
            roomId: binding.room.roomId,
            token: binding.token,
            ...(this.options.supportsFiles
              ? { features: [ROOM_FILE_FEATURE] }
              : {}),
          },
          {
            signal: epoch.signal,
            timeoutMs: 1_200,
            sendTimeoutMs: 1_200,
            retries: 1,
            retryDelayMs: 100,
            createdAt,
          },
        );
        if (
          !this.isCurrent(binding) ||
          binding.epoch !== epoch
        )
          return;
        binding.acknowledged = true;
        // The default RTC control channel is unordered. Its ACK can arrive
        // before the peer's own offer, so receiving only the ACK is not a
        // failed negotiation and must not fail a send already waiting here.
        await this.waitForRemoteOffer(binding, epoch);
        if (
          this.isCurrent(binding) &&
          binding.epoch === epoch
        )
          this.setCapability(binding, "supported");
      } catch {
        if (
          this.isCurrent(binding) &&
          binding.epoch === epoch
        )
          this.setCapability(binding, "unsupported");
      }
    });
  }

  private waitForRemoteOffer(
    binding: Binding,
    epoch: AbortController,
  ): Promise<void> {
    if (epoch.signal.aborted)
      return Promise.reject(
        new Error("Room binding closed"),
      );
    if (binding.remoteToken) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        binding.remoteOfferWaiters.delete(onOffer);
        epoch.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onOffer = () => finish();
      const onAbort = () =>
        finish(new Error("Room binding closed"));
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Peer did not announce a room binding",
            ),
          ),
        1_200,
      );
      binding.remoteOfferWaiters.add(onOffer);
      epoch.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });
  }

  private currentBinding(
    session: PeerSession,
    roomId: string,
  ): Binding {
    const binding = this.bindings.get(
      session.targetClientId,
    );
    if (
      !binding ||
      binding.session !== session ||
      !this.isCurrent(binding) ||
      binding.room.roomId !== roomId ||
      !session.isMessageChannelReady
    )
      throw new Error(
        "Message does not belong to the active room session",
      );
    return binding;
  }

  private isCurrent(binding: Binding): boolean {
    return (
      !this.disposed &&
      !binding.lifetime.signal.aborted &&
      this.bindings.get(binding.session.targetClientId) ===
        binding &&
      binding.scopeKey === this.getScopeKey()
    );
  }

  private setCapability(
    binding: Binding,
    value: RoomChatCapability,
  ): void {
    if (binding.capability === value) return;
    binding.capability = value;
    this.publishCapabilities();
  }

  private publishCapabilities(): void {
    this.options.onCapabilitiesChange?.(this.capabilities);
    this.options.onFileCapabilitiesChange?.(
      this.fileCapabilities,
    );
  }

  private retire(binding: Binding): void {
    binding.epoch.abort();
    binding.files.abort();
    binding.lifetime.abort();
  }

  async send(text: string): Promise<void> {
    const data = text.trim();
    if (!data || data.length > ROOM_CHAT_MAX_TEXT_LENGTH)
      throw new Error(
        "Room messages must contain 1 to 65536 characters",
      );
    await this.sendContent({ type: "text", data });
  }

  async sendFile(
    info: ChunkMetaData,
    scopeKey: string,
    messageId: string,
  ): Promise<void> {
    if (
      !this.options.supportsFiles ||
      scopeKey !== this.currentScopeKey
    )
      throw new Error(
        "Room changed while preparing a file",
      );
    if (!info.chunkSize)
      throw new Error("File chunk size is missing");
    await this.sendContent(
      {
        type: "file",
        fid: info.id,
        fileName: info.fileName,
        fileSize: info.fileSize,
        mimeType: info.mimetype,
        lastModified: info.lastModified,
        chunkSize: info.chunkSize,
        fingerprint: info.fingerprint,
      },
      messageId,
    );
  }

  private async sendContent(
    content:
      | { type: "text"; data: string }
      | Pick<
          FileTransferMessage,
          | "type"
          | "fid"
          | "fileName"
          | "fileSize"
          | "mimeType"
          | "lastModified"
          | "chunkSize"
          | "fingerprint"
        >,
    messageId: string = crypto.randomUUID(),
  ): Promise<void> {
    this.syncSessions();
    const room = this.options.getRoom();
    if (this.disposed || !room)
      throw new Error(
        "Join a room before sending a room message",
      );
    const local = this.options.getLocalClient();
    const profile = normalizePeerProfile(
      local,
      local.clientId,
    );
    const recipients = [...this.bindings.values()]
      .filter(
        (binding) =>
          this.isCurrent(binding) &&
          binding.session.isMessageChannelReady,
      )
      .map((binding) => ({
        binding,
        epoch: binding.epoch,
      }));
    if (!recipients.length)
      throw new Error(
        "No other room participants are online",
      );
    const message: RoomMessage = {
      ...content,
      id: messageId,
      createdAt: Date.now(),
      client: local.clientId,
      target: room.conversationId,
      conversationId: room.conversationId,
      status: "sending",
      room: {
        roomId: room.roomId,
        senderName: profile.name,
        senderAvatar: profile.avatar,
      },
      deliveries: Object.fromEntries(
        recipients.map(({ binding }) => [
          binding.session.targetClientId,
          "sending" as const,
        ]),
      ),
    };
    await this.options.store.putRoomMessage(message);
    await this.deliverAll(message, recipients);
  }

  async retry(message: RoomMessage): Promise<void> {
    this.syncSessions();
    const room = this.options.getRoom();
    if (
      this.disposed ||
      !room ||
      !message.room ||
      message.conversationId !== room.conversationId ||
      message.room.roomId !== room.roomId ||
      message.client !==
        this.options.getLocalClient().clientId
    )
      throw new Error(
        "Only your messages in the active room can be retried",
      );
    if (this.retries.has(message.id)) return;
    this.retries.add(message.id);
    try {
      const recipients = Object.entries(
        message.deliveries ?? {},
      )
        .filter(([, status]) => status === "failed")
        .flatMap(([peer]) => {
          const binding = this.bindings.get(peer);
          return binding &&
            this.isCurrent(binding) &&
            binding.session.isMessageChannelReady
            ? [{ binding, epoch: binding.epoch }]
            : [];
        });
      await this.deliverAll(message, recipients);
    } finally {
      this.retries.delete(message.id);
    }
  }

  private async deliverAll(
    message: RoomMessage,
    recipients: Recipient[],
  ): Promise<void> {
    let index = 0;
    const failures: unknown[] = [];
    await Promise.all(
      Array.from(
        { length: Math.min(4, recipients.length) },
        async () => {
          while (index < recipients.length) {
            const recipient = recipients[index++];
            try {
              await this.deliver(message, recipient);
            } catch (error) {
              failures.push(error);
            }
          }
        },
      ),
    );
    if (failures.length) throw failures[0];
  }

  private async deliver(
    message: RoomMessage,
    { binding, epoch }: Recipient,
  ): Promise<void> {
    const peer = binding.session.targetClientId;
    await binding.handshake;
    if (
      !this.isCurrent(binding) ||
      binding.epoch !== epoch ||
      !binding.session.isMessageChannelReady
    ) {
      await this.options.store.setRoomDelivery(
        message.id,
        peer,
        "failed",
      );
      return;
    }
    if (
      binding.capability !== "supported" ||
      !binding.remoteToken ||
      (message.type === "file" &&
        this.fileCapability(binding) !== "supported")
    ) {
      await this.options.store.setRoomDelivery(
        message.id,
        peer,
        "unsupported",
      );
      return;
    }
    await this.options.store.setRoomDelivery(
      message.id,
      peer,
      "sending",
    );
    try {
      const payload = {
        roomId: message.room!.roomId,
        senderToken: binding.token,
        recipientToken: binding.remoteToken,
        senderName: message.room!.senderName,
        // Profiles travel separately, avoiding a repeated base64 avatar.
        senderAvatar: null,
      };
      const options = {
        id: message.id,
        createdAt: message.createdAt,
        signal: epoch.signal,
      };
      if (message.type === "text")
        await this.protocol.call(
          binding.session,
          "send-room-text",
          { ...payload, data: message.data },
          options,
        );
      else {
        if (!message.fid)
          throw new Error(
            "File offer is missing its cache id",
          );
        const result = await this.protocol.call(
          binding.session,
          "send-room-file",
          {
            ...payload,
            fid: message.fid,
            fileName: message.fileName,
            fileSize: message.fileSize,
            mimeType: message.mimeType,
            lastModified: message.lastModified,
            chunkSize: message.chunkSize,
            ...(this.options.supportsContent?.(
              binding.session,
            ) && message.fingerprint
              ? { fingerprint: message.fingerprint }
              : {}),
          },
          options,
        );
        if (
          result.type === "file-offer-result" &&
          result.disposition === "have"
        )
          await this.options.onFileReused?.(message, peer);
      }
    } catch {
      await this.options.store.setRoomDelivery(
        message.id,
        peer,
        "failed",
      );
      return;
    }
    await this.options.store.setRoomDelivery(
      message.id,
      peer,
      "delivered",
    );
  }

  dispose(): void {
    this.scopeLifetime.abort();
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    for (const binding of this.bindings.values())
      this.retire(binding);
    this.bindings.clear();
    this.publishCapabilities();
  }
}
