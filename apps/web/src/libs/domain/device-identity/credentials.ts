import { base64, bytes } from "./crypto";
import { InvalidIdentityProof } from "./errors";
import {
  bindCredential,
  verifyBinding,
  verifyCredentialBinding,
  type BindingContext,
  type BoundCredential,
  type CredentialBinding,
} from "./credential-binding";

// Expiry schedules renewal; it never invalidates an offline device's last proof.
export const CREDENTIAL_LIFETIME = 90 * 24 * 60 * 60 * 1000;
export interface PairingCredential extends BoundCredential {
  secret: string;
  binding: CredentialBinding;
}
export type IdentityRecoveryState =
  | "ready"
  | "missing"
  | "blocked";
export interface PairingCredentials {
  issued?: PairingCredential;
  pending?: PairingCredential;
  received?: PairingCredential;
  blocked?: boolean;
}
export interface CredentialStore {
  read(): Promise<PairingCredentials>;
  /** The reducer executes atomically against the latest persisted state. */
  update(
    change: (
      state: PairingCredentials,
    ) => PairingCredentials,
  ): Promise<PairingCredentials>;
}
interface CredentialProof {
  id: string;
  mac: string;
}
const candidates = (state: PairingCredentials) =>
  state.blocked
    ? []
    : [state.issued, state.pending, state.received].filter(
        (c): c is PairingCredential => !!c,
      );
const message = (transcript: string) =>
  new TextEncoder().encode(
    JSON.stringify([
      "weblink-pairing-credential/1",
      transcript,
    ]),
  );
