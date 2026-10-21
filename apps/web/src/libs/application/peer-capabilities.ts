import { createSignal } from "solid-js";
import { createUuid } from "../domain/ids";
import { createSessionMessage } from "../domain/protocol/messages";
import {
  changedCapabilities,
  validCapabilityUpdate,
  type CapabilityAnnouncement,
  type PeerCapabilities,
} from "../domain/protocol/capabilities";
import { CapabilityState } from "../domain/protocol/capability-state";
import {
  advertiseCapabilities,
  CAPABILITY_SYNC_VERSION,
  ProtocolNegotiation,
} from "../domain/protocol/protocol-versions";
import { P2PProtocolError } from "../domain/protocol/errors";
import type { PeerSession } from "../domain/session";

type Binding = {
  waiters: Set<(services?: PeerCapabilities) => void>;
  lifetime: AbortController;
  transport: AbortController;
  retry?: ReturnType<typeof setTimeout>;
  resyncRetry?: ReturnType<typeof setTimeout>;
  generation: string;
  revision: number;
  remote: CapabilityState;
  negotiation: ProtocolNegotiation;
  protocols: ReadonlyMap<string, string>;
  negotiated?: PeerCapabilities;
  incompatibleSync: boolean;
  forceSnapshot: boolean;
  previous?: string;
  sendingSnapshot?: string;
  sending: boolean;
  dirty: boolean;
  changed(services: PeerCapabilities | undefined): void;
};

/** Initial snapshots and incremental service updates. Discovery never grants authority. */
export class PeerCapabilitiesService {
  private readonly bindings = new Map<
    PeerSession,
    Binding
  >();
  private readonly change = createSignal(0);
  constructor(
    private readonly local: (
      session: PeerSession,
    ) => PeerCapabilities,
  ) {}

