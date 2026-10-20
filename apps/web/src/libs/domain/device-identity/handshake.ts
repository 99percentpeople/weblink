import {
  fingerprint,
  IDENTITY_CHANNEL,
  verify,
  type DeviceIdentity,
} from "./crypto";
import {
  CredentialExchange,
  type CredentialStore,
  type IdentityRecoveryState,
} from "./credentials";
import { InvalidIdentityProof } from "./errors";
type Hello = {
  kind: "hello";
  client: string;
  target: string;
  nonce: string;
  key: string;
  transport: string;
  credentials?: true;
  pairingKnown?: boolean;
  recovery?: IdentityRecoveryState;
};
export interface IdentityProof {
  fingerprint: string;
  /** Omitted for legacy peers; empty means no shared pairing key was proved. */
  credentialIds?: string[];
  /** Signed peer history, when both endpoints support this extension. */
  remotePairingKnown?: boolean;
  /** Includes invalid local credential records, which are never a recovery request. */
  localPairingBlocked?: boolean;
  /** Negotiated missing-key recovery, after fresh identity and binding checks. */
  recovery?: { identityBound: boolean };
}
/** Binds both fresh challenges and both DTLS certificates; replay/relay cannot authenticate another connection. */
export class DeviceHandshake {
  private local?: Hello;
  private remote?: Hello;
  private sent = false;
  private proofReceived = false;
  private receiveTail = Promise.resolve();
  private localReady: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;
  private abort = new AbortController();
  private complete = false;
  private recoveryBindingSent = false;
  private credentials?: CredentialExchange;
  constructor(
    readonly channel: RTCDataChannel,
    private readonly options: {
      client: string;
      target: string;
      localTransport: string;
      remoteTransport: string;
      identity: Promise<DeviceIdentity>;
      credentials?: CredentialStore;
      pairingKnown?(): Promise<boolean>;
      recoveryBlocked?(): Promise<boolean>;
      verified(proof: IdentityProof): void;
      failed(error?: unknown): void;
      interrupted?(): void;
    },
  ) {
    if (options.credentials)
      this.credentials = new CredentialExchange(
        options.credentials,
        (frame) => channel.send(JSON.stringify(frame)),
        Date.now,
        () =>
          console.debug(
            "[DeviceTrust] credential storage unavailable; renewal deferred",
          ),
      );
    this.localReady = this.prepare();
    void this.localReady.catch(() =>
      this.transportClosed(),
    );
    this.timer = setTimeout(
      () => this.transportClosed(),
      10000,
    );
    channel.addEventListener(
      "message",
      (event) => {
        this.receiveTail = this.receiveTail
          .then(() => this.receive(event.data))
          .catch((error) => this.handleError(error));
      },
      { signal: this.abort.signal },
    );
    channel.addEventListener(
      "close",
      () => this.transportClosed(),
      {
        signal: this.abort.signal,
      },
    );
    channel.addEventListener(
      "error",
      () => this.transportClosed(),
      {
        signal: this.abort.signal,
      },
    );
    const open = () =>
      void this.localReady
        .then(() => {
          // The responder waits for the initiator. Its channel can open before
          // createChannel() has returned to the initiator and installed readers.
          if (this.options.client < this.options.target)
            this.sendHello();
        })
        .catch((error) => this.handleError(error));
    if (channel.readyState === "open") open();
    else
      channel.addEventListener("open", open, {
        signal: this.abort.signal,
        once: true,
      });
  }
  private async prepare() {
    const identity = await this.options.identity;
    await this.credentials?.prepare();
    this.local = {
      kind: "hello",
      client: this.options.client,
      target: this.options.target,
      nonce: crypto.randomUUID(),
      key: identity.publicKey,
      transport: this.options.localTransport,
      credentials: this.credentials ? true : undefined,
      pairingKnown: await this.options.pairingKnown?.(),
      recovery: this.options.pairingKnown
        ? (await this.options.recoveryBlocked?.())
          ? "blocked"
          : this.credentials?.recoveryState()
        : undefined,
    };
  }
  private helloSent = false;
  private sendHello() {
    if (this.abort.signal.aborted || this.helloSent) return;
    this.helloSent = true;
    this.channel.send(JSON.stringify(this.local));
  }
  private transcript(signer: string) {
    return JSON.stringify([
      IDENTITY_CHANNEL,
      ...[this.local!, this.remote!]
        .sort((a, b) => (a.client < b.client ? -1 : 1))
        .map((h) => [
          h.client,
          h.target,
          h.nonce,
          h.key,
          h.transport,
        ]),
      signer,
      ...(this.local?.credentials &&
      this.remote?.credentials
        ? ["pairing-credentials/1"]
        : []),
      ...(this.local?.pairingKnown !== undefined &&
      this.remote?.pairingKnown !== undefined
        ? [
            "pairing-history",
            ...[this.local, this.remote]
              .sort((a, b) =>
                a.client < b.client ? -1 : 1,
              )
              .map((h) => h.pairingKnown),
          ]
        : []),
      ...(this.recoveryNegotiated()
        ? [
            "identity-recovery",
            ...[this.local!, this.remote!]
              .sort((a, b) =>
                a.client < b.client ? -1 : 1,
              )
              .map((h) => h.recovery),
          ]
        : []),
    ]);
  }
  private recoveryNegotiated() {
    return !!(
      this.local?.credentials &&
      this.remote?.credentials &&
      this.local.pairingKnown !== undefined &&
      this.remote.pairingKnown !== undefined &&
      this.local.recovery !== undefined &&
      this.remote.recovery !== undefined
    );
  }
  private recovering() {
    return (
      this.recoveryNegotiated() &&
      this.local!.recovery !== "blocked" &&
      this.remote!.recovery !== "blocked" &&
      (this.local!.recovery === "missing" ||
        this.remote!.recovery === "missing")
    );
  }
  private async receive(raw: unknown) {
    if (this.abort.signal.aborted) return;
    if (typeof raw !== "string" || raw.length > 4096)
      throw new InvalidIdentityProof(
        "Invalid identity frame",
      );
    await this.localReady;
    this.sendHello();
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      throw new InvalidIdentityProof(
        "Invalid identity JSON",
      );
    }
    if (!frame || typeof frame !== "object")
      throw new InvalidIdentityProof(
        "Invalid identity frame",
      );
    if (frame.kind === "hello") {
      if (
        this.remote ||
        frame.client !== this.options.target ||
        frame.target !== this.options.client ||
        frame.transport !== this.options.remoteTransport ||
        typeof frame.key !== "string" ||
        frame.key.length !== 88 ||
        typeof frame.nonce !== "string" ||
        (frame.pairingKnown !== undefined &&
          typeof frame.pairingKnown !== "boolean") ||
        (frame.recovery !== undefined &&
          !["ready", "missing", "blocked"].includes(
            frame.recovery,
          )) ||
        !/^[a-f0-9-]{36}$/.test(frame.nonce)
      )
        throw new InvalidIdentityProof(
          "Invalid identity hello",
        );
      this.remote = {
        kind: "hello",
        client: frame.client,
        target: frame.target,
        nonce: frame.nonce,
        key: frame.key,
        transport: frame.transport,
        credentials:
          frame.credentials === true ? true : undefined,
        pairingKnown: frame.pairingKnown,
        recovery: frame.recovery,
      };
      const identity = await this.options.identity;
      if (
        this.local?.credentials &&
        this.remote.credentials &&
        !this.recoveryNegotiated()
      )
        throw new InvalidIdentityProof(
          "Missing pairing identity binding support",
        );
      if (this.recoveryNegotiated())
        this.credentials!.bindIdentity({
          identity,
          client: this.options.client,
          target: this.options.target,
          remoteKey: this.remote.key,
        });
      const signature = await identity.sign(
        this.transcript(this.local!.client),
      );
      const credentialProofs =
        this.local?.credentials && this.remote.credentials
          ? await this.credentials!.proofs(
              this.transcript(this.local!.client),
            )
          : undefined;
      const recoveryBinding =
        this.recovering() &&
        this.remote.recovery === "missing"
          ? await this.credentials!.recoveryProof()
          : undefined;
      if (this.abort.signal.aborted) return;
      this.sent = true;
      this.recoveryBindingSent =
        recoveryBinding !== undefined;
      this.channel.send(
        JSON.stringify({
          kind: "proof",
          signature,
          credentialProofs,
          recoveryBinding,
        }),
      );
    } else if (frame.kind === "proof") {
      if (
        !this.remote ||
        !this.sent ||
        this.proofReceived ||
        typeof frame.signature !== "string"
      )
        throw new InvalidIdentityProof(
          `Invalid identity proof (hello=${!!this.remote}, sent=${this.sent}, duplicate=${this.proofReceived})`,
        );
      this.proofReceived = true;
      if (
        !(await verify(
          this.remote.key,
          this.transcript(this.remote.client),
          frame.signature,
        ))
      )
        throw new InvalidIdentityProof(
          "Invalid identity signature",
        );
      const credentialIds =
        this.local?.credentials && this.remote.credentials
          ? await this.credentials!.authenticate(
              frame.credentialProofs,
              this.transcript(this.remote.client),
            )
          : [];
      if (
        this.recoveryNegotiated() &&
        this.remote.recovery === "missing" &&
        frame.credentialProofs.length
      )
        throw new InvalidIdentityProof(
          "Inconsistent recovery proof",
        );
      if (
        frame.recoveryBinding !== undefined &&
        !this.recovering()
      )
        throw new InvalidIdentityProof(
          "Unexpected recovery binding",
        );
      const identityBound = this.recovering()
        ? await this.credentials!.authenticateIdentity(
            frame.recoveryBinding,
          )
        : false;
      // A peer that forgot every record needs our copy of its signed issuance
      // to authenticate us too. Recovery must authenticate both directions.
      const recovery =
        this.recovering() &&
        (this.remote.pairingKnown ||
          this.recoveryBindingSent)
          ? { identityBound }
          : undefined;
      const peer = await fingerprint(this.remote.key);
      if (this.abort.signal.aborted) return;
      this.complete = true;
      clearTimeout(this.timer);
      this.options.verified({
        fingerprint: peer,
        ...(this.local?.credentials &&
        this.remote.credentials
          ? { credentialIds }
          : {}),
        ...(this.local?.pairingKnown !== undefined &&
        this.remote.pairingKnown !== undefined
          ? { remotePairingKnown: this.remote.pairingKnown }
          : {}),
        ...(recovery ? { recovery } : {}),
        localPairingBlocked:
          this.local?.recovery === "blocked",
      });
    } else if (
      this.complete &&
      this.local?.credentials &&
      this.remote?.credentials
    ) {
      await this.credentials!.receive(frame);
    } else
      throw new InvalidIdentityProof(
        "Invalid identity message",
      );
  }
  async trust() {
    if (
      this.complete &&
      this.local?.credentials &&
      this.remote?.credentials
    )
      await this.credentials?.trust();
  }
  private handleError(error: unknown) {
    if (this.abort.signal.aborted) return;
    if (!(error instanceof InvalidIdentityProof)) {
      this.transportClosed();
      return;
    }
    this.close();
    this.options.failed(error);
  }
  private transportClosed() {
    if (this.abort.signal.aborted) return;
    // A disconnect or deadline is not evidence of a wrong key, at any stage.
    this.close();
    this.options.interrupted?.();
  }
  close() {
    this.abort.abort();
    this.credentials?.close();
    clearTimeout(this.timer);
    this.channel.close();
  }
}
