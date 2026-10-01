import { createSignal } from "solid-js";
import type {
  NativeControlStatus,
  PlatformRuntime,
} from "@weblink/platform";
/** One frontend owner per room. Status polling is also a separate native owner lease. */
export class RemoteControlHost {
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
  readonly status = this.state[0];
  constructor(private readonly platform: PlatformRuntime) {}
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
      this.state[1](status);
      if (status.closed) {
        this.close();
        return;
      }
      this.timer = setTimeout(
        () => void this.poll(generation, owner),
        500,
      );
    } catch {
      if (generation === this.generation) this.close();
    }
  }
  async capabilities() {
    await this.ready;
    return { request: true, host: !!this.owner };
  }
  async context(peerGeneration: string, clientId: string) {
    await this.ready;
    return this.owner
      ? { ownerId: this.owner, peerGeneration, clientId }
      : undefined;
  }
  async approve(consentId: string, approve: boolean) {
    const id = this.owner;
    if (id)
      await this.platform.remoteControl!.approve(
        id,
        consentId,
        approve,
      );
  }
  async revoke() {
    const id = this.owner;
    if (id) await this.platform.remoteControl!.revoke(id);
  }
  close() {
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
