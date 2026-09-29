import type { PeerSession } from "@/libs/domain/session";
import type { messageStores } from "./message-store";
import {
  createSessionMessage,
  type AckMessage,
  type FileOfferResultMessage,
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
    onStored?(
      message: MessageOf<TrackedType>,
    ): void | Promise<void>;
  };

/** The only bridge between control-request lifecycle and persisted chat state. */
export class PeerMessagingService {
  private readonly offText: () => void;
  constructor(
    private readonly protocol: WebRtcProtocol,
    private readonly store: MessageStore,
  ) {
    this.offText = protocol.handle(
      "send-text",
      ({ message }) => store.setReceiveMessage(message),
    );
  }

  dispose(): void {
    this.offText();
  }

  async send<T extends TrackedType>(
    session: PeerSession,
    type: T,
    payload: MessagePayload<T>,
    options: TrackedSendOptions = {},
  ): Promise<{
    message: MessageOf<T>;
    ackMessage: AckMessage | FileOfferResultMessage;
  } | null> {
    let prepared: MessageOf<T> | undefined;
    let stored = false;
    let preparation: Promise<void> | undefined;
    try {
      const ackMessage = await this.protocol.call(
        session,
        type,
        payload,
        {
          ...options,
          onPrepared: (message) =>
            (preparation = (async () => {
              prepared = message;
              if (options.retry)
                await this.store.retrySendMessage(message);
              else await this.store.setSendMessage(message);
              stored = true;
              await options.onStored?.(message);
            })()),
        },
      );
      await preparation;
      await this.store.setReceiveMessage(
        ackMessage.type === "file-offer-result"
          ? createSessionMessage(
              {
                clientId: session.targetClientId,
                targetClientId: session.clientId,
              },
              "ack",
              { mode: "receive" },
              { id: ackMessage.id },
            )
          : ackMessage,
      );
      return { message: prepared!, ackMessage };
    } catch (error) {
      if (
        error instanceof RtcProtocolError &&
        error.code === "already-pending"
      ) {
        if (options.throwOnError) throw error;
        return null;
      }
      // Closing a channel may settle the request while durable insertion is pending.
      // Retire the stored message after that insertion, never leave it sending forever.
      await preparation?.catch((preparationError) => {
        // A local persistence failure is not a transport failure. Keep its
        // original type so the UI can report storage/permission errors.
        if (!stored) throw preparationError;
      });
      if (prepared && stored)
        await this.fail(prepared, error);
      if (!stored || options.throwOnError) throw error;
      return null;
    }
  }

  async fail(
    message: MessageOf<TrackedType>,
    error: unknown,
  ): Promise<void> {
    await this.store.setReceiveMessage(
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
