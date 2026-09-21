import type { PeerSession } from "../session";
import {
  createSessionMessage,
  isRequestType,
  requestSpec,
  type AckMessage,
  type HandlerResult,
  type MessageOf,
  type NotificationType,
  type RequestType,
  type SessionMessage,
  type StorageMessage,
} from "./messages";
import {
  type MessageSendOptions,
  type RequestOptions,
  positiveTimeout,
  protocolError,
  RtcProtocolError,
} from "./errors";
import type {
  RtcMessageContext,
  RtcProtocolTransport,
} from "./transport";
import {
  assertMessagePeer,
  snapshotSessionMessage,
  validateSessionMessage,
} from "./validation";
import { RTC_PROTOCOL_DEDUP_TTL_MS } from "@/constants";

export type RequestContext<T extends RequestType> =
  RtcMessageContext<MessageOf<T>> & { signal: AbortSignal };
export type RequestHandler<T extends RequestType> = (
  context: RequestContext<T>,
) => HandlerResult<T> | Promise<HandlerResult<T>>;
export type NotificationHandler<
  T extends NotificationType,
> = (
  context: RtcMessageContext<MessageOf<T>>,
) => void | Promise<void>;
type Reply = AckMessage | StorageMessage;
type PendingRequest = {
  request: SessionMessage;
  complete: (message: Reply) => void;
  fail: (error: Error) => void;
};
type ProcessedRequest = {
  seenAt: number;
  ack: AckMessage;
  response?: StorageMessage;
};
type SessionState = {
  lifetime: AbortController;
  pending: Map<string, PendingRequest>;
  processed: Map<string, ProcessedRequest>;
  receivedStorage: Map<string, number>;
  inFlight: Set<string>;
};

/** Requests are scoped to the actual session object, not a shared message ID. */
export class RtcRequestManager {
  private readonly sessions = new Map<
    PeerSession,
    SessionState
  >();
  private readonly retired = new WeakSet<PeerSession>();
  private readonly handlers = new Map<
    RequestType,
    (context: RequestContext<RequestType>) => unknown
  >();
  private readonly notifications = new Map<
    NotificationType,
    Set<(context: RtcMessageContext) => unknown>
  >();
  private readonly unsubscribe: (() => void)[];
  private disposed = false;

  constructor(
    private readonly transport: RtcProtocolTransport,
  ) {
    this.unsubscribe = [
      transport.onAny(({ session, message }) =>
        this.receive(session, message).catch((error) =>
          console.warn(
            "[RtcProtocol] ignored message",
            error,
          ),
        ),
      ),
      transport.onSessionClosed((session) =>
        this.closeSession(session),
      ),
    ];
  }

  private state(session: PeerSession): SessionState {
    if (this.disposed || this.retired.has(session))
      throw new RtcProtocolError("closed");
    let state = this.sessions.get(session);
    if (!state) {
      state = {
        lifetime: new AbortController(),
        pending: new Map(),
        processed: new Map(),
        receivedStorage: new Map(),
        inFlight: new Set(),
      };
      this.sessions.set(session, state);
    }
    return state;
  }

  async send(
    session: PeerSession,
    message: SessionMessage,
    options: MessageSendOptions = {},
  ): Promise<void> {
    validateSessionMessage(message);
    assertMessagePeer(message, session, false);
    const state = this.state(session);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, {
      once: true,
    });
    state.lifetime.signal.addEventListener("abort", abort, {
      once: true,
    });
    if (
      options.signal?.aborted ||
      state.lifetime.signal.aborted
    )
      abort();
    try {
      await this.transport.send(session, message, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (state.lifetime.signal.aborted)
        throw new RtcProtocolError("closed");
      throw protocolError(error);
    } finally {
      options.signal?.removeEventListener("abort", abort);
      state.lifetime.signal.removeEventListener(
        "abort",
        abort,
      );
    }
  }

