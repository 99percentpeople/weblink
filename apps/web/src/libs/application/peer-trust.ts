import { createSignal } from "solid-js";
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
  deviceIdentityStore,
  type DeviceIdentityStore,
} from "../infrastructure/identity/device-identity-store";
export interface PeerTrust {
  state: "verifying" | "unpaired" | "untrusted" | "trusted";
  fingerprint?: string;
  code?: string;
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
    };
    this.bindings.set(id, b);
    const current = (generation: number) =>
      !b.life.signal.aborted && b.generation === generation;
    const reset = () => {
      ++b.generation;
      b.handshake?.close();
      b.handshake = undefined;
      b.proof = undefined;
      b.opening = false;
      clearTimeout(b.timer);
      this.publish(b, { state: "verifying" });
    };
    const interrupted = (generation: number) => {
      if (!current(generation)) return;
      reset();
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
      if (b.handshake || b.life.signal.aborted) {
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
              if (
                !pin?.blocked &&
                !keys?.blocked &&
                (credentialAuthenticated ||
                  (!pin?.credentialRequired &&
                    !keys?.issued &&
                    !keys?.received &&
                    pin?.fingerprint === proof.fingerprint))
              ) {
                // Either issued pairing key can prove continuity; a public pin
                // is only a migration path before these keys are exchanged.
                if (
                  pin?.fingerprint !== proof.fingerprint ||
                  (!pin.credentialRequired &&
                    credentialAuthenticated)
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
        b.opening
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
        .createChannel(IDENTITY_CHANNEL, IDENTITY_CHANNEL)
        .then((channel) => {
          if (!current(generation)) channel.close();
          else bind(channel);
        })
        .catch(() => interrupted(generation))
        .finally(() => {
          if (current(generation)) b.opening = false;
        });
    };
    session.addEventListener(
      "channel",
      ({ detail }) => {
        if (
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
  async pair(
    id: string,
    fingerprint: string,
    code: string,
  ): Promise<void> {
    const b = this.bindings.get(id),
      proof = b?.proof;
    if (
      !b ||
      !proof ||
      proof.fingerprint !== fingerprint ||
      proof.code !== code ||
      b.life.signal.aborted
    )
      throw new Error("PAIRING_NOT_READY");
    if (b.state.state === "trusted") return;
    const generation = b.generation;
    await this.serialize(id, () =>
      this.commitPair(id, b, proof, generation),
    );
  }
}
