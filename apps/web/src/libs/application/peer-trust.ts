import { createSignal } from "solid-js";
import { createUuid } from "../domain/ids";
import type { PeerSession } from "../domain/session";
import {
  IDENTITY_CHANNEL,
  transportFingerprint,
} from "../domain/device-identity/crypto";
import {
  DeviceHandshake,
  type IdentityProof,
} from "../domain/device-identity/handshake";
import {
  ManualPairing,
  PAIRING_CHANNEL,
  PAIRING_TIMEOUT,
  type PairingRequest,
} from "../domain/device-identity/manual-pairing";
import {
  deviceIdentityStore,
  type DeviceIdentityStore,
} from "../infrastructure/identity/device-identity-store";
export interface PeerTrust {
  state: "verifying" | "unpaired" | "untrusted" | "trusted";
  fingerprint?: string;
}
type Binding = {
  session: PeerSession;
  life: AbortController;
  generation: number;
  proof?: IdentityProof;
  handshake?: DeviceHandshake;
  timer?: ReturnType<typeof setTimeout>;
  state: PeerTrust;
  opening: boolean;
  manual?: ManualPairing;
  pairing?: PairingRequest;
  requestPairing(): Promise<void>;
  cancelPairing(request: string): boolean;
};
/** First use pins a verified key; remembered identities must prove continuity. */
export class PeerTrustService {
  private bindings = new Map<string, Binding>();
  private revision = createSignal(0);
  private writes = new Map<string, Promise<unknown>>();
  private serialize<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const pending = (
      this.writes.get(id) ?? Promise.resolve()
    )
      .catch(() => {})
      .then(operation);
    this.writes.set(id, pending);
    void pending
      .finally(() => {
        if (this.writes.get(id) === pending)
          this.writes.delete(id);
      })
      .catch(() => {});
    return pending;
  }
  constructor(
    private readonly permissions: {
      quarantine(peer: string): void;
      paired(peer: string): void;
    },
    private readonly store: DeviceIdentityStore = deviceIdentityStore,
  ) {}
  get(id: string): PeerTrust | undefined {
    this.revision[0]();
    return this.bindings.get(id)?.state;
  }
  trusted(id: string) {
    return this.get(id)?.state === "trusted";
  }
  pairing(id: string): PairingRequest | undefined {
    this.revision[0]();
    return this.bindings.get(id)?.pairing;
  }
  async requestPairing(id: string): Promise<void> {
    const b = this.bindings.get(id);
    if (!b || b.life.signal.aborted)
      throw new Error("PAIRING_NOT_READY");
    await b.requestPairing();
  }
  respondPairing(
    id: string,
    request: string,
    accept: boolean,
  ): boolean {
    if (
      !this.bindings.get(id)?.session.isMessageChannelReady
    )
      return false;
    return (
      this.bindings
        .get(id)
        ?.manual?.respond(request, accept) ?? false
    );
  }
  cancelPairing(id: string, request: string): boolean {
    return (
      this.bindings.get(id)?.cancelPairing(request) ?? false
    );
  }
  private publish(b: Binding, state: PeerTrust) {
    b.state = state;
    this.revision[1]((v) => v + 1);
  }
  bind(session: PeerSession): () => void {
    const id = session.targetClientId;
    // A second candidate must never overwrite the live binding for this ID.
    if (this.bindings.has(id))
      throw new Error("DUPLICATE_DEVICE_ID");
    const b: Binding = {
      session,
      life: new AbortController(),
      generation: 0,
      state: { state: "verifying" },
      opening: false,
      requestPairing: async () => {},
      cancelPairing: () => false,
    };
    this.bindings.set(id, b);
    const current = (generation: number) =>
      !b.life.signal.aborted && b.generation === generation;
    const stopIdentity = () => {
      ++b.generation;
      b.handshake?.close();
      b.handshake = undefined;
      b.proof = undefined;
      b.opening = false;
      clearTimeout(b.timer);
    };
    let manualAttempt: object | undefined;
    let manualTimer:
      | ReturnType<typeof setTimeout>
      | undefined;
    const closeManual = () => {
      b.manual?.close();
      b.manual = undefined;
    };
    const reset = () => {
      stopIdentity();
      manualAttempt = undefined;
      clearTimeout(manualTimer);
      closeManual();
      b.pairing = undefined;
      this.publish(b, { state: "verifying" });
    };
    const interrupted = (generation: number) => {
      if (!current(generation)) return;
      stopIdentity();
      this.publish(b, { state: "verifying" });
      // Retry only from the channel initiator; the responder accepts its new
      // channel. Keep saved policy while every application gate stays closed.
      if (
        session.isMessageChannelReady &&
        session.clientId < id
      ) {
        const next = b.generation;
        b.timer = setTimeout(() => {
          if (current(next)) open();
        }, 1000);
      }
    };
    const fail = async (generation: number) => {
      if (!current(generation)) return;
      ++b.generation;
      clearTimeout(b.timer);
      b.handshake?.close();
      b.proof = undefined;
      this.publish(b, { state: "untrusted" });
      try {
        await this.serialize(id, async () => {
          // Serialize policy changes with pairing commits. A failed proof must
          // win over a pairing write that was already in flight.
          this.permissions.quarantine(id);
          const pin = await this.store.pin(id);
          if (pin)
            await this.store.save(id, {
              ...pin,
              blocked: true,
            });
          await this.store
            .credentials?.(id)
            .update((state) => ({
              ...state,
              blocked: true,
            }));
        });
      } catch {
        /* Remain quarantined on storage failure. */
      }
    };
    const bind = (channel: RTCDataChannel) => {
      if (
        b.handshake ||
        b.life.signal.aborted ||
        b.manual
      ) {
        channel.close();
        return;
      }
      const generation = b.generation;
      clearTimeout(b.timer);
      try {
        b.handshake = new DeviceHandshake(channel, {
          client: session.clientId,
          target: id,
          localTransport: transportFingerprint(
            session.peerConnection?.localDescription?.sdp,
          ),
          remoteTransport: transportFingerprint(
            session.peerConnection?.remoteDescription?.sdp,
          ),
          identity: this.store.identity(),
          credentials: this.store.credentials?.(id),
          pairingKnown: () =>
            this.serialize(id, async () => {
              const pin = await this.store.pin(id);
              const keys = await this.store
                .credentials?.(id)
                .read();
              // A pin alone can precede the initial shared-key exchange.
              // Lost keys and quarantine must never advertise a fresh start.
              return !!(
                pin?.credentialRequired ||
                pin?.blocked ||
                keys?.issued ||
                keys?.pending ||
                keys?.received ||
                keys?.blocked
              );
            }),
          recoveryBlocked: () =>
            this.serialize(
              id,
              async () =>
                !!(await this.store.pin(id))?.blocked,
            ),
          verified: (proof) =>
            void this.serialize(id, async () => {
              const pin = await this.store.pin(id);
              const keys = await this.store
                .credentials?.(id)
                .read();
              if (!current(generation)) return;
              b.proof = proof;
              const credentialAuthenticated =
                proof.credentialIds?.some((keyId) =>
                  [
                    keys?.issued,
                    keys?.pending,
                    keys?.received,
                  ].some((key) => key?.id === keyId),
                );
              // Recovery is explicitly negotiated and signed. A missing-key
              // claim alone proves nothing: require the original saved pin or
              // our own prior signature binding this peer's current identity.
              const identityRecovered =
                proof.recovery &&
                (pin?.fingerprint === proof.fingerprint ||
                  (!pin && proof.recovery.identityBound));
              if (
                !pin?.blocked &&
                !keys?.blocked &&
                !proof.localPairingBlocked &&
                (credentialAuthenticated ||
                  identityRecovered ||
                  (!pin?.credentialRequired &&
                    !keys?.issued &&
                    !keys?.received &&
                    pin?.fingerprint === proof.fingerprint))
              ) {
                // Recovery preserves saved policy and only enables the usual
                // durable issuance/ACK exchange, never an unverified offer.
                if (
                  pin?.fingerprint !== proof.fingerprint ||
                  (!pin.credentialRequired &&
                    (credentialAuthenticated ||
                      identityRecovered))
                )
                  await this.store.save(id, {
                    fingerprint: proof.fingerprint,
                    blocked: false,
                    credentialRequired: true,
                  });
                if (!current(generation)) return;
                this.publish(b, {
                  state: "trusted",
                  ...proof,
                });
                await b.handshake?.trust();
              } else {
                const remembered = !!(
                  pin ||
                  keys?.issued ||
                  keys?.pending ||
                  keys?.received ||
                  keys?.blocked
                );
                if (
                  !remembered &&
                  proof.remotePairingKnown !== true
                ) {
                  await this.commitPair(
                    id,
                    b,
                    proof,
                    generation,
                  );
                  return;
                }
                this.permissions.quarantine(id);
                this.publish(b, {
                  state: "untrusted",
                  ...proof,
                });
                if (pin)
                  await this.store.save(id, {
                    ...pin,
                    blocked: true,
                  });
                await this.store
                  .credentials?.(id)
                  .update((state) => ({
                    ...state,
                    blocked: true,
                  }));
              }
            }).catch(() => interrupted(generation)),
          failed: (error) => {
            console.debug("[DeviceTrust] proof rejected", {
              peerId: id,
              reason:
                error instanceof Error
                  ? error.message
                  : "Invalid identity proof",
            });
            void fail(generation);
          },
          interrupted: () => interrupted(generation),
        });
      } catch {
        channel.close();
        interrupted(generation);
      }
    };
    const open = () => {
      if (
        b.life.signal.aborted ||
        !session.isMessageChannelReady ||
        b.handshake ||
        b.opening ||
        b.manual
      )
        return;
      const generation = b.generation;
      clearTimeout(b.timer);
      b.timer = setTimeout(
        () => interrupted(generation),
        12000,
      );
      if (session.clientId > id) return;
      b.opening = true;
      void session
        .createChannel(
          IDENTITY_CHANNEL,
          IDENTITY_CHANNEL,
          (channel) => {
            // Own the channel before waiting for open. Otherwise a stalled
            // connecting channel survives every retry and is reused forever.
            if (!current(generation)) channel.close();
            else bind(channel);
          },
        )
        .catch(() => interrupted(generation))
        .finally(() => {
          if (current(generation)) b.opening = false;
        });
    };
    const bindPairing = (
      channel: RTCDataChannel,
      attempt: object,
      outgoing?: string,
      expiresAt?: number,
    ) => {
      if (
        b.life.signal.aborted ||
        b.manual ||
        manualAttempt !== attempt
      ) {
        channel.close();
        return;
      }
      clearTimeout(manualTimer);
      const valid = () =>
        !b.life.signal.aborted && manualAttempt === attempt;
      let accepting = false;
      try {
        b.manual = new ManualPairing(channel, {
          client: session.clientId,
          target: id,
          localTransport: transportFingerprint(
            session.peerConnection?.localDescription?.sdp,
          ),
          remoteTransport: transportFingerprint(
            session.peerConnection?.remoteDescription?.sdp,
          ),
          identity: this.store.identity(),
          credentials: this.store.credentials?.(id),
          outgoing,
          expiresAt,
          changed: (request) => {
            if (!valid()) return;
            b.pairing = request;
            this.revision[1]((v) => v + 1);
          },
          accepting: () => {
            if (!valid()) return;
            accepting = true;
            // Late automatic proof/failure callbacks cannot overwrite the
            // explicit decision for this connection.
            stopIdentity();
            this.publish(b, { state: "verifying" });
          },
          commit: (fingerprint) =>
            this.serialize(id, async () => {
              if (!valid())
                throw new Error(
                  "PAIRING_CONNECTION_CHANGED",
                );
              await this.store.pair(id, {
                fingerprint,
                blocked: false,
              });
              // A decision already committed remains valid after disconnect.
              // It must not activate a replacement/live connection.
              this.permissions.paired(id);
              if (!valid())
                throw new Error(
                  "PAIRING_CONNECTION_CHANGED",
                );
            }),
          paired: (fingerprint) => {
            if (!valid()) return;
            b.pairing = undefined;
            this.publish(b, {
              state: "trusted",
              fingerprint,
            });
          },
          ended: (reason, complete) => {
            if (!valid()) return;
            manualAttempt = undefined;
            b.manual = undefined;
            if (b.pairing)
              b.pairing = {
                ...b.pairing,
                state: "failed",
                reason,
              };
            if (complete && reason === "invalid") {
              void fail(b.generation);
            } else if (complete) {
              interrupted(b.generation);
            } else {
              if (accepting)
                this.publish(b, { state: "untrusted" });
              else this.revision[1]((v) => v + 1);
              // Declining an incoming request must not revoke an existing
              // trusted connection or alter saved permission choices.
              if (
                !accepting &&
                b.state.state === "verifying"
              )
                open();
            }
          },
        });
      } catch (error) {
        manualAttempt = undefined;
        channel.close();
        throw error;
      }
    };
    b.requestPairing = async () => {
      if (
        !session.isMessageChannelReady ||
        b.manual ||
        manualAttempt ||
        b.state.state === "trusted"
      )
        throw new Error("PAIRING_NOT_READY");
      const attempt = {};
      manualAttempt = attempt;
      b.pairing = {
        id: createUuid(),
        state: "outgoing",
      };
      this.revision[1]((v) => v + 1);
      const request = b.pairing.id;
      const expiresAt = Date.now() + PAIRING_TIMEOUT;
      // Covers a data channel that never opens. Listener installation below
      // precedes the creator's open event and any fast remote response.
      manualTimer = setTimeout(() => {
        if (manualAttempt !== attempt || b.manual) return;
        manualAttempt = undefined;
        b.pairing = {
          id: request,
          state: "failed",
          reason: "timeout",
        };
        this.revision[1]((v) => v + 1);
      }, PAIRING_TIMEOUT);
      try {
        await session.createChannel(
          PAIRING_CHANNEL,
          PAIRING_CHANNEL,
          (channel) =>
            bindPairing(
              channel,
              attempt,
              request,
              expiresAt,
            ),
        );
      } catch (error) {
        if (manualAttempt === attempt) {
          manualAttempt = undefined;
          clearTimeout(manualTimer);
          closeManual();
          b.pairing = {
            id: request,
            state: "failed",
            reason: "disconnected",
          };
          this.revision[1]((v) => v + 1);
        }
        throw error;
      }
    };
    b.cancelPairing = (request) => {
      if (b.manual) return b.manual.cancel(request);
      if (
        !manualAttempt ||
        b.pairing?.id !== request ||
        b.pairing.state !== "outgoing"
      )
        return false;
      manualAttempt = undefined;
      clearTimeout(manualTimer);
      b.pairing = {
        id: request,
        state: "failed",
        reason: "cancelled",
      };
      this.revision[1]((v) => v + 1);
      return true;
    };
    session.addEventListener(
      "channel",
      ({ detail }) => {
        if (
          detail.label === PAIRING_CHANNEL &&
          detail.protocol === PAIRING_CHANNEL
        ) {
          if (manualAttempt || b.manual) {
            detail.close();
            return;
          }
          const attempt = {};
          manualAttempt = attempt;
          try {
            bindPairing(detail, attempt);
          } catch {
            /* A closed/invalid transport cannot create a pairing request. */
          }
        } else if (
          detail.label === IDENTITY_CHANNEL &&
          detail.protocol === IDENTITY_CHANNEL
        )
          bind(detail);
      },
      { signal: b.life.signal },
    );
    session.addEventListener("peerconnectioninit", reset, {
      signal: b.life.signal,
    });
    session.addEventListener(
      "messagechannelchange",
      ({ detail }) => {
        if (detail === "ready") open();
        else reset();
      },
      { signal: b.life.signal },
    );
    if (session.isMessageChannelReady) open();
    return () => {
      b.life.abort();
      reset();
      if (this.bindings.get(id) === b)
        this.bindings.delete(id);
      this.revision[1]((v) => v + 1);
    };
  }
  /** Called only within the per-peer write queue, after a fresh proof. */
  private async commitPair(
    id: string,
    b: Binding,
    proof: IdentityProof,
    generation: number,
  ): Promise<void> {
    const current = () =>
      b.generation === generation &&
      !b.life.signal.aborted &&
      b.proof === proof;
    if (!current())
      throw new Error("PAIRING_CONNECTION_CHANGED");
    if (b.state.state === "trusted") return;
    await this.store.pair(id, {
      fingerprint: proof.fingerprint,
      blocked: false,
    });
    // Persist defaults for the valid pairing decision even if its transport
    // closed during the write. A queued quarantine takes precedence afterwards.
    this.permissions.paired(id);
    if (!current())
      throw new Error("PAIRING_CONNECTION_CHANGED");
    this.publish(b, { state: "trusted", ...proof });
    await b.handshake?.trust();
  }
}