  request(
    session: PeerSession,
    message: MessageOf<RequestType | "storage">,
    options: RequestOptions = {},
    onPrepared?: () => void,
  ): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      validateSessionMessage(message);
      assertMessagePeer(message, session, false);
      const state = this.state(session);
      if (state.pending.has(message.id))
        return reject(
          new RtcProtocolError(
            "already-pending",
            `Request ${message.id} is already pending for this peer`,
          ),
        );
      if (options.signal?.aborted)
        return reject(new RtcProtocolError("aborted"));
      const timeoutMs = positiveTimeout(
        options.timeoutMs ?? 5_000,
        "timeoutMs",
      );
      positiveTimeout(
        options.sendTimeoutMs ?? 10_000,
        "sendTimeoutMs",
      );
      const retries = options.retries ?? 0;
      const retryDelayMs = options.retryDelayMs ?? 250;
      if (
        !Number.isSafeInteger(retries) ||
        retries < 0 ||
        !Number.isFinite(retryDelayMs) ||
        retryDelayMs < 0 ||
        retryDelayMs > 2_147_483_647
      ) {
        return reject(
          new RangeError("Invalid retry options"),
        );
      }
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let attempt = 0;
      const finish = (error?: Error, reply?: Reply) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (state.pending.get(message.id) === pending)
          state.pending.delete(message.id);
        options.signal?.removeEventListener(
          "abort",
          onAbort,
        );
        state.lifetime.signal.removeEventListener(
          "abort",
          onClose,
        );
        controller.abort(); // Removes a not-yet-sent message from the transport queue.
        if (error) reject(error);
        else resolve(reply!);
      };
      const onAbort = () =>
        finish(new RtcProtocolError("aborted"));
      const onClose = () =>
        finish(new RtcProtocolError("closed"));
      const pending: PendingRequest = {
        request: message,
        complete: (reply) => finish(undefined, reply),
        fail: (error) => finish(error),
      };
      state.pending.set(message.id, pending);
      options.signal?.addEventListener("abort", onAbort, {
        once: true,
      });
      state.lifetime.signal.addEventListener(
        "abort",
        onClose,
        { once: true },
      );

      const sendAttempt = async () => {
        if (settled) return;
        try {
          await this.transport.send(session, message, {
            signal: controller.signal,
            sendTimeoutMs: options.sendTimeoutMs,
          });
          if (settled) return; // A synchronous/very fast reply may have arrived already.
          timer = setTimeout(() => {
            if (settled) return;
            if (attempt++ >= retries)
              return finish(
                new RtcProtocolError(
                  "timeout",
                  `Timed out waiting for ${message.type} reply`,
                ),
              );
            timer = setTimeout(() => {
              void sendAttempt();
            }, retryDelayMs);
          }, timeoutMs);
        } catch (error) {
          finish(
            state.lifetime.signal.aborted
              ? new RtcProtocolError("closed")
              : protocolError(error),
          );
        }
      };
      try {
        onPrepared?.();
      } catch (error) {
        finish(protocolError(error));
        return;
      }
      void sendAttempt();
    });
  }

  handle<T extends RequestType>(
    type: T,
    handler: RequestHandler<T>,
  ): () => void {
    if (this.handlers.has(type))
      throw new Error(
        `A handler for ${type} is already registered`,
      );
    const wrapped = handler as (
      context: RequestContext<RequestType>,
    ) => unknown;
    this.handlers.set(type, wrapped);
    return () => {
      if (this.handlers.get(type) === wrapped)
        this.handlers.delete(type);
    };
  }

  on<T extends NotificationType>(
    type: T,
    handler: NotificationHandler<T>,
  ): () => void {
    const entries =
      this.notifications.get(type) ?? new Set();
    const wrapped = handler as (
      context: RtcMessageContext,
    ) => unknown;
    entries.add(wrapped);
    this.notifications.set(type, entries);
    return () => {
      entries.delete(wrapped);
      if (!entries.size) this.notifications.delete(type);
    };
  }

  private prune(state: SessionState): void {
    const cutoff = Date.now() - RTC_PROTOCOL_DEDUP_TTL_MS;
    for (const [key, value] of state.processed)
      if (value.seenAt < cutoff)
        state.processed.delete(key);
    for (const [key, seenAt] of state.receivedStorage)
      if (seenAt < cutoff)
        state.receivedStorage.delete(key);
    // Bound retained response payloads as well as their lifetime.
    for (const map of [
      state.processed,
      state.receivedStorage,
    ]) {
      while (map.size > 512)
        map.delete(map.keys().next().value!);
    }
  }

  private async receive(
    session: PeerSession,
    input: SessionMessage,
  ): Promise<void> {
    const message = validateSessionMessage(input);
    assertMessagePeer(message, session, true);
    const state = this.state(session);
    this.prune(state);
    const pending = state.pending.get(message.id);
    if (message.type === "error") {
      pending?.fail(
        new RtcProtocolError("remote-error", message.error),
      );
      return;
    }
    if (message.type === "ack") {
      if (
        !pending ||
        pending.request.type === "request-storage"
      )
        return;
      const expected =
        pending.request.type === "storage"
          ? "receive"
          : requestSpec[pending.request.type as RequestType]
              .ack;
      if (message.mode === expected)
        pending.complete(message);
      return;
    }
    if (message.type === "storage") {
      const expected =
        pending?.request.type === "request-storage";
      if (
        !expected &&
        !state.receivedStorage.has(message.id)
      )
        return;
      state.receivedStorage.set(message.id, Date.now());
      // Re-ACK a repeated response too; never lose a receipt through dedup.
      await this.send(
        session,
        createSessionMessage(
          session,
          "ack",
          { mode: "receive" },
          { id: message.id },
        ),
      );
      if (expected) pending!.complete(message);
      return;
    }
    if (isRequestType(message.type)) {
      await this.receiveRequest(
        session,
        state,
        message as MessageOf<RequestType>,
      );
      return;
    }
    const handlers = this.notifications.get(
      message.type as NotificationType,
    );
    if (handlers)
      for (const handler of handlers) {
        try {
          await handler({ session, message });
        } catch (error) {
          console.error(
            "[RtcProtocol] notification handler failed",
            error,
          );
        }
      }
  }

  private async receiveRequest(
    session: PeerSession,
    state: SessionState,
    message: MessageOf<RequestType>,
  ): Promise<void> {
    const key = JSON.stringify([
      message.type,
      message.id,
      message.createdAt,
    ]);
    if (state.inFlight.has(key)) return;
    state.inFlight.add(key);
    try {
      let entry = state.processed.get(key);
      if (!entry) {
        const handler = this.handlers.get(message.type);
        if (!handler)
          throw new Error(
            `Unsupported request: ${message.type}`,
          );
        const result = await handler({
          session,
          message,
          signal: state.lifetime.signal,
        });
        if (state.lifetime.signal.aborted) return;
        let response =
          message.type === "request-storage"
            ? createSessionMessage(
                session,
                "storage",
                { data: result as StorageMessage["data"] },
                { id: message.id },
              )
            : undefined;
        if (response)
          response = snapshotSessionMessage(response);
        entry = {
          seenAt: Date.now(),
          response,
          ack: createSessionMessage(
            session,
            "ack",
            { mode: requestSpec[message.type].ack },
            { id: message.id },
          ),
        };
        // Retain successful handler output before sending: a retry replays it,
        // rather than re-running a file operation or producing different data.
        state.processed.set(key, entry);
        this.prune(state);
      }
      entry.seenAt = Date.now();
      if (entry.response)
        await this.request(session, entry.response, {
          signal: state.lifetime.signal,
        });
      await this.send(session, entry.ack);
    } catch (error) {
      if (state.lifetime.signal.aborted) return;
      const reply = createSessionMessage(
        session,
        "error",
        {
          error:
            error instanceof Error
              ? error.message
              : String(error),
        },
        { id: message.id },
      );
      await this.send(session, reply).catch((failure) =>
        console.warn(
          "[RtcProtocol] error reply failed",
          failure,
        ),
      );
    } finally {
      state.inFlight.delete(key);
    }
  }

  closeSession(session: PeerSession): void {
    this.retired.add(session);
    this.sessions.get(session)?.lifetime.abort();
    this.sessions.delete(session);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe)
      unsubscribe();
    for (const session of this.sessions.keys())
      this.closeSession(session);
    this.handlers.clear();
    this.notifications.clear();
  }
}
