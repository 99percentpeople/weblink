import type {
  NativeControlStatus,
  PlatformRuntime,
} from "@weblink/platform";
import { createSignal } from "solid-js";
import { RemoteScreenConsent } from "./remote-screen-consent";
export interface RemoteControlPolicy {
  decision(clientId: string): "allow" | "deny" | undefined;
  remember(
    clientId: string,
    decision: "allow" | "deny",
  ): void;
}
/** One frontend owner per room. Native room/window lifetime is independent of UI polling. */
export class RemoteControlHost {
  readonly screen = new RemoteScreenConsent();
  private generation = 0;
  private owner?: string;
  private ready: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly state =
    createSignal<NativeControlStatus>({
      pending: null,
      clientId: null,
      closed: true,
    });
  readonly status = () => {
    const screen = this.screen.pending();
    return {
      ...this.state[0](),
      pending:
        screen && this.decision(screen.clientId) !== "allow"
          ? screen
          : this.state[0]().pending,
    };
  };
  private decision(clientId: string) {
    const value = this.policy?.decision(clientId);
    return value === "allow" || value === "deny"
      ? value
      : undefined;
  }
  constructor(
    private readonly platform: PlatformRuntime,
    private readonly policy?: RemoteControlPolicy,
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
      const owner = await api.open();
      if (generation !== this.generation) {
        await api.end(owner);
        return;
      }
      this.owner = owner;
      await this.poll(generation, owner);
    })().catch((error) =>
      console.warn("Remote control unavailable", error),
    );
  }
  private async poll(generation: number, owner: string) {
    try {
      const status =
        await this.platform.remoteControl!.status(owner);
      if (
        generation !== this.generation ||
        this.owner !== owner
      )
        return;
      if (status.closed) {
        this.close();
        return;
      }
      if (
        status.clientId &&
        this.decision(status.clientId) === "deny"
      ) {
        await this.platform.remoteControl!.revoke(owner);
        status.clientId = null;
      }
      const pending = status.pending;
      if (pending) {
        const decision = this.decision(pending.clientId);
        const approved =
          decision !== "deny" &&
          this.screen.consume(
            pending.clientId,
            pending.peerGeneration,
            pending.sourceId,
            false,
          );
        if (decision || approved) {
          await this.platform.remoteControl!.approve(
            owner,
            pending.consentId,
            decision !== "deny",
          );
          if (approved)
            this.screen.consume(
              pending.clientId,
              pending.peerGeneration,
              pending.sourceId,
            );
          status.pending = null;
        }
      }
      if (
        generation === this.generation &&
        this.owner === owner
      )
        this.state[1](status);
    } catch (error) {
      // A delayed/failed status read is not a local decision to revoke consent.
      if (generation === this.generation)
        console.warn(
          "Could not read remote control status",
          error,
        );
    } finally {
      if (
        generation === this.generation &&
        this.owner === owner
      )
        this.timer = setTimeout(
          () => void this.poll(generation, owner),
          500,
        );
    }
  }

  async capabilities(clientId?: string) {
    await this.ready;
    return {
      request: true,
      host:
        !!this.owner &&
        (!clientId || this.decision(clientId) !== "deny"),
    };
  }
  async context(peerGeneration: string, clientId: string) {
    await this.ready;
    return this.owner && this.decision(clientId) !== "deny"
      ? { ownerId: this.owner, peerGeneration, clientId }
      : undefined;
  }
  async approve(
    consentId: string,
    approve: boolean,
    remember = false,
  ) {
    const pending = this.status().pending;
    if (!pending || pending.consentId !== consentId) return;
    if (
      approve &&
      this.decision(pending.clientId) === "deny"
    )
      return;
    const id = this.owner;
    if (!id) return;
    if (this.screen.pending()?.consentId === consentId) {
      if (!(await this.screen.respond(consentId, approve)))
        return;
    } else
      await this.platform.remoteControl!.approve(
        id,
        consentId,
        approve,
      );
    if (
      this.owner === id &&
      this.state[0]().pending?.consentId === consentId
    )
      this.state[1]({ ...this.state[0](), pending: null });
    if (this.owner === id && remember)
      this.policy?.remember(
        pending.clientId,
        approve ? "allow" : "deny",
      );
  }
  async requestScreen(
    clientId: string,
    generation: string,
    signal: AbortSignal,
  ) {
    if (
      !(await this.capabilities(clientId)).host ||
      signal.aborted ||
      this.status().pending ||
      this.status().clientId
    )
      return;
    const result = this.screen.request(
      clientId,
      generation,
      signal,
    );
    if (this.decision(clientId) === "allow") {
      const consent = this.screen.pending();
      if (consent) {
        try {
          await this.screen.respond(
            consent.consentId,
            true,
          );
        } catch (error) {
          this.screen.cancelPeer(clientId, generation);
          throw error;
        }
      }
    }
    return result;
  }
  async policyChanged(clientId: string) {
    if (this.decision(clientId) !== "deny") return;
    const pending = this.status().pending;
    if (pending?.clientId === clientId)
      await this.approve(pending.consentId, false);
    if (this.status().clientId === clientId)
      await this.revoke();
  }
  async revoke() {
    const id = this.owner;
    if (id) await this.platform.remoteControl!.revoke(id);
  }
  close() {
    this.screen.close();
    ++this.generation;
    clearTimeout(this.timer);
    const id = this.owner;
    this.owner = undefined;
    this.state[1]({
      pending: null,
      clientId: null,
      closed: true,
    });
    if (id)
      void this.platform
        .remoteControl!.end(id)
        .catch(() => {});
  }
}