  get(session: PeerSession): PeerCapabilities | undefined {
    this.change[0]();
    return this.bindings.get(session)?.negotiated;
  }
  /** Shared connection generation; replaced whenever the main transport resets. */
  generation(session: PeerSession): string | undefined {
    this.change[0]();
    return this.bindings.get(session)?.generation;
  }
  /** Exact selected handler ID; undefined also covers invalid or withdrawn offers. */
  protocol(
    session: PeerSession,
    service: string,
  ): string | undefined {
    this.change[0]();
    return this.bindings
      .get(session)
      ?.protocols.get(service);
  }
  async require(
    session: PeerSession,
    features: readonly string[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (!features.length) return;
    const services = await this.whenReady(session, signal);
    for (const feature of features) {
      if (!Object.hasOwn(services, feature))
        throw new P2PProtocolError(
          "unsupported-protocol",
          `No common protocol for ${feature}`,
        );
    }
  }
  async whenReady(
    session: PeerSession,
    signal?: AbortSignal,
  ): Promise<PeerCapabilities> {
    signal?.throwIfAborted();
    const binding = this.bindings.get(session);
    if (!binding) throw new Error("Peer is not connected");
    if (binding.negotiated) return binding.negotiated;
    return new Promise((resolve, reject) => {
      const done = (services?: PeerCapabilities) => {
        clearTimeout(timer);
        binding.waiters.delete(done);
        signal?.removeEventListener("abort", abort);
        if (services) resolve(services);
        else
          reject(
            signal?.reason ??
              new Error(
                "Peer capability exchange interrupted",
              ),
          );
      };
      const abort = () => done();
      const timer = setTimeout(abort, 10000);
      binding.waiters.add(done);
      signal?.addEventListener("abort", abort, {
        once: true,
      });
    });
  }
  bind(
    session: PeerSession,
    changed: Binding["changed"],
  ): () => void {
    const binding: Binding = {
      lifetime: new AbortController(),
      transport: new AbortController(),
      generation: createUuid(),
      revision: 0,
      remote: new CapabilityState(),
      negotiation: new ProtocolNegotiation(),
      protocols: new Map(),
      incompatibleSync: false,
      forceSnapshot: true,
      sending: false,
      dirty: false,
      changed,
      waiters: new Set(),
    };
    this.bindings.set(session, binding);
    const reset = () => {
      binding.generation = createUuid();
      clearTimeout(binding.retry);
      binding.retry = undefined;
      clearTimeout(binding.resyncRetry);
      binding.resyncRetry = undefined;
      binding.transport.abort();
      binding.transport = new AbortController();
      binding.remote = new CapabilityState();
      binding.negotiation = new ProtocolNegotiation();
      binding.protocols = new Map();
      binding.negotiated = undefined;
      binding.incompatibleSync = false;
      binding.forceSnapshot = true;
      binding.sendingSnapshot = undefined;
      for (const waiter of binding.waiters) waiter();
      binding.previous = undefined;
      this.change[1]((n) => n + 1);
      changed(undefined);
    };
    const signal = binding.lifetime.signal;
    session.addEventListener(
      "message",
      ({ detail: message }) => {
        if (
          message.type !== "peer-capabilities" ||
          message.client !== session.targetClientId ||
          message.target !== session.clientId
        )
          return;
        if (binding.incompatibleSync) return;
        if (message.version !== CAPABILITY_SYNC_VERSION) {
          binding.incompatibleSync = true;
          clearTimeout(binding.resyncRetry);
          binding.resyncRetry = undefined;
          this.publish(session, binding);
          return;
        }
        const update = message.update;
        if (!validCapabilityUpdate(update)) return;
        if (update.kind === "request-snapshot") {
          this.refresh(session, true);
          return;
        }
        const result = binding.remote.apply(update);
        if (result === "ignored") return;
        if (result === "resync")
          this.requestSnapshot(session, binding);
        else {
          clearTimeout(binding.resyncRetry);
          binding.resyncRetry = undefined;
        }
        this.publish(session, binding);
      },
      { signal },
    );
    session.addEventListener("peerconnectioninit", reset, {
      signal,
    });
    session.addEventListener(
      "messagechannelchange",
      ({ detail }) => {
        if (detail === "ready") this.refresh(session, true);
        else reset();
      },
      { signal },
    );
    if (session.isMessageChannelReady)
      this.refresh(session, true);
    return () => {
      binding.lifetime.abort();
      if (this.bindings.get(session) === binding)
        this.bindings.delete(session);
      reset();
    };
  }
  refreshAll(): void {
    for (const session of this.bindings.keys())
      this.refresh(session);
  }
  private publish(
    session: PeerSession,
    binding: Binding,
    local = advertiseCapabilities(this.local(session)),
  ): void {
    const services = binding.incompatibleSync
      ? {}
      : binding.remote.value &&
        binding.negotiation.project(
          local,
          binding.remote.value,
        );
    if (
      JSON.stringify(services) ===
      JSON.stringify(binding.negotiated)
    )
      return;
    binding.negotiated = services;
    const selected = binding.negotiation.select(
      Object.keys(local),
      Object.keys(binding.remote.value ?? {}),
    );
    binding.protocols = new Map(
      Object.keys(services ?? {}).map((service) => [
        service,
        selected.get(service)!,
      ]),
    );
    if (services)
      for (const waiter of binding.waiters)
        waiter(services);
    this.change[1]((n) => n + 1);
    binding.changed(services);
  }
  private requestSnapshot(
    session: PeerSession,
    binding: Binding,
  ): void {
    if (binding.resyncRetry) return;
    const transport = binding.transport;
    binding.resyncRetry = setTimeout(() => {
      binding.resyncRetry = undefined;
      if (
        !transport.signal.aborted &&
        !binding.remote.value
      )
        this.requestSnapshot(session, binding);
    }, 1000);
    void session
      .sendMessage(
        createSessionMessage(session, "peer-capabilities", {
          update: { kind: "request-snapshot" },
        }),
        { signal: transport.signal },
      )
      .catch(() => {
        // Retry only while discovery remains unavailable on this transport.
      });
  }
  refresh(session: PeerSession, force = false): void {
    const binding = this.bindings.get(session);
    if (!binding) return;
    // Read the provider synchronously so Solid tracks state/settings dependencies.
    const services = advertiseCapabilities(
      this.local(session),
    );
    this.publish(session, binding, services);
    const serialized = JSON.stringify(services);
    if (force) binding.forceSnapshot = true;
    if (binding.sending) {
      binding.dirty =
        binding.forceSnapshot ||
        binding.sendingSnapshot !== serialized;
      return;
    }
    if (
      !binding.forceSnapshot &&
      binding.previous === serialized
    ) {
      binding.dirty = false;
      return;
    }
    binding.dirty = true;
    if (!session.isMessageChannelReady) return;
    const next = JSON.parse(serialized) as PeerCapabilities;
    const full =
      binding.forceSnapshot ||
      binding.previous === undefined;
    const changes = full
      ? next
      : changedCapabilities(
          JSON.parse(binding.previous!) as PeerCapabilities,
          next,
        );
    if (!full && !Object.keys(changes).length) {
      binding.previous = serialized;
      binding.dirty = false;
      return;
    }
    const metadata = {
      generation: binding.generation,
      revision: ++binding.revision,
    };
    let update: CapabilityAnnouncement = full
      ? { ...metadata, kind: "snapshot", services: next }
      : { ...metadata, kind: "patch", services: changes };
    // A replacement can carry more withdrawal keys than a bounded full state.
    if (
      update.kind === "patch" &&
      !validCapabilityUpdate(update)
    )
      update = {
        ...metadata,
        kind: "snapshot",
        services: next,
      };
    binding.sending = true;
    binding.sendingSnapshot = serialized;
    binding.dirty = false;
    binding.forceSnapshot = false;
    const transport = binding.transport;
    void session
      .sendMessage(
        createSessionMessage(session, "peer-capabilities", {
          update,
        }),
        {
          signal: transport.signal,
        },
      )
      .then(
        () => {
          if (!transport.signal.aborted)
            binding.previous = serialized;
        },
        (error) => {
          binding.dirty = true;
          binding.forceSnapshot = true;
          if (
            !binding.lifetime.signal.aborted &&
            !transport.signal.aborted
          ) {
            console.warn(
              "Capability snapshot failed",
              error,
            );
            binding.retry = setTimeout(() => {
              binding.retry = undefined;
              if (!binding.lifetime.signal.aborted)
                this.refresh(session, true);
            }, 1000);
          }
        },
      )
      .finally(() => {
        binding.sending = false;
        binding.sendingSnapshot = undefined;
        if (
          binding.dirty &&
          !binding.lifetime.signal.aborted &&
          !binding.retry
        )
          this.refresh(session);
      });
  }
}