async function key(credential: PairingCredential) {
  return crypto.subtle.importKey(
    "raw",
    bytes(credential.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function validCredential(
  value: unknown,
): value is PairingCredential {
  if (!value || typeof value !== "object") return false;
  const c = value as PairingCredential;
  return (
    typeof c.id === "string" &&
    /^[a-f0-9-]{36}$/.test(c.id) &&
    typeof c.secret === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(c.secret) &&
    Number.isSafeInteger(c.expiresAt) &&
    c.expiresAt > 0 &&
    !!c.binding &&
    typeof c.binding.issuerKey === "string" &&
    c.binding.issuerKey.length === 88 &&
    typeof c.binding.recipientKey === "string" &&
    c.binding.recipientKey.length === 88 &&
    typeof c.binding.secretHash === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(c.binding.secretHash) &&
    typeof c.binding.signature === "string" &&
    c.binding.signature.length === 88
  );
}

/** Two independently issued shared secrets recover either missing direction.
 * Secrets travel only after local trust and remote consent, over bound DTLS.
 * The device's long-term signing private key never enters this protocol.
 */
export class CredentialExchange {
  private snapshot: PairingCredentials = {};
  private trusted = false;
  private remoteReady = false;
  private remoteReceived?: string;
  private closed = false;
  private tail = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private offered?: string;
  private readySent = false;
  private binding?: BindingContext;
  constructor(
    private readonly store: CredentialStore,
    private readonly send: (frame: unknown) => void,
    private readonly now: () => number = Date.now,
    private readonly storageError: (
      error: unknown,
    ) => void = () => {},
  ) {}
  async prepare() {
    this.snapshot = await this.store.read();
    // Invalid persisted records must not become a "missing keys" recovery
    // request. Keep the handshake available for explicit pairing instead.
    if (
      candidates(this.snapshot).some(
        (c) => !validCredential(c),
      )
    )
      this.snapshot = { blocked: true };
  }
  recoveryState(): IdentityRecoveryState {
    return this.snapshot.blocked
      ? "blocked"
      : candidates(this.snapshot).length
        ? "ready"
        : "missing";
  }
  bindIdentity(context: BindingContext) {
    this.binding = context;
  }
  async recoveryProof(): Promise<
    BoundCredential | undefined
  > {
    const c = this.snapshot.received;
    if (
      this.binding &&
      !this.snapshot.blocked &&
      c &&
      (await verifyCredentialBinding(
        c,
        this.binding,
        false,
      ))
    )
      return {
        id: c.id,
        expiresAt: c.expiresAt,
        binding: c.binding,
      };
  }
  async authenticateIdentity(
    value: unknown,
  ): Promise<boolean> {
    const context = this.binding;
    if (!context || this.snapshot.blocked) return false;
    if (value !== undefined) {
      if (
        !(await verifyBinding(
          value,
          context.client,
          context.target,
          context.identity.publicKey,
          context.remoteKey,
        ))
      )
        throw new InvalidIdentityProof(
          "Invalid pairing identity binding",
        );
      return true;
    }
    // A retained issuance can also recover a lost public pin. Never use an
    // arbitrary certificate signed only by the currently presented peer key.
    for (const c of [
      this.snapshot.issued,
      this.snapshot.pending,
    ])
      if (
        c &&
        (await verifyCredentialBinding(c, context, true))
      )
        return true;
    return false;
  }
  async proofs(
    transcript: string,
  ): Promise<CredentialProof[]> {
    return Promise.all(
      candidates(this.snapshot).map(async (c) => ({
        id: c.id,
        mac: base64(
          await crypto.subtle.sign(
            "HMAC",
            await key(c),
            message(transcript),
          ),
        ),
      })),
    );
  }
  async authenticate(
    value: unknown,
    transcript: string,
  ): Promise<string[]> {
    if (!Array.isArray(value) || value.length > 3)
      throw new InvalidIdentityProof(
        "Invalid pairing credential proofs",
      );
    const authenticated: string[] = [];
    for (const proof of value) {
      if (
        !proof ||
        typeof proof.id !== "string" ||
        proof.id.length > 36 ||
        typeof proof.mac !== "string" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(proof.mac)
      )
        throw new InvalidIdentityProof(
          "Invalid pairing credential proof",
        );
      for (const c of candidates(this.snapshot)) {
        if (c.id !== proof.id) continue;
        if (
          !(await crypto.subtle.verify(
            "HMAC",
            await key(c),
            bytes(proof.mac),
            message(transcript),
          ))
        )
          throw new InvalidIdentityProof(
            "Invalid pairing credential MAC",
          );
        authenticated.push(c.id);
      }
    }
    return authenticated;
  }
  private enqueue(
    operation: () => Promise<void>,
  ): Promise<void> {
    const next = this.tail.then(async () => {
      if (!this.closed) await operation();
    });
    this.tail = next.catch(() => {});
    return next;
  }
  private update(
    change: (
      state: PairingCredentials,
    ) => PairingCredentials,
  ) {
    return this.store.update((state) =>
      this.closed || state.blocked ? state : change(state),
    );
  }
  private transmit(frame: unknown) {
    if (!this.closed) this.send(frame);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(
      () => {
        void this.enqueue(() => this.refresh());
      },
      Math.min(Math.max(delay, 1), 2147483647),
    );
  }
  /** Called only after durable pin validation or explicit local pairing. */
  trust(): Promise<void> {
    return this.enqueue(async () => {
      this.trusted = true;
      this.readySent = false;
      await this.refresh();
    });
  }
  private async refresh() {
    if (!this.trusted || this.closed || !this.binding)
      return;
    try {
      let state = await this.store.read();
      if (this.closed || state.blocked) return;
      if (!this.readySent) {
        this.transmit({
          kind: "credential-ready",
          received: state.received?.id,
        });
        this.readySent = true;
      }
      if (!this.remoteReady) return;
      const issued = state.issued;
      const bound =
        issued &&
        (await verifyCredentialBinding(
          issued,
          this.binding,
          true,
        ));
      if (
        !state.pending &&
        (!issued ||
          !bound ||
          issued.expiresAt <= this.now() ||
          this.remoteReceived !== issued.id)
      ) {
        const fields = {
          id: crypto.randomUUID(),
          secret: base64(
            crypto.getRandomValues(new Uint8Array(32))
              .buffer,
          ),
          expiresAt: this.now() + CREDENTIAL_LIFETIME,
        };
        const credential: PairingCredential = {
          ...fields,
          binding: await bindCredential(
            fields,
            this.binding,
          ),
        };
        state = await this.update((latest) => ({
          ...latest,
          pending: latest.pending ?? credential,
        }));
      }
      if (this.closed || state.blocked) return;
      if (state.pending) {
        // Identity regeneration authenticated by a surviving shared key
        // rebinds the outbox without discarding an unacknowledged secret.
        if (
          !(await verifyCredentialBinding(
            state.pending,
            this.binding,
            true,
          ))
        ) {
          const pending = state.pending;
          const binding = await bindCredential(
            pending,
            this.binding,
          );
          state = await this.update((latest) =>
            latest.pending?.id === pending.id
              ? {
                  ...latest,
                  pending: { ...pending, binding },
                }
              : latest,
          );
        }
        if (this.closed || state.blocked || !state.pending)
          return;
        // Persist the outbox first. A lost ACK is retried with the same secret.
        this.offered = state.pending.id;
        this.transmit({
          kind: "credential-offer",
          credential: state.pending,
        });
        this.schedule(30000);
      } else if (state.issued) {
        this.schedule(state.issued.expiresAt - this.now());
      }
    } catch (error) {
      this.storageError(error);
      this.schedule(30000);
    }
  }
  receive(frame: Record<string, unknown>): Promise<void> {
    return this.enqueue(async () => {
      if (frame.kind === "credential-ready") {
        if (
          frame.received !== undefined &&
          (typeof frame.received !== "string" ||
            frame.received.length > 36)
        )
          throw new InvalidIdentityProof(
            "Invalid credential receipt",
          );
        this.remoteReady = true;
        this.remoteReceived = frame.received as
          | string
          | undefined;
        await this.refresh();
      } else if (frame.kind === "credential-offer") {
        if (
          !this.trusted ||
          !this.remoteReady ||
          !validCredential(frame.credential)
        )
          throw new InvalidIdentityProof(
            "Unauthorized credential offer",
          );
        const credential = frame.credential;
        if (
          !this.binding ||
          !(await verifyCredentialBinding(
            credential,
            this.binding,
            false,
          ))
        )
          throw new InvalidIdentityProof(
            "Invalid offered credential binding",
          );
        try {
          const state = await this.update((latest) => ({
            ...latest,
            received: credential,
          }));
          if (
            !this.closed &&
            !state.blocked &&
            state.received?.id === credential.id
          )
            this.transmit({
              kind: "credential-ack",
              id: credential.id,
            });
        } catch (error) {
          // Never ACK an uncommitted secret. The issuer retains its old key and retries.
          this.storageError(error);
        }
      } else if (frame.kind === "credential-ack") {
        if (
          !this.trusted ||
          !this.remoteReady ||
          typeof frame.id !== "string"
        )
          throw new InvalidIdentityProof(
            "Unauthorized credential acknowledgement",
          );
        if (frame.id !== this.offered) return;
        try {
          const state = await this.update((latest) =>
            latest.pending?.id === frame.id
              ? {
                  ...latest,
                  issued: latest.pending,
                  pending: undefined,
                }
              : latest,
          );
          if (
            !this.closed &&
            !state.blocked &&
            state.issued?.id === frame.id
          ) {
            this.remoteReceived = frame.id;
            await this.refresh();
          }
        } catch (error) {
          this.storageError(error);
          this.schedule(30000);
        }
      } else
        throw new InvalidIdentityProof(
          "Invalid credential message",
        );
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
