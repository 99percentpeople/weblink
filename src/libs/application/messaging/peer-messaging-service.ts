import type { PeerSession } from "@/libs/domain/session";
import type { messageStores } from "./message-store";
import {
  createSessionMessage,
  type AckMessage,
  type MessageMetadata,
  type MessageOf,
  type MessagePayload,
} from "@/libs/domain/protocol/messages";
import {
  type RequestOptions,
  RtcProtocolError,
} from "@/libs/domain/protocol/errors";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";

type TrackedType =
  | "send-text"
  | "send-file"
  | "request-file";
type MessageStore = Pick<
  typeof messageStores,
  | "setSendMessage"
  | "retrySendMessage"
  | "setReceiveMessage"
>;
export type TrackedSendOptions = RequestOptions &
  MessageMetadata & {
    retry?: boolean;
    /** Nested remote commands must propagate failure instead of ACKing success. */
    throwOnError?: boolean;
  };

/** The only bridge between control-request lifecycle and persisted chat state. */
export class PeerMessagingService {
  constructor(
    private readonly protocol: WebRtcProtocol,
    private readonly store: MessageStore,
  ) {}

  async send<T extends TrackedType>(
    session: PeerSession,
    type: T,
    payload: MessagePayload<T>,
    options: TrackedSendOptions = {},
  ): Promise<{
    message: MessageOf<T>;
    ackMessage: AckMessage;
  } | null> {
    let prepared: MessageOf<T> | undefined;
    try {
      const ackMessage = await this.protocol.call(
        session,
        type,
        payload,
        {
          ...options,
          onPrepared: (message) => {
            prepared = message;
            if (options.retry)
              this.store.retrySendMessage(message);
            else this.store.setSendMessage(message);
          },
        },
      );
      this.store.setReceiveMessage(ackMessage);
      return { message: prepared!, ackMessage };
    } catch (error) {
      if (
        error instanceof RtcProtocolError &&
        error.code === "already-pending"
      ) {
        if (options.throwOnError) throw error;
        return null;
      }
      if (prepared) this.fail(prepared, error);
      if (options.throwOnError) throw error;
      if (!prepared)
        console.warn(
          "[PeerMessagingService] request could not be prepared",
          error,
        );
      return null;
    }
  }

  fail(
    message: MessageOf<TrackedType>,
    error: unknown,
  ): void {
    this.store.setReceiveMessage(
      createSessionMessage(
        {
          clientId: message.client,
          targetClientId: message.target,
        },
        "error",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        { id: message.id },
      ),
    );
  }
}
