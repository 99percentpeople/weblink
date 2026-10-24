import { createUuid } from "../ids";
import { validateP256PublicKey } from "../utils/crypto-compat";
import {
  bytes,
  fingerprint,
  type DeviceIdentity,
} from "./crypto";
import {
  CredentialExchange,
  type CredentialStore,
} from "./credentials";

export const PAIRING_CHANNEL = "weblink-device-pairing/1";
export const PAIRING_TIMEOUT = 60_000;
export type PairingFailure =
  | "rejected"
  | "cancelled"
  | "timeout"
  | "disconnected"
  | "invalid"
  | "storage";
export interface PairingRequest {
  /** Local action token. A remote request ID can never revive an old UI action. */
  id: string;
  state: "outgoing" | "incoming" | "committing" | "failed";
  reason?: PairingFailure;
}

/** Human approval of this connection replaces the old identity decision.
 * No signature challenge or comparison code precedes approval. New credentials
 * retain their signed bindings for future authenticated automatic recovery.
 */
export class ManualPairing {
  private abort = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private tail = Promise.resolve();
  private request?: PairingRequest;
  private wireRequest?: string;
  private remoteKey?: string;
  private localCommit?: Promise<void>;
  private complete = false;
  private credentials?: CredentialExchange;
  private readonly expiresAt: number;

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly options: {
      client: string;
      target: string;
      localTransport: string;
      remoteTransport: string;
      identity: Promise<DeviceIdentity>;
      credentials?: CredentialStore;
      outgoing?: string;
      expiresAt?: number;
      changed(request: PairingRequest): void;
      accepting(): void;
      commit(fingerprint: string): Promise<void>;
      paired(fingerprint: string): void;
      ended(
        reason: PairingFailure,
        complete: boolean,
      ): void;
    },
  ) {
    this.expiresAt =
      options.expiresAt ?? Date.now() + PAIRING_TIMEOUT;
    this.timer = setTimeout(
      () => this.end("timeout"),
      Math.max(0, this.expiresAt - Date.now()),
    );
    if (options.credentials)
      this.credentials = new CredentialExchange(
        options.credentials,
        (frame) =>
          this.send(frame as Record<string, unknown>),
      );
    channel.addEventListener(
      "message",
      (event) => {
        this.tail = this.tail
          .then(async () => {
            if (this.abort.signal.aborted) return;
            if (
              typeof event.data !== "string" ||
              event.data.length > 4096
            )
              throw new Error("Invalid pairing frame");
            await this.receive(JSON.parse(event.data));
          })
          .catch(() => this.end("invalid"));
      },
      { signal: this.abort.signal },
    );
    for (const event of ["close", "error"])
      channel.addEventListener(
        event,
        () => this.end("disconnected"),
        { signal: this.abort.signal },
      );
    // Attach rejection handling even when the remote never sends a request.
    void options.identity.catch(() => this.end("storage"));
    if (options.outgoing) {
      this.wireRequest = options.outgoing;
      this.change({
        id: options.outgoing,
        state: "outgoing",
      });
      const start = async () => {
        const identity = await options.identity;
        if (!this.active()) return;
        this.send({
          kind: "request",
          ...this.hello(identity),
        });
      };
      const open = () =>
        void start().catch(() => this.end("storage"));
      if (channel.readyState === "open") open();
      else
        channel.addEventListener("open", open, {
          once: true,
          signal: this.abort.signal,
        });
    }
  }
  private hello(identity: DeviceIdentity) {
    return {
      client: this.options.client,
      target: this.options.target,
      key: identity.publicKey,
      transport: this.options.localTransport,
    };
  }
  private change(request: PairingRequest) {
    this.request = request;
    this.options.changed(request);
  }
  private send(frame: Record<string, unknown>) {
    if (!this.abort.signal.aborted)
      this.channel.send(
        JSON.stringify({
          ...frame,
          request: this.wireRequest,
        }),
      );
  }
  private async readHello(frame: Record<string, unknown>) {
    if (
      frame.client !== this.options.target ||
      frame.target !== this.options.client ||
      frame.transport !== this.options.remoteTransport ||
      typeof frame.key !== "string" ||
      frame.key.length !== 88
    )
      throw new Error("Invalid pairing endpoint");
    // Validate only the public-key format, not possession of a private key.
    await validateP256PublicKey(bytes(frame.key));
    if (this.active()) this.remoteKey = frame.key;
  }
  private async receive(frame: Record<string, unknown>) {
    if (!this.active()) return;
    if (!frame || typeof frame !== "object")
      throw new Error("Invalid pairing frame");
    if (
      !this.request &&
      !this.options.outgoing &&
      frame.kind === "request" &&
      typeof frame.request === "string" &&
      /^[a-f0-9-]{36}$/.test(frame.request)
    ) {
      await this.readHello(frame);
      if (this.active()) {
        this.wireRequest = frame.request;
        this.change({
          id: createUuid(),
          state: "incoming",
        });
      }
      return;
    }
    if (!this.request || frame.request !== this.wireRequest)
      throw new Error("Stale pairing request");
    if (frame.kind === "cancel") {
      this.end(
        this.complete
          ? "disconnected"
          : frame.reason === "rejected"
            ? "rejected"
            : "cancelled",
        false,
      );
    } else if (
      frame.kind === "accept" &&
      this.options.outgoing &&
      this.request.state === "outgoing"
    ) {
      await this.readHello(frame);
      if (this.active()) await this.commit();
    } else if (
      frame.kind === "committed" &&
      this.request.state === "committing" &&
      !this.complete
    ) {
      await this.localCommit;
      if (!this.active()) return;
      // Both devices have saved the explicit decision. Only now grant live
      // authority and begin the normal durable credential issuance/ACK flow.
      const pin = await fingerprint(this.remoteKey!);
      if (!this.active()) return;
      this.complete = true;
      clearTimeout(this.timer);
      this.options.paired(pin);
      await this.credentials?.trust();
    } else if (
      this.complete &&
      typeof frame.kind === "string" &&
      frame.kind.startsWith("credential-") &&
      this.credentials
    ) {
      await this.credentials.receive(frame);
    } else throw new Error("Unexpected pairing frame");
  }
  private commit(): Promise<void> {
    this.change({ ...this.request!, state: "committing" });
    this.options.accepting();
    this.localCommit = (async () => {
      const identity = await this.options.identity;
      if (!this.active()) return;
      this.credentials?.bindIdentity({
        identity,
        client: this.options.client,
        target: this.options.target,
        remoteKey: this.remoteKey!,
      });
      if (!this.options.outgoing)
        this.send({
          kind: "accept",
          ...this.hello(identity),
        });
      const pin = await fingerprint(this.remoteKey!);
      if (!this.active()) return;
      await this.options.commit(pin);
      if (this.active()) this.send({ kind: "committed" });
    })().catch(() => this.end("storage"));
    return this.localCommit;
  }
  respond(id: string, accept: boolean): boolean {
    if (
      !this.active() ||
      this.request?.id !== id ||
      this.request.state !== "incoming"
    )
      return false;
    if (accept) void this.commit();
    else this.end("rejected");
    return true;
  }
  cancel(id: string): boolean {
    if (
      !this.active() ||
      this.complete ||
      this.request?.id !== id ||
      this.request.state === "committing"
    )
      return false;
    this.end("cancelled");
    return true;
  }
  private active(): boolean {
    if (this.abort.signal.aborted) return false;
    if (!this.complete && Date.now() >= this.expiresAt) {
      this.end("timeout");
      return false;
    }
    return true;
  }
  private end(reason: PairingFailure, notify = true) {
    if (this.abort.signal.aborted) return;
    if (notify && !this.complete) {
      try {
        this.send({ kind: "cancel", reason });
      } catch {
        /* Transport may already be closed. */
      }
    }
    this.close();
    this.options.ended(reason, this.complete);
  }
  close() {
    this.abort.abort();
    clearTimeout(this.timer);
    this.credentials?.close();
    this.channel.close();
  }
}
