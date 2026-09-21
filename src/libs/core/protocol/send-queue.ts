import type { SessionMessage } from "./messages";
import {
  type MessageSendOptions,
  positiveTimeout,
  protocolError,
  RtcProtocolError,
} from "./errors";

type Waiter = {
  finish: (error?: RtcProtocolError) => void;
};
type Entry = { data: string; waiters: Set<Waiter> };

/** Owns unsent messages only. A resolved send is not a remote receipt. */
export class MessageSendQueue {
  private readonly entries = new Map<string, Entry>();
  private closed = false;

  constructor(
    private readonly getChannel: () => RTCDataChannel | null,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  send(
    message: SessionMessage,
    options: MessageSendOptions = {},
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed)
        return reject(new RtcProtocolError("closed"));
      if (options.signal?.aborted)
        return reject(new RtcProtocolError("aborted"));
      const timeout = positiveTimeout(
        options.sendTimeoutMs ?? 10_000,
        "sendTimeoutMs",
      );
      const data = JSON.stringify(message);
      const key = JSON.stringify([
        message.type,
        message.id,
        message.createdAt,
      ]);
      let entry = this.entries.get(key);
      if (entry && entry.data !== data)
        return reject(
          new RtcProtocolError(
            "already-pending",
            "A queued request cannot change its payload",
          ),
        );
      if (!entry) {
        entry = { data, waiters: new Set() };
        this.entries.set(key, entry);
      }
      const owned = entry;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () =>
        waiter.finish(new RtcProtocolError("aborted"));
      const waiter: Waiter = {
        finish: (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener(
            "abort",
            onAbort,
          );
          owned.waiters.delete(waiter);
          if (
            !owned.waiters.size &&
            this.entries.get(key) === owned
          )
            this.entries.delete(key);
          if (error) reject(error);
          else resolve();
        },
      };
      owned.waiters.add(waiter);
      timer = setTimeout(
        () =>
          waiter.finish(
            new RtcProtocolError(
              "send-timeout",
              "Timed out waiting for the RTC message channel",
            ),
          ),
        timeout,
      );
      options.signal?.addEventListener("abort", onAbort, {
        once: true,
      });
      this.flush();
    });
  }

  flush(): void {
    for (const [key, entry] of this.entries) {
      const channel = this.getChannel();
      if (!channel || channel.readyState !== "open") return;
      this.entries.delete(key);
      let failure: RtcProtocolError | undefined;
      try {
        channel.send(entry.data);
      } catch (error) {
        failure = protocolError(error);
      }
      for (const waiter of [...entry.waiters])
        waiter.finish(failure);
    }
  }

  close(): void {
    this.closed = true;
    const error = new RtcProtocolError(
      "closed",
      "RTC session closed before the message was sent",
    );
    for (const entry of [...this.entries.values()]) {
      for (const waiter of [...entry.waiters])
        waiter.finish(error);
    }
    this.entries.clear();
  }
}
