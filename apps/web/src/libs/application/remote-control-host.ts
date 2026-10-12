import { defaultRemoteKeyboardOptions } from "../domain/remote-control/keyboard-options";
import type {
  NativeControlStatus,
  PlatformRuntime,
} from "@weblink/platform";
import { createSignal } from "solid-js";
import { RemoteScreenConsent } from "./remote-screen-consent";
import type { ControlCapability } from "../domain/protocol/capabilities";
export interface RemoteControlPolicy {
  whitelistOnly?(): boolean;
  decision(clientId: string): "allow" | "deny" | undefined;
  remember(
    clientId: string,
    decision: "allow" | "deny",
  ): void;
}
/** One frontend owner per room. Native room/window lifetime is independent of UI polling. */
export class RemoteControlHost {
  capability(clientId: string): ControlCapability {
    this.revision();
    const status = this.state[0]();
    const reservation = this.screen.reservation();
    const pending = reservation ?? this.selected[0]();
    const host =
      !!this.owner &&
      !status.closed &&
      this.exposes(clientId);
    return {
      request: true,
      host,
      occupancy:
        status.clientId && status.sourceId
          ? {
              state: "controlled",
              clientId: status.clientId,
              sourceId: status.sourceId,
            }
          : status.clientId
            ? { state: "unavailable" }
            : pending
              ? {
                  state: "pending",
                  clientId: pending.clientId,
                  sourceId: pending.sourceId || null,
                }
              : { state: host ? "idle" : "unavailable" },
    };
  }
  clipboardScope(clientId: string, grantId: string) {
    if (
      !this.owner ||
      !this.exposes(clientId) ||
      this.status().clientId !== clientId ||
      this.status().grantId !== grantId ||
      this.status().closed
    )
      throw new Error("Remote control is not authorized");
    return { ownerId: this.owner, clientId, grantId };
  }
  readonly screen = new RemoteScreenConsent();
  private generation = 0;
  private owner?: string;
  private ready: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  private statusRevision = 0;
  private decisionRetry?: ReturnType<typeof setTimeout>;
  private recoveryDelay = 1000;
  private readonly ownerRevision = createSignal(0);
  readonly revision = this.ownerRevision[0];
  private readonly state =
    createSignal<NativeControlStatus>({
      pending: [],
      clientId: null,
      closed: true,
    });
  private readonly selected = createSignal<
    NativeControlStatus["pending"][number] | null
  >(null);
  private readonly decisions = new Set<string>();
  readonly status = () => {
    const status = this.state[0]();
    return {
      ...status,
      pending:
        status.clientId || this.selected[0]()
          ? []
          : [
              ...this.screen
                .pending()
                .filter(
                  (p) =>
                    this.exposes(p.clientId) &&
                    !this.decision(p.clientId),
                ),
              ...(!this.screen.reservation()
                ? status.pending.filter(
                    (p) =>
                      this.exposes(p.clientId) &&
                      !this.decision(p.clientId),
                  )
                : []),
            ],
    };
  };
  private decision(clientId: string) {
    const value = this.policy?.decision(clientId);
    return value === "allow" || value === "deny"
      ? value
      : undefined;
  }
  /** One policy for discovery, consent and trusted native bindings. */
  exposes(clientId: string): boolean {
    const decision = this.decision(clientId);
    return (
      decision !== "deny" &&
      (!this.policy?.whitelistOnly?.() ||
        decision === "allow")
    );
  }
  constructor(
    private readonly platform: PlatformRuntime,
    private readonly policy?: RemoteControlPolicy,
    private readonly shortcut: () => string = () =>
      defaultRemoteKeyboardOptions.emergencyShortcut,
  ) {}
  start() {
    const previous = this.ready;
    this.close();
    const generation = this.generation;
    this.ready = (async () => {
      await previous;
      const api = this.platform.remoteControl;
      if (
        !api ||
        !(await this.platform.getCapabilities())
          .remoteInput ||
        generation !== this.generation
      )
        return;
      const owner = await api.open(this.shortcut());
      if (generation !== this.generation) {
        await api.end(owner);
        return;
      }
      this.owner = owner;
      this.ownerRevision[1]((value) => value + 1);
      await this.subscribe(generation, owner);
    })().catch((error) => {
      console.warn("Remote control unavailable", error);
      if (generation === this.generation) this.recover();
    });
  }
  private recover() {
    // New owner means new native bindings and fresh consent. Never replay grants.
    this.close();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation === this.generation) this.start();
    }, this.recoveryDelay);
    this.recoveryDelay = Math.min(
      this.recoveryDelay * 2,
      30000,
    );
  }
  private async subscribe(
    generation: number,
    owner: string,
  ) {
    const current = () =>
      generation === this.generation &&
      this.owner === owner;
    try {
      const unwatch =
        await this.platform.remoteControl!.watch(
          owner,
          (status) => {
            if (current())
              void this.receive(generation, owner, status);
          },
        );
      if (current()) this.unwatch = unwatch;
      else unwatch();
    } catch (error) {
      // Retrying observation must not revoke an existing native grant.
      if (!current()) return;
      console.warn(
        "Could not watch remote control status",
        error,
      );
      this.timer = setTimeout(() => {
        if (current())
          void this.subscribe(generation, owner);
      }, 1000);
    }
  }
  private async receive(
    generation: number,
    owner: string,
    snapshot: NativeControlStatus,
  ) {
    clearTimeout(this.decisionRetry);
    const revision = ++this.statusRevision;
    const current = () =>
      generation === this.generation &&
      this.owner === owner &&
      revision === this.statusRevision;
    const status = { ...snapshot };
    try {
      if (status.closed) {
        this.recover();
        return;
      }
      this.recoveryDelay = 1000;
      this.state[1](status);
      const selected = this.selected[0]();
      if (
        selected &&
        (status.clientId ||
          !status.pending.some(
            (p) => p.consentId === selected.consentId,
          ))
      )
        this.selected[1](null);
      if (status.clientId) {
        this.screen.close();
        if (!this.exposes(status.clientId))
          await this.platform.remoteControl!.revoke(owner);
        return;
      }
      for (const pending of status.pending) {
        if (!current()) return;
        if (!this.exposes(pending.clientId)) continue;
        const policy = this.decision(pending.clientId);
        const approved =
          policy !== "deny" &&
          this.screen.consume(
            pending.clientId,
            pending.peerGeneration,
            pending.sourceId,
            false,
          );
        const decision =
          this.screen.reservation() && !approved
            ? "deny"
            : policy;
        if (this.selected[0]()) return;
        if (decision || approved) {
          await this.decideNative(
            owner,
            pending,
            decision !== "deny",
          );
          if (
            approved &&
            generation === this.generation &&
            this.owner === owner
          )
            this.screen.consume(
              pending.clientId,
              pending.peerGeneration,
              pending.sourceId,
            );
          if (decision !== "deny") return;
        }
      }
    } catch (error) {
      // Retry transient command failures only while this exact snapshot is current.
      if (current()) {
        this.state[1](snapshot);
        console.warn(
          "Could not apply remote control status",
          error,
        );
        this.decisionRetry = setTimeout(() => {
          if (current())
            void this.receive(generation, owner, snapshot);
        }, 1000);
      }
    }
  }

  async capabilities(clientId?: string) {
    await this.ready;
    return {
      request: true,
      host:
        !!this.owner &&
        (!clientId || this.exposes(clientId)),
    };
  }
  async context(peerGeneration: string, clientId: string) {
    await this.ready;
    return this.owner && this.exposes(clientId)
      ? { ownerId: this.owner, peerGeneration, clientId }
      : undefined;
  }
  async approve(
    consentId: string,
    approve: boolean,
    remember = false,
  ) {
    const screen = this.screen
      .pending()
      .find((p) => p.consentId === consentId);
    const pending =
      screen ??
      this.state[0]().pending.find(
        (p) => p.consentId === consentId,
      );
    if (!pending || !this.exposes(pending.clientId)) return;
    const id = this.owner;
    if (!id) return;
    if (
      approve &&
      (this.selected[0]() ||
        this.screen.reservation() ||
        this.state[0]().clientId)
    )
      return;
    if (screen) {
      const response = this.screen.respond(
        consentId,
        approve,
      );
      // respond reserves synchronously. Reject native candidates while capture starts.
      const [accepted] = await Promise.all([
        response,
        approve ? this.rejectNative(id) : Promise.resolve(),
      ]);
      if (!accepted) return;
    } else if (
      !(await this.decideNative(id, pending, approve))
    )
      return;
    if (this.owner === id && remember)
      this.policy?.remember(
        pending.clientId,
        approve ? "allow" : "deny",
      );
  }
  private async rejectNative(owner: string) {
    for (const pending of this.state[0]().pending) {
      if (this.owner !== owner) return;
      await this.decideNative(owner, pending, false);
    }
  }
  private async decideNative(
    owner: string,
    pending: NativeControlStatus["pending"][number],
    approve: boolean,
  ) {
    const key = `${owner}:${pending.consentId}`;
    if (
      !this.exposes(pending.clientId) ||
      this.decisions.has(key) ||
      (approve &&
        (this.selected[0]() || this.state[0]().clientId))
    )
      return false;
    this.decisions.add(key);
    if (approve) {
      this.selected[1](pending);
      // A native selection also rejects every avatar request.
      // Keep an approved avatar reservation until its native grant is acknowledged.
      if (!this.screen.reservation()) this.screen.close();
    }
    try {
      await this.platform.remoteControl!.approve(
        owner,
        pending.consentId,
        approve,
      );
      return true;
    } catch (error) {
      if (this.selected[0]() === pending)
        this.selected[1](null);
      // Cancellation or another native status may already have removed this consent.
      if (
        this.owner !== owner ||
        !this.state[0]().pending.some(
          (p) => p.consentId === pending.consentId,
        )
      )
        return false;
      throw error;
    } finally {
      this.decisions.delete(key);
    }
  }
  async requestScreen(
    clientId: string,
    generation: string,
    signal: AbortSignal,
  ) {
    if (
      !(await this.capabilities(clientId)).host ||
      !this.exposes(clientId) ||
      signal.aborted ||
      this.screen.reservation() ||
      this.selected[0]() ||
      this.state[0]().clientId
    )
      return;
    const result = this.screen.request(
      clientId,
      generation,
      signal,
    );
    if (this.decision(clientId) === "allow") {
      const consent = this.screen
        .pending()
        .find((p) => p.clientId === clientId);
      if (consent) {
        try {
          await this.approve(consent.consentId, true);
        } catch (error) {
          this.screen.cancelPeer(clientId, generation);
          throw error;
        }
      }
    }
    return result;
  }
  async policyChanged(clientId: string) {
    if (!this.exposes(clientId)) {
      this.screen.cancelClient(clientId);
      if (this.status().clientId === clientId)
        await this.revoke();
      // Native bindings are withdrawn by refreshControlCapabilities. Do not
      // send a denial that discloses control support to a hidden client.
      return;
    }
    const decision = this.decision(clientId);
    if (decision === "allow") {
      const screen = this.screen
        .pending()
        .find((p) => p.clientId === clientId);
      if (screen)
        await this.approve(screen.consentId, true);
      const status = this.state[0]();
      if (
        this.owner &&
        status.pending.some((p) => p.clientId === clientId)
      )
        await this.receive(
          this.generation,
          this.owner,
          status,
        );
      return;
    }
  }
  async revoke() {
    const id = this.owner;
    if (id) await this.platform.remoteControl!.revoke(id);
  }
  close() {
    this.screen.close();
    this.selected[1](null);
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.decisionRetry);
    this.unwatch?.();
    this.unwatch = undefined;
    const id = this.owner;
    this.owner = undefined;
    if (id) this.ownerRevision[1]((value) => value + 1);
    this.state[1]({
      pending: [],
      clientId: null,
      closed: true,
    });
    if (id)
      void this.platform
        .remoteControl!.end(id)
        .catch(() => {});
  }
}
